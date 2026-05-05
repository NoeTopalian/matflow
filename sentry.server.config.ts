// Sentry server-side init (Node runtime). Activates only when SENTRY_DSN is
// set so installs without a Sentry account stay silent.
import * as Sentry from "@sentry/nextjs";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
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
