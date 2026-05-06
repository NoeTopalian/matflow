/**
 * GET /api/health — public health probe.
 *
 * Designed for an external uptime service (BetterStack, UptimeRobot, etc.)
 * polling once a minute. Returns 200 when the database is reachable, 503
 * otherwise. The body is minimal on purpose:
 *
 *   { status: "ok" | "degraded", db: "ok" | "down", timestamp: <iso> }
 *
 * No version string, no env details, no tenant context — anything richer
 * lives behind /api/stripe/connect/health (owner-only).
 */
import { NextResponse } from "next/server";
import { withRlsBypass } from "@/lib/prisma-tenant";

export const runtime = "nodejs";
// No caching — every probe must reflect current DB state.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const DB_TIMEOUT_MS = 2_000;

async function pingDb(): Promise<"ok" | "down"> {
  try {
    const probe = withRlsBypass((tx) => tx.$queryRaw`SELECT 1`);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("db ping timed out")), DB_TIMEOUT_MS),
    );
    await Promise.race([probe, timeout]);
    return "ok";
  } catch {
    return "down";
  }
}

export async function GET() {
  const db = await pingDb();
  const ok = db === "ok";
  return NextResponse.json(
    {
      status: ok ? "ok" : "degraded",
      db,
      timestamp: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
