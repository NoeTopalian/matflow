/**
 * Next.js boot-time instrumentation. Runs once per Node/edge runtime
 * before the first request handler. Wires:
 *  - Sentry init (server / edge config; sentry.client.config.ts loads
 *    automatically on the client side)
 *  - Production env-var guards (lib/env-guards.ts) — fail loud at
 *    server start if a required prod secret is missing
 */
import { runProductionEnvGuards } from "@/lib/env-guards";

export async function register() {
  runProductionEnvGuards();

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}
