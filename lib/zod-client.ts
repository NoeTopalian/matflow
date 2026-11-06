// zod for client components. Import `z` from here, never from "zod", in any
// client component that builds a schema (today /login and /apply).
//
// zod v4 probes `Function("")` the first time an object schema is built, to
// decide whether it may JIT-compile parsers. Under any CSP without
// 'unsafe-eval' — the static next.config.ts policy today, and the nonce policy
// from lib/csp.ts — that probe raises a script-src violation on every page
// that builds a schema (lane C2 browser pass, 9 Oct 2026: /login, /apply).
// The probe is caught and zod falls back to its interpreter, so behaviour does
// not change; jitless skips the probe and the violation noise with it.
//
// This used to run in instrumentation-client.ts, which put zod into the
// JavaScript of every page (speed quick win 2d, 6 Nov 2026). An ES module's
// body runs before the body of any module that imports it, so the setting is
// in place before the importing page builds its first schema.
import { z } from "zod";

z.config({ jitless: true });

export { z };
