// Starts the Sentry browser SDK — off the critical path, and only when this
// build has a DSN.
//
// History: `sentry.client.config.ts` existed, complete and correct, for a long
// time and never ran, because nothing imported it; this file is what made
// client-side error capture real. It used to import the config statically,
// which put the whole SDK (and zod, below) into the JavaScript every page
// downloads and parses before it is interactive (speed quick win 2d, 6 Nov
// 2026). It now hands the load to lib/sentry-client.ts:
//  - NEXT_PUBLIC_SENTRY_DSN unset at build: nothing is loaded at all;
//  - set: the SDK loads and initialises straight after start-up, in its own
//    chunk, and error boundaries wait for that same load before reporting.
// Setting that variable in Vercel is the step that turns capture on, and it is
// Noe's to do. Deliberately still not `withSentryConfig` (source maps and
// tunnelling can come later without touching this file).
//
// zod's `jitless` setting moved to lib/zod-client.ts, imported only by the
// client pages that build schemas (/login, /apply).
import { loadClientSentry } from "@/lib/sentry-client";

void loadClientSentry();
