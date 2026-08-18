// Sentry server-side init (Node runtime). Activates only when SENTRY_DSN is
// set so installs without a Sentry account stay silent.
//
// Tenant id and the error reference are attached per event, not here — see
// lib/api-error.ts and instrumentation.ts, which tag inside Sentry.withScope
// so a tenant id can never bleed onto another tenant's event. PII scrubbing
// is shared with the client and edge configs via lib/sentry-scrub.ts.
import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "@/lib/sentry-scrub";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    beforeSend: scrubSentryEvent,
  });
}
