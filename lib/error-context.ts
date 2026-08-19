/**
 * Diagnostic context carried BY the error object itself.
 *
 * The problem this solves: `apiError()` is called from a `catch` block that
 * usually has the session to hand, but 167 route handlers do not pass it, and
 * there is no request-scoped store to read it from (this app does not run
 * `withSentryConfig`, so Sentry's isolation scope is NOT forked per request —
 * reading tenant state off it would attribute failures to whichever request
 * happened to write last).
 *
 * So the tenant travels on the error. `lib/prisma-tenant.ts` stamps every
 * failure that escapes a tenant-scoped transaction, which covers the majority
 * of real production faults for free; a route may also stamp explicitly.
 *
 * The property is non-enumerable, so it never appears in `JSON.stringify` of
 * the error and can never be serialised to a client by accident.
 *
 * Dependency-free on purpose: imported by `lib/prisma-tenant.ts`, which the
 * auth flow pulls into the edge runtime.
 */

const CONTEXT_KEY = "__matflowErrorContext";

export type ErrorDiagnosticContext = {
  tenantId?: string;
  userId?: string;
};

/**
 * Stamp diagnostic context onto an error and return it unchanged otherwise.
 * The innermost (first) stamp wins — the frame closest to the failure knows
 * the most specific tenant.
 */
export function attachErrorContext<E>(error: E, context: ErrorDiagnosticContext): E {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return error;
  }
  const existing = readErrorContext(error);
  try {
    Object.defineProperty(error, CONTEXT_KEY, {
      value: { ...context, ...existing },
      enumerable: false,
      writable: true,
      configurable: true,
    });
  } catch {
    // Frozen or sealed error object — context is best-effort and must never
    // turn a handled failure into an unhandled one.
  }
  return error;
}

/** Read back whatever context was stamped on an error. Never throws. */
export function readErrorContext(error: unknown): ErrorDiagnosticContext {
  if (error === null || typeof error !== "object") return {};
  const value = (error as Record<string, unknown>)[CONTEXT_KEY];
  if (!value || typeof value !== "object") return {};
  const { tenantId, userId } = value as ErrorDiagnosticContext;
  return {
    ...(typeof tenantId === "string" ? { tenantId } : {}),
    ...(typeof userId === "string" ? { userId } : {}),
  };
}
