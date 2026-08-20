import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { newErrorReference } from "@/lib/error-reference";
import { readErrorContext } from "@/lib/error-context";

/**
 * Returns a JSON error response with a generic, client-safe message and logs
 * the underlying error server-side. Use this in route handlers instead of
 * surfacing `error.message` to clients (which can leak Prisma SQL fragments,
 * Stripe SDK internals, OAuth token-exchange details, etc.).
 *
 * ## The reference
 *
 * When there is something to diagnose (any 5xx, or any status raised from a
 * caught error) a short reference is minted — `MF-4K7P3R`, see
 * `lib/error-reference.ts`. It goes two places and only two places:
 *
 *   1. into the server log line, beside the full error, its stack, the route
 *      tag, HTTP method and path, the tenant, the user and a timestamp;
 *   2. into the JSON body as `reference`, so the member can read it out.
 *
 * The body still carries NOTHING internal. That asymmetry is the whole point:
 * the owner searches the log for `MF-4K7P3R` and gets the stack; the member
 * only ever holds an opaque label.
 *
 * ## Getting tenant/user onto the log line
 *
 * Pass the auth context as the fifth argument when you have it — the object
 * returned by `requireStaff()` / `requireSession()` already has the right
 * shape, so it is a one-word change at the call site:
 *
 *   const ctx = await requireStaff();
 *   try { ... } catch (e) { return apiError("Failed to refund", 500, e, "[refund]", ctx); }
 *
 * When it is not passed, the tenant is still recovered for any failure that
 * escaped a tenant-scoped transaction: `lib/prisma-tenant.ts` stamps it onto
 * the error itself (`lib/error-context.ts`). Whatever cannot be determined is
 * logged as `null` rather than guessed.
 *
 * ## Sentry
 *
 * 5xx errors are forwarded to `captureException` when SENTRY_DSN is set,
 * tagged with the reference and the tenant so an owner-reported reference can
 * be pasted straight into Sentry search. Tags are applied inside
 * `Sentry.withScope` — never `Sentry.setTag` — because this app does not use
 * `withSentryConfig`, so the isolation scope is shared and a global tag would
 * bleed one tenant's id onto another tenant's events.
 *
 * PII is stripped at the init layer (sentry.*.config.ts remove cookies and
 * user.email/username via beforeSend), so we don't re-scrub. Only the user
 * *id* is attached here, which those scrubbers deliberately keep.
 */

export type ApiErrorContext = {
  tenantId?: string | null;
  userId?: string | null;
  /** HTTP method, when not derivable from `req`. */
  method?: string | null;
  /** Request path, when not derivable from `req`. */
  path?: string | null;
  /** The handler's Request — method and path are read off it. */
  req?: { method?: string; url?: string } | null;
  /** Pre-minted reference, when the caller already logged one. */
  reference?: string;
};

function pathOf(req: ApiErrorContext["req"], fallback?: string | null): string | null {
  if (typeof fallback === "string") return fallback;
  if (!req?.url) return null;
  try {
    return new URL(req.url).pathname;
  } catch {
    return null;
  }
}

function describeError(e: unknown): { name: string | null; message: string | null; stack: string | null } {
  if (e === undefined) return { name: null, message: null, stack: null };
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack ?? null };
  }
  return { name: typeof e, message: typeof e === "string" ? e : null, stack: null };
}

export function apiError(
  message: string,
  status: number,
  e?: unknown,
  tag?: string,
  ctx?: ApiErrorContext,
) {
  // A reference is only worth handing out when something was actually logged
  // for the owner to find. A plain 400 "Invalid input" with no underlying
  // error would send them hunting for a log line that does not exist.
  const diagnosable = status >= 500 || e !== undefined;
  const reference = diagnosable ? ctx?.reference ?? newErrorReference() : undefined;

  // A reference the client can quote is only honest if a matching log line
  // exists, so minting and logging are the same decision.
  if (reference) {
    const stamped = readErrorContext(e);
    const record = {
      reference,
      status,
      route: tag ?? null,
      method: ctx?.method ?? ctx?.req?.method ?? null,
      path: pathOf(ctx?.req, ctx?.path),
      tenantId: ctx?.tenantId ?? stamped.tenantId ?? null,
      userId: ctx?.userId ?? stamped.userId ?? null,
      at: new Date().toISOString(),
      error: describeError(e),
    };
    // One greppable line (search the log for the reference), then the error
    // object itself so the runtime still prints a formatted stack.
    if (e !== undefined) console.error(`[api-error] ${reference}`, JSON.stringify(record), e);
    else console.error(`[api-error] ${reference}`, JSON.stringify(record));

    // 4xx is usually validation/expected — only forward 5xx to Sentry.
    if (e !== undefined && status >= 500 && process.env.SENTRY_DSN) {
      try {
        Sentry.withScope((scope) => {
          scope.setTag("error_reference", reference);
          if (record.tenantId) scope.setTag("tenant_id", record.tenantId);
          if (tag) scope.setTag("route", tag);
          if (record.userId) scope.setUser({ id: record.userId });
          scope.setContext("matflow", {
            reference,
            status,
            route: tag ?? null,
            method: record.method,
            path: record.path,
            tenantId: record.tenantId,
            clientMessage: message,
          });
          Sentry.captureException(e);
        });
      } catch {
        // Sentry SDK errors must never break the response path.
      }
    }
  }

  return NextResponse.json(
    reference ? { ok: false, error: message, reference } : { ok: false, error: message },
    { status },
  );
}
