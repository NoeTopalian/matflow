// Loads the Sentry browser SDK.
//
// WHY THIS FILE IS THE WHOLE FIX
// ------------------------------
// `sentry.client.config.ts` has existed, complete and correct, for a long time
// — and has never once run. Nothing imported it: there was no
// `instrumentation-client.ts` and no `withSentryConfig` in `next.config.ts`, so
// the browser SDK was never initialised. Every `Sentry.captureException` in the
// route-segment error boundaries was therefore dead code calling into an
// uninitialised client, and no client-side error in this product has ever
// reached a human.
//
// Next loads a root `instrumentation-client.ts` before the app becomes
// interactive and expects no particular export, so importing the existing
// config for its side effects is all that is required. Deliberately NOT done
// via `withSentryConfig`: that wrapper exists mainly for source-map upload and
// tunnelling, and changing the build wrapper days before a customer meeting is
// a production risk out of all proportion to the benefit. Source maps can be
// added later without touching this file.
//
// Still a no-op until `NEXT_PUBLIC_SENTRY_DSN` is set — the config guards on
// it, so contributors and local dev need configure nothing. Setting that
// variable in Vercel is the step that turns this on, and it is Noe's to do.
import "./sentry.client.config";
