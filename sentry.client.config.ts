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
    // Session Replay is OFF. `replaysSessionSampleRate: 0` is the statement of
    // that; there is deliberately no `replaysOnErrorSampleRate` beside it.
    // That key used to sit here at 0.1 and did nothing at all — replay only
    // records when `Sentry.replayIntegration()` is registered, and no config in
    // this repo registers it. Left in place it read as "we capture a replay of
    // one error in ten", which is the opposite of true and exactly the kind of
    // claim someone reaches for during an incident.
    replaysSessionSampleRate: 0,
    beforeSend: scrubSentryEvent,
  });
}
