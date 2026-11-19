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
 *  - Work is CHUNKED and RESUMABLE. Rows go in batches of HORIZON_INSERT_BATCH (lib/class-horizon.ts) via
 *    createMany({ skipDuplicates: true }) — which only became truthful once
 *    ClassInstance gained @@unique([classId, date, startTime]) in migration
 *    20260819090000. That constraint is what makes this job idempotent: a run
 *    truncated by the deadline commits what it inserted, and tomorrow's run
 *    re-derives the same rows and skips the ones already there. Without it this
 *    cron would have duplicated the whole horizon every single night.
 *
 *  - Runtime is CAPPED. maxDuration is 300s; we stop starting new tenants (and
 *    new batches within a tenant) after 240s. A truncated sweep reports
 *    `partial: true` at the top level, with the counts, and logs one warning
 *    line. It is NOT a failure — the 56-day horizon means there are weeks of
 *    slack before a delayed tenant matters.
 *
 *  - A truncated sweep is FAIR (19 Nov 2026). The clubs used to be read in no
 *    order and walked from the start every night, and a club already up to
 *    date costs as much as a stale one, so a sweep that could not finish
 *    skipped the SAME clubs every night. Now each club carries
 *    `Tenant.classHorizonSweptAt`, the last time a sweep ATTEMPTED it, and the
 *    sweep takes the least recently attempted first (never attempted first of
 *    all, then by id). The stamp is CLAIMED before the club's work, by a
 *    compare-and-set on the value this run read:
 *      - a club that fails, or is cut off part way, has still had its turn and
 *        goes to the back, so it cannot hold the front of the queue and starve
 *        the clubs behind it;
 *      - two invocations that overlap do not both do a club: the second finds
 *        the stamp changed, reports `claimedElsewhere`, and moves on to work
 *        nobody has taken. An invocation that starts later reads the newer
 *        stamps, so the clubs the first has already done sort LAST for it: it
 *        works on what the first has not reached, and only then may repeat a
 *        club (harmless: the rows are deduplicated).
 *    So with N clubs and room for K per run, every club is attempted at least
 *    once every ceil(N / K) runs. Session rows are still deduplicated by
 *    @@unique([classId, date, startTime]); the stamp only decides the order.
 */
import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/constant-time";
import { checkCronAuthAttempt } from "@/lib/rate-limit";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { ROLLING_WINDOW_DAYS } from "@/lib/class-instances";
import { generateClassHorizon } from "@/lib/class-horizon";
import { clubDayMarker } from "@/lib/today-sessions";
import { usableTimezone } from "@/lib/class-time";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * ROLLING_WINDOW_DAYS is 56 — eight weeks. Wide enough that missing a run, or
 * eight weeks of runs, cannot break check-in, and bounded so the table does not
 * grow without limit: a club running 30 classes a week holds ~240 future rows.
 * It lives in lib/class-instances.ts because a schedule edit rebuilds the same
 * horizon (task 3c) and the two must not drift. The per-club generation lives in lib/class-horizon.ts, shared with
 * the member read paths that top the horizon up themselves (Round 9, 16 Nov 2026).
 */
/** Stop starting new work after this, leaving 60s of the 300s budget spare. */
const DEADLINE_MS = 240_000;

type TenantResult = {
  tenantId: string;
  created?: number;
  error?: string;
  /** Not started: the time budget was spent before this club's turn. It is first in line for the next run. */
  skipped?: boolean;
  /** Started but cut off between batches by the deadline. What it inserted is committed. */
  partial?: boolean;
  /** Another invocation claimed this club after this run read the list. Nothing was done for it here. */
  claimedElsewhere?: boolean;
};

export async function GET(req: Request) {
  // Vercel cron sends Authorization: Bearer ${CRON_SECRET}
  const authHeader = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  // Round 1, defect 3: constant time. `!==` short-circuits at the first
  // differing byte. Round 2 carries the other half of that finding — the
  // attempt count now has a brake too, and only a FAILED attempt spends it,
  // so the scheduler's valid bearer is never throttled (lib/rate-limit.ts,
  // checkCronAuthAttempt).
  if (!bearerMatches(authHeader, expected)) {
    const throttle = await checkCronAuthAttempt(req);
    if (!throttle.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(throttle.retryAfterSeconds) } },
      );
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  // THE HORIZON IS PER TENANT, because the day marker is the CLUB's calendar
  // date and two clubs are not on the same date at 02:40 UTC. This job used to
  // compute one `from` from the process clock and hand it to every tenant, so a
  // Sydney or Auckland club — already on tomorrow when this runs — had its
  // horizon shifted a day behind its own read side, and `skipDuplicates` could
  // not match the rows `ensureTodayInstances` had already written for it.
  // Round-3 day-marker migration: the fourth and last writer.
  const now = new Date();

  // Cross-tenant by definition — same rationale as cron/monthly-reports and
  // cron/retention. Each tenant is then processed inside its own context.
  const tenants = await withRlsBypass((tx) =>
    tx.tenant.findMany({
      where: { subscriptionStatus: { in: ["active", "trial"] }, deletedAt: null },
      select: { id: true, timezone: true, classHorizonSweptAt: true },
      // Least recently attempted first; never attempted first of all. See "A truncated sweep is FAIR" above.
      orderBy: [{ classHorizonSweptAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    }),
  );

  const results: TenantResult[] = [];
  for (const tenant of tenants) {
    if (elapsed() > DEADLINE_MS) {
      results.push({ tenantId: tenant.id, skipped: true });
      continue;
    }
    try {
      // Claim the club's turn BEFORE its work: only if nobody has stamped it since this run read the list.
      const claim = await withTenantContext(tenant.id, (tx) =>
        tx.tenant.updateMany({
          where: { id: tenant.id, classHorizonSweptAt: tenant.classHorizonSweptAt },
          data: { classHorizonSweptAt: new Date() },
        }),
      );
      if (claim.count === 0) {
        results.push({ tenantId: tenant.id, claimedElsewhere: true });
        continue;
      }
      const from = clubDayMarker(now, usableTimezone(tenant.timezone));
      results.push({ tenantId: tenant.id, ...(await generateClassHorizon(tenant.id, from, () => elapsed() > DEADLINE_MS)) });
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown";
      console.error(`[cron/class-instances] tenant ${tenant.id} failed`, e);
      results.push({ tenantId: tenant.id, error: message });
    }
  }

  // A failed tenant must be visible to status-code monitoring — 200 + ok:false
  // is invisible to every uptime check. Same call retention/route.ts makes.
  const ok = results.every((r) => !r.error);
  const skipped = results.filter((r) => r.skipped).length;
  const claimedElsewhere = results.filter((r) => r.claimedElsewhere).length;
  const cutOff = results.filter((r) => r.partial).length;
  const failed = results.filter((r) => r.error).length;
  const attempted = results.length - skipped - claimedElsewhere;
  // Truncated by the time budget: at least one club was not started, or one was cut off part way.
  const partial = skipped > 0 || cutOff > 0;
  if (partial) {
    // The one line to look for in the logs. A partial sweep every night means the estate has outgrown one run.
    console.warn(
      `[cron/class-instances] partial sweep: ${attempted} of ${results.length} clubs attempted in ${elapsed()} ms, ` +
        `${skipped} not started, ${cutOff} cut off part way, ${failed} failed. The clubs not started are first in line next run.`,
    );
  }
  return NextResponse.json(
    {
      ok,
      ranAt: new Date(startedAt).toISOString(),
      // No single windowFrom/windowTo any more: the horizon starts at each
      // club's own calendar date. Reporting one pair would have been a lie for
      // every tenant not sharing the host's date. EXCLUSIVE end — the last day
      // generated is `from + ROLLING_WINDOW_DAYS - 1`, because the window is a
      // count of days rather than an end date.
      windowDays: ROLLING_WINDOW_DAYS,
      elapsedMs: elapsed(),
      partial,
      tenantsTotal: results.length,
      // Clubs this run actually started. It used to count the skipped ones too, which read as "all done".
      tenantsProcessed: attempted,
      tenantsSkipped: skipped,
      tenantsCutOff: cutOff,
      tenantsClaimedElsewhere: claimedElsewhere,
      tenantsFailed: failed,
      created: results.reduce((sum, r) => sum + (r.created ?? 0), 0),
      results,
    },
    { status: ok ? 200 : 500 },
  );
}
