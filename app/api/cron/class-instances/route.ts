/**
 * Vercel cron entry — runs daily at 02:40 UTC.
 * Schedule defined in vercel.json: "40 2 * * *".
 *
 * Closes task 3a: NOTHING regenerated ClassInstance rows. They were created
 * only by two manual endpoints, both defaulting to a four-week window, and
 * `vercel.json` declared no cron for them. So roughly four weeks after the last
 * time a staff member happened to press "Generate", the window lapsed and:
 *
 *   /api/member/schedule started returning `classInstanceId: null`
 *   → app/member/home only offers check-in `if (cls.classInstanceId)`
 *   → /api/checkin requires one
 *   → members silently could not check in, with no error on either side,
 *     and staff saw an empty register.
 *
 * A gym runs its front door on this, and it failed silently. So the window is
 * deliberately far wider than the interval between runs: at
 * ROLLING_WINDOW_DAYS = 56, check-in survives eight weeks of total cron outage,
 * not one missed night. That matters because the Vercel Hobby plan only permits
 * DAILY cron schedules — there is no hourly retry to lean on — and because a
 * failed run reports 500 but nothing pages anyone at 02:40.
 *
 * Design rules mirror app/api/cron/retention/route.ts:
 *
 *  - Every TENANT is INDEPENDENT. One gym's failure must not stop the next
 *    gym's classes being generated, so each runs in its own try/catch and
 *    reports `{ created }` or `{ error }` into the JSON response.
 *
 *  - Work is CHUNKED and RESUMABLE. Rows go in batches of INSERT_BATCH via
 *    createMany({ skipDuplicates: true }) — which only became truthful once
 *    ClassInstance gained @@unique([classId, date, startTime]) in migration
 *    20260819090000. That constraint is what makes this job idempotent: a run
 *    truncated by the deadline commits what it inserted, and tomorrow's run
 *    re-derives the same rows and skips the ones already there. Without it this
 *    cron would have duplicated the whole horizon every single night.
 *
 *  - Runtime is CAPPED. maxDuration is 300s; we stop starting new tenants (and
 *    new batches within a tenant) after 240s. A truncated sweep reports
 *    `partial: true` and is NOT a failure — the 56-day horizon means there are
 *    weeks of slack before a delayed tenant matters.
 */
import { NextResponse } from "next/server";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { buildInstanceRows, ROLLING_WINDOW_DAYS } from "@/lib/class-instances";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * ROLLING_WINDOW_DAYS is 56 — eight weeks. Wide enough that missing a run, or
 * eight weeks of runs, cannot break check-in, and bounded so the table does not
 * grow without limit: a club running 30 classes a week holds ~240 future rows.
 * It lives in lib/class-instances.ts because a schedule edit rebuilds the same
 * horizon (task 3c) and the two must not drift.
 */
/** Rows per createMany. Keeps each statement inside the transaction budget. */
const INSERT_BATCH = 500;
/** Stop starting new work after this, leaving 60s of the 300s budget spare. */
const DEADLINE_MS = 240_000;

type TenantResult = {
  tenantId: string;
  created?: number;
  error?: string;
  skipped?: boolean;
  partial?: boolean;
};

export async function GET(req: Request) {
  // Vercel cron sends Authorization: Bearer ${CRON_SECRET}
  const authHeader = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  const from = new Date();
  from.setHours(0, 0, 0, 0);
  // Reporting only. EXCLUSIVE bound: the last day actually generated is
  // `from + ROLLING_WINDOW_DAYS - 1`, because the window is a count of days
  // rather than an end date. Treating this value as inclusive is the exact
  // off-by-one that made the horizon 57 days and a test date-dependent.
  const toExclusive = new Date(from);
  toExclusive.setDate(from.getDate() + ROLLING_WINDOW_DAYS);

  // Cross-tenant by definition — same rationale as cron/monthly-reports and
  // cron/retention. Each tenant is then processed inside its own context.
  const tenants = await withRlsBypass((tx) =>
    tx.tenant.findMany({
      where: { subscriptionStatus: { in: ["active", "trial"] }, deletedAt: null },
      select: { id: true },
    }),
  );

  const results: TenantResult[] = [];
  for (const tenant of tenants) {
    if (elapsed() > DEADLINE_MS) {
      results.push({ tenantId: tenant.id, skipped: true });
      continue;
    }
    try {
      results.push({ tenantId: tenant.id, ...(await generateForTenant(tenant.id, from, elapsed)) });
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown";
      console.error(`[cron/class-instances] tenant ${tenant.id} failed`, e);
      results.push({ tenantId: tenant.id, error: message });
    }
  }

  // A failed tenant must be visible to status-code monitoring — 200 + ok:false
  // is invisible to every uptime check. Same call retention/route.ts makes.
  const ok = results.every((r) => !r.error);
  return NextResponse.json(
    {
      ok,
      ranAt: new Date(startedAt).toISOString(),
      windowFrom: from.toISOString(),
      windowTo: toExclusive.toISOString(),
      windowDays: ROLLING_WINDOW_DAYS,
      elapsedMs: elapsed(),
      tenantsProcessed: results.length,
      created: results.reduce((sum, r) => sum + (r.created ?? 0), 0),
      results,
    },
    { status: ok ? 200 : 500 },
  );
}

async function generateForTenant(
  tenantId: string,
  from: Date,
  elapsed: () => number,
): Promise<{ created: number; partial?: true }> {
  const classes = await withTenantContext(tenantId, (tx) =>
    tx.class.findMany({
      // A paused (isActive: false) or removed (deletedAt) class must not have
      // instances minted for it — that would put it back on the check-in
      // screen while every list filters it out.
      where: { tenantId, isActive: true, deletedAt: null },
      select: {
        id: true,
        schedules: {
          where: { isActive: true },
          select: { dayOfWeek: true, startTime: true, endTime: true, startDate: true, endDate: true },
        },
      },
    }),
  );

  const rows = buildInstanceRows(classes, { from, days: ROLLING_WINDOW_DAYS });
  if (rows.length === 0) return { created: 0 };

  let created = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    if (elapsed() > DEADLINE_MS) return { created, partial: true };
    const batch = rows.slice(i, i + INSERT_BATCH);
    const res = await withTenantContext(tenantId, (tx) =>
      // Genuinely idempotent since migration 20260819090000 gave ClassInstance
      // @@unique([classId, date, startTime]). Before that this line was a lie
      // and this cron would have duplicated the horizon nightly.
      tx.classInstance.createMany({ data: batch, skipDuplicates: true }),
    );
    created += res.count;
  }

  return { created };
}
