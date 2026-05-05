import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

/**
 * Returns a JSON error response with a generic, client-safe message and logs
 * the underlying error server-side. Use this in route handlers instead of
 * surfacing `error.message` to clients (which can leak Prisma SQL fragments,
 * Stripe SDK internals, OAuth token-exchange details, etc.).
 *
 * Sentry: 5xx errors are forwarded to `captureException` when SENTRY_DSN is
 * set. PII is stripped at the init layer (sentry.server.config.ts removes
 * cookies and user.email/username via beforeSend), so we don't re-scrub.
 *
 * Example:
 *   try { ... } catch (e) { return apiError("Failed to refund", 500, e, "[refund]"); }
 */
export function apiError(
  message: string,
  status: number,
  e?: unknown,
  tag?: string,
) {
  if (e !== undefined) {
    if (tag) console.error(tag, e);
    else console.error(e);
    // 4xx is usually validation/expected — only forward 5xx to Sentry.
    if (status >= 500 && process.env.SENTRY_DSN) {
      try {
        Sentry.captureException(e, {
          tags: tag ? { route: tag } : undefined,
          extra: { clientMessage: message, status },
        });
      } catch {
        // Sentry SDK errors must never break the response path.
      }
    }
  }
  return NextResponse.json({ ok: false, error: message }, { status });
}
