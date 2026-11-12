// Browser error reporting, loaded on demand (speed quick win 2d, 6 Nov 2026).
//
// The Sentry browser SDK used to be imported statically by
// instrumentation-client.ts and by every error boundary, which put it in the
// JavaScript every page downloads and parses before it is interactive — even
// with NEXT_PUBLIC_SENTRY_DSN unset, when it does nothing at all.
//
// Now: with no DSN at build time the condition below is a constant and the
// SDK is not loaded anywhere. With a DSN, instrumentation-client.ts starts the
// load straight after start-up (off the critical path) and an error boundary
// that catches something waits for the same load before it reports, so a
// capture never reaches an uninitialised client.
type SentryModule = typeof import("@sentry/nextjs");

let loading: Promise<SentryModule | null> | null = null;

/** The initialised SDK, or null when this build has no DSN. One load per page. */
export function loadClientSentry(): Promise<SentryModule | null> {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return Promise.resolve(null);
  loading ??= import("@/sentry.client.config")
    .then(() => import("@sentry/nextjs"))
    .catch(() => {
      loading = null; // a failed chunk load may succeed on the next error
      return null;
    });
  return loading;
}

/** At most this many errors are held while the SDK loads; a crash loop must not grow memory. */
export const EARLY_ERROR_LIMIT = 20;

/**
 * Start the SDK load and hold any uncaught error or unhandled rejection that
 * happens before it is initialised, then hand them to Sentry once it is. After
 * that, Sentry's own global handlers take over and these listeners are gone.
 * Without a DSN it adds no listeners and loads nothing.
 */
export function startClientSentry(): void {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN || typeof window === "undefined") return;
  const early: unknown[] = [];
  const hold = (err: unknown) => {
    if (early.length < EARLY_ERROR_LIMIT) early.push(err);
  };
  const onError = (e: ErrorEvent) => hold(e.error ?? new Error(e.message));
  const onRejection = (e: PromiseRejectionEvent) => hold(e.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  void loadClientSentry().then((Sentry) => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    if (!Sentry) return;
    for (const err of early.splice(0)) Sentry.captureException(err);
  });
}

/**
 * Report an error caught by a boundary. `reference` is the code the person sees
 * (lib/error-reference.ts), set as the `error_reference` tag so it can be
 * searched in Sentry. Never throws: reporting must not break the error page.
 */
export function reportClientError(
  error: unknown,
  { reference, level }: { reference: string | null; level?: "fatal" },
): void {
  void loadClientSentry()
    .then((Sentry) => {
      if (!Sentry) return;
      Sentry.withScope((scope) => {
        if (level) scope.setLevel(level);
        if (reference) scope.setTag("error_reference", reference);
        Sentry.captureException(error);
      });
    })
    .catch(() => {});
}
