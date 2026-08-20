// Sentry edge-runtime init (proxy.ts middleware). Activates only when
// SENTRY_DSN is set.
//
// Audit iter-1-infra A7I1-S-3: the PII scrubber was once missing on this
// config alone. Edge middleware sees admin/operator cookies (the
// matflow_admin cookie value IS the shared MATFLOW_ADMIN_SECRET), so a thrown
// error in edge runtime would otherwise ship the raw cookie to Sentry and a
// Sentry breach would yield super-admin access. The scrubber now lives in
// lib/sentry-scrub.ts and is imported by all three configs, so it cannot go
// missing from one of them again.
import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "@/lib/sentry-scrub";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    beforeSend: scrubSentryEvent,
  });
}
