/**
 * Next.js boot-time instrumentation. Runs once per Node/edge runtime
 * before the first request handler. Wires:
 *  - Sentry init (server / edge config; sentry.client.config.ts loads
 *    automatically on the client side)
 *  - Production env-var guards (lib/env-guards.ts) — fail loud at
 *    server start if a required prod secret is missing
 *  - `onRequestError`: the catch-all diagnostic log for every *unhandled*
 *    failure, in any of the app's route handlers and server renders
 */
import type { Instrumentation } from "next";
import * as Sentry from "@sentry/nextjs";
import { runProductionEnvGuards } from "@/lib/env-guards";
import { errorReferenceFromDigest, newErrorReference } from "@/lib/error-reference";
import { readErrorContext } from "@/lib/error-context";

export async function register() {
  runProductionEnvGuards();

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/**
 * Anything that throws out of a route handler or a server render lands here.
 * `lib/api-error.ts` covers the failures routes catch themselves; this covers
 * the ones they don't — across all 167 route files, with no per-route edits.
 *
 * The reference is derived from Next's `digest` rather than minted fresh,
 * because the digest is the ONE value Next also ships to the browser: the
 * `error.tsx` boundary hashes it with the same function and shows the member
 * the identical reference. See `errorReferenceFromDigest`.
 */
export const onRequestError: Instrumentation.onRequestError = (err, request, context) => {
  try {
    const digest =
      err && typeof err === "object" && typeof (err as { digest?: unknown }).digest === "string"
        ? (err as { digest: string }).digest
        : null;
    const reference = digest ? errorReferenceFromDigest(digest) : newErrorReference();
    const stamped = readErrorContext(err);
    const isError = err instanceof Error;

    const record = {
      reference,
      route: context.routePath,
      routeType: context.routeType,
      method: request.method,
      path: request.path,
      tenantId: stamped.tenantId ?? null,
      userId: stamped.userId ?? null,
      at: new Date().toISOString(),
      digest,
      error: {
        name: isError ? err.name : typeof err,
        message: isError ? err.message : null,
        stack: isError ? err.stack ?? null : null,
      },
    };
    console.error(`[unhandled-error] ${reference}`, JSON.stringify(record), err);

    if (process.env.SENTRY_DSN) {
      Sentry.withScope((scope) => {
        scope.setTag("error_reference", reference);
        if (record.tenantId) scope.setTag("tenant_id", record.tenantId);
        scope.setTag("route", context.routePath);
        if (record.userId) scope.setUser({ id: record.userId });
        scope.setContext("matflow", {
          reference,
          route: context.routePath,
          routeType: context.routeType,
          method: request.method,
          path: request.path,
          tenantId: record.tenantId,
        });
        Sentry.captureException(err);
      });
    }
  } catch {
    // Diagnostics must never amplify an outage. Next already logs the error
    // itself; losing the reference is strictly better than throwing here.
  }
};
