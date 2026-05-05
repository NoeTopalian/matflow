// Sentry client-side init. No-op when SENTRY_DSN is unset, so local dev
// and contributors without an account aren't required to configure anything.
import * as Sentry from "@sentry/nextjs";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0.1,
    // Strip member emails / names from breadcrumbs and event payloads.
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
