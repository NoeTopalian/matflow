// Sentry client-side init. No-op when SENTRY_DSN is unset, so local dev
// and contributors without an account aren't required to configure anything.
//
// The error reference shown to the user is attached to the event by the route
// segment boundaries (app/dashboard/error.tsx, app/member/error.tsx) via
// Sentry.withScope, so a reference read out over the phone can be pasted
// straight into Sentry search. PII scrubbing (member emails / names out of
// breadcrumbs and event payloads) is shared with the server and edge configs
// via lib/sentry-scrub.ts.
import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "@/lib/sentry-scrub";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0.1,
    beforeSend: scrubSentryEvent,
  });
}
