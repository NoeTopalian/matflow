// GET /api/admin/stripe/events — Stripe sync state for the operator console
// (payments lane PD, 11 Oct 2026; audit §19).
//
// Per club: the connected account (id, flag, cached status and when it was
// refreshed), event counts by store status for 24 h and 7 d, the last event
// seen, and the events that need attention (failed, or received and never
// processed — including ones the reconcile job found missing). Plus events
// whose account maps to no club, and the last reconcile run with its
// mismatches. Read-only. No secrets, no payloads, no personal data: event ids,
// types, statuses, attempts and the sanitised last error only.
//
// Gate: operator authority (MFA session + allowlist; lib/admin-auth.ts), and a
// support (impersonation) session is refused outright.

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdminAuthed } from "@/lib/admin-auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { refuseSupportSession } from "@/lib/support-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ATTENTION_PER_CLUB = 50;
const MAX_CLUBS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

const EVENT_SELECT = {
  eventId: true,
  type: true,
  status: true,
  created: true,
  attempts: true,
  lastError: true,
  firstSeenAt: true,
  lastAttemptAt: true,
  reconcileFoundAt: true,
  tenantId: true,
} as const;

/** The cached account status, reduced to the fields an operator needs. Never a key. */
function accountSummary(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  return {
    chargesEnabled: bool(s.chargesEnabled),
    payoutsEnabled: bool(s.payoutsEnabled),
    requirementsPastDue: Array.isArray(s.requirementsPastDue) ? s.requirementsPastDue.length : null,
    disabledReason: typeof s.disabledReason === "string" ? s.disabledReason : null,
    refreshedAt: typeof s.refreshedAt === "string" ? s.refreshedAt : null,
  };
}

export async function GET(req: Request) {
  if (!(await isAdminAuthed(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const support = refuseSupportSession(await auth().catch(() => null));
  if (support) return support;

  const now = Date.now();
  const since24h = new Date(now - DAY_MS);
  const since7d = new Date(now - 7 * DAY_MS);

  const data = await withRlsBypass(async (tx) => {
    const recentTenantIds = await tx.stripeEvent.findMany({
      where: { firstSeenAt: { gte: since7d }, tenantId: { not: null } },
      distinct: ["tenantId"],
      select: { tenantId: true },
      take: MAX_CLUBS,
    });
    const tenants = await tx.tenant.findMany({
      where: {
        OR: [
          { stripeAccountId: { not: null } },
          { id: { in: recentTenantIds.map((r) => r.tenantId!).filter(Boolean) } },
        ],
      },
      select: { id: true, name: true, stripeAccountId: true, stripeConnected: true, stripeAccountStatus: true },
      orderBy: { name: "asc" },
      take: MAX_CLUBS,
    });
    const ids = tenants.map((t) => t.id);
    const [c24, c7, last, attention, unattributed, lastRun] = await Promise.all([
      tx.stripeEvent.groupBy({ by: ["tenantId", "status"], where: { tenantId: { in: ids }, firstSeenAt: { gte: since24h } }, _count: { _all: true } }),
      tx.stripeEvent.groupBy({ by: ["tenantId", "status"], where: { tenantId: { in: ids }, firstSeenAt: { gte: since7d } }, _count: { _all: true } }),
      tx.stripeEvent.groupBy({ by: ["tenantId"], where: { tenantId: { in: ids } }, _max: { firstSeenAt: true } }),
      tx.stripeEvent.findMany({
        where: { tenantId: { in: ids }, status: { in: ["failed", "received"] } },
        orderBy: { firstSeenAt: "desc" },
        select: EVENT_SELECT,
        take: ATTENTION_PER_CLUB * Math.max(ids.length, 1),
      }),
      tx.stripeEvent.findMany({
        where: { tenantId: null, status: { in: ["failed", "received"] } },
        orderBy: { firstSeenAt: "desc" },
        select: { ...EVENT_SELECT, stripeAccountId: true },
        take: ATTENTION_PER_CLUB,
      }),
      tx.stripeReconcileRun.findFirst({ orderBy: { startedAt: "desc" } }),
    ]);
    return { tenants, c24, c7, last, attention, unattributed, lastRun };
  });

  const counts = (rows: typeof data.c24, tenantId: string) =>
    Object.fromEntries(rows.filter((r) => r.tenantId === tenantId).map((r) => [r.status, r._count._all]));
  const clubs = data.tenants.map((t) => ({
    tenantId: t.id,
    name: t.name,
    stripeAccountId: t.stripeAccountId,
    stripeConnected: t.stripeConnected,
    account: accountSummary(t.stripeAccountStatus),
    counts: { last24h: counts(data.c24, t.id), last7d: counts(data.c7, t.id) },
    lastEventAt: data.last.find((l) => l.tenantId === t.id)?._max.firstSeenAt ?? null,
    attention: data.attention.filter((e) => e.tenantId === t.id).slice(0, ATTENTION_PER_CLUB),
  }));

  return NextResponse.json({
    generatedAt: new Date(now).toISOString(),
    clubs,
    unattributed: data.unattributed,
    lastRun: data.lastRun,
  });
}
