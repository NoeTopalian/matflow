// Sentry edge-runtime init (proxy.ts middleware). Activates only when
// SENTRY_DSN is set.
import * as Sentry from "@sentry/nextjs";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    // Audit iter-1-infra A7I1-S-3: PII scrubber missing on edge config.
    // Edge middleware sees admin/operator cookies (the matflow_admin cookie
    // value IS the shared MATFLOW_ADMIN_SECRET). A thrown error in edge
    // runtime would otherwise ship the raw cookie + Sentry team / Sentry
    // breach yields super-admin access. Matches server/client configs.
    beforeSend(event) {
      if (event.request?.headers) delete event.request.headers["cookie"];
      if (event.user) {
        delete event.user.email;
        delete event.user.username;
      }
      return event;
    },
  });
}
