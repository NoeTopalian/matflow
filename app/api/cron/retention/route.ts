/**
 * Vercel cron entry — runs daily at 03:30 UTC.
 * Schedule defined in vercel.json: "30 3 * * *".
 *
 * PRODUCT RULE (Noe, 6 Nov 2026; docs/RULES.md): "nothing should be
 * automatically deleted" and "all data from the entirety of the club should be
 * held". This job therefore deletes NO club data. It used to purge the
 * Activity log after a year, email logs and sign-in device records after 365
 * days, expired sign-in and reset links, Stripe webhook records after 90 days,
 * abandoned imports and their files after 30 days, and closed clubs 30 days
 * after closing. All of those rules are gone:
 *
 *  - Expired sign-in and reset links are kept safely: only an HMAC of each link
 *    is stored (lib/token-hash.ts), and every use checks `used: false` and
 *    `expiresAt > now`, so a kept expired link can never sign anyone in.
 *  - Closed clubs are kept, with sign-in disabled, so they can reopen (Noe,
 *    16 Oct 2026). Erasure happens only on the club's written request, run by
 *    an operator through lib/tenant-purge.ts, never on a schedule.
 *    tests/unit/keep-closed-clubs-ratchet.test.ts keeps the by-age purge out.
 *
 * What is left, in order:
 *
 *  1. The nightly Stripe reconciliation (read-only). It is why the vercel.json
 *     entry stays.
 *  2. ONE deletion rule: sign-in rate-limit counters (RateLimitHit) older than
 *     a day. They are security counters, not club data, and the limiter only
 *     ever reads the last hour of them.
 *
 * tests/unit/retention-cron.test.ts pins both halves: the rule list is exactly
 * ["rateLimitHit"], and a live run touches no other model.
 *
 * Design rules for the remaining rule, all deliberate:
 *
 *  - It is CHUNKED. Deletes run as `findMany({ select: { id }, take })`
 *    followed by `deleteMany({ where: { id: { in: … } } })`, each batch in its
 *    own transaction, so a 300s function timeout stops at a committed batch
 *    boundary and the next night's run picks up where this one stopped.
 *
 *  - Runtime is CAPPED. maxDuration is 300s; no new batch starts after 240s. A
 *    rule cut short reports `{ partial: true, processed: n }`, which is not a
 *    failure.
 *
 *  - A failing rule is caught, reported as `{ error }` and console.error'd, and
 *    the run answers 500 so status-code monitoring sees it.
 */
import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/constant-time";
import { checkCronAuthAttempt } from "@/lib/rate-limit";
import { Prisma } from "@prisma/client";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { runStripeReconciliation, type ReconcileResult } from "@/lib/stripe/reconcile";

export const runtime = "nodejs";
export const maxDuration = 300;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows deleted per statement. Keeps each transaction inside the 15s budget. */
const BATCH = 1000;
/** Stop starting new work after this, leaving 60s of the 300s budget spare. */
const DEADLINE_MS = 240_000;

/** RateLimitHit windows are ≤1h; anything a day old is dead weight. */
const RATE_LIMIT_HIT_RETENTION_MS = DAY_MS;

type RuleResult = {
  rule: string;
  deleted?: number;
  error?: string;
  skipped?: boolean;
  /**
   * True when the deadline cut the rule short. Not an error: the rule is
   * idempotent and resumes from a committed batch boundary on the next run.
   */
  partial?: boolean;
  /** Units the rule got through before the deadline (rule-specific noun). */
  processed?: number;
  details?: Record<string, unknown>;
};

/**
 * Structural view of the Prisma delegate methods the batch helper needs.
 * Prisma's generated delegates are overloaded generics, so the call sites
 * cast through `unknown`; the shape below is what actually gets used.
 */
type IdRow = { id: string };
type BatchDeletable = {
  findMany(args: { where: object; select: { id: true }; take: number }): Promise<IdRow[]>;
  deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }>;
  count(args: { where: object }): Promise<number>;
};
type PickModel = (tx: Prisma.TransactionClient) => BatchDeletable;

/**
 * RETENTION_CRON_ENABLED — default OFF (security campaign iteration 2, lane M1,
 * 10 Oct 2026; authorised by Noe the same day).
 *
 * The live sweep runs only when this variable is EXACTLY the string "true";
 * anything else (unset, "1", "TRUE", " true") answers 503 `retention cron
 * disabled` after the bearer check and BEFORE any work — no reconcile, no
 * count, no delete. `?dryRun=1` is still allowed with the gate off: counts
 * only, zero deletes, and the response says the gate is off. Since 6 Nov 2026
 * the only thing the gate guards is the rate-limit counter prune.
 */
function retentionEnabled(): boolean {
  return process.env.RETENTION_CRON_ENABLED === "true";
}

/**
 * Why a call answered as it did — a closed set, so the log line can say it
 * without carrying anything from the request. Lane M2 (10 Oct 2026, R8
 * residual): the gate-off refusal and the missing-CRON_SECRET refusal both
 * read `status=503`, so "switched off" and "misconfigured" looked the same.
 */
type CallReason = "not_configured" | "throttled" | "unauthorized" | "disabled" | "dry_run" | "swept" | "threw";

/**
 * One line per call: the gate, the mode, the status and the reason. Never the
 * payload (reconcile carries Stripe ids).
 */
export async function GET(req: Request) {
  const gate = retentionEnabled() ? "on" : "off";
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1" ? 1 : 0;
  let status: number | "threw" = "threw";
  const call: { reason: CallReason } = { reason: "threw" };
  try {
    const res = await handle(req, call);
    status = res.status;
    return res;
  } finally {
    console.info(`[cron/retention] call gate=${gate} dryRun=${dryRun} status=${status} reason=${call.reason}`);
  }
}

async function handle(req: Request, call: { reason: CallReason }) {
  // Vercel cron sends Authorization: Bearer ${CRON_SECRET}
  const authHeader = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    call.reason = "not_configured";
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
      call.reason = "throttled";
      return NextResponse.json(
        { error: "Too many attempts. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(throttle.retryAfterSeconds) } },
      );
    }
    call.reason = "unauthorized";
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // The gate (see retentionEnabled): before any work, after the bearer — an
  // unauthenticated caller learns nothing about the configuration.
  const enabled = retentionEnabled();
  const dryRunRequested = new URL(req.url).searchParams.get("dryRun") === "1";
  if (!enabled && !dryRunRequested) {
    call.reason = "disabled";
    return NextResponse.json({ error: "retention cron disabled" }, { status: 503 });
  }

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);

  // `?dryRun=1`: count what the rule WOULD remove and delete nothing.
  // Reconcile still runs (it is read-only). The bearer is still required.
  const dryRun = dryRunRequested;
  const sweep = (pick: PickModel, where: object) =>
    dryRun ? countOnly(pick, where) : deleteInBatches(pick, where, elapsed);

  // Stripe reconciliation runs here rather than on its own schedule: Vercel's
  // Hobby plan allows 2 cron entries and monthly-reports + this one use both.
  // It goes FIRST and startedAt is stamped BEFORE it, so the rate-limit prune's
  // 240s soft cap still bounds the whole function inside maxDuration.
  //
  // Never let a reconcile failure take the prune down with it.
  let reconcile: ReconcileResult | { error: string };
  try {
    reconcile = await runStripeReconciliation();
  } catch (e) {
    reconcile = { error: (e as Error)?.message ?? "unknown" };
    console.error("[cron/retention] Stripe reconciliation step failed", { error: reconcile.error });
  }

  // The ONLY deletion left (see the header). Do not add a rule here that
  // removes club data: product rule, docs/RULES.md.
  const rules: Array<{ name: string; run: () => Promise<Omit<RuleResult, "rule">> }> = [
    {
      name: "rateLimitHit",
      run: () =>
        sweep(
          (tx) => tx.rateLimitHit as unknown as BatchDeletable,
          { hitAt: { lt: ago(RATE_LIMIT_HIT_RETENTION_MS) } },
        ),
    },
  ];

  const results: RuleResult[] = [];
  for (const rule of rules) {
    if (elapsed() > DEADLINE_MS) {
      results.push({ rule: rule.name, skipped: true });
      continue;
    }
    try {
      results.push({ rule: rule.name, ...(await rule.run()) });
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown";
      console.error(`[cron/retention] rule "${rule.name}" failed`, e);
      results.push({ rule: rule.name, error: message });
    }
  }

  // Storage-audit hardening (2026-08-16): a failed rule must be visible to
  // status-code monitoring — 200 + ok:false is invisible to every uptime
  // check. 500 makes Vercel's cron dashboard mark the run failed.
  const ok = results.every((r) => !r.error);
  call.reason = dryRun ? "dry_run" : "swept";
  return NextResponse.json(
    {
      ok,
      dryRun,
      retentionEnabled: enabled,
      ...(enabled
        ? {}
        : { note: "retention cron disabled (RETENTION_CRON_ENABLED is not \"true\"): dry run only, nothing deleted" }),
      ranAt: now.toISOString(),
      elapsedMs: elapsed(),
      reconcile,
      results,
    },
    { status: ok ? 200 : 500 },
  );
}

// ─── Dry run: count, never delete ────────────────────────────────────────────

async function countOnly(pick: PickModel, where: object): Promise<{ deleted: number; details: Record<string, unknown> }> {
  const wouldDelete = await withRlsBypass((tx) => pick(tx).count({ where }));
  return { deleted: 0, details: { wouldDelete } };
}

// ─── Chunked delete ──────────────────────────────────────────────────────────

/**
 * Delete every row matching `where`, `BATCH` rows at a time, each batch in its
 * own transaction. Returns as soon as the deadline passes so the caller can
 * report the rule as partial rather than being killed mid-flight.
 */
async function deleteInBatches(
  pick: PickModel,
  where: object,
  elapsed: () => number,
): Promise<{ deleted: number; partial?: true; processed?: number }> {
  let deleted = 0;
  for (;;) {
    if (elapsed() > DEADLINE_MS) return { deleted, partial: true, processed: deleted };

    const rows = await withRlsBypass((tx) =>
      pick(tx).findMany({ where, select: { id: true }, take: BATCH }),
    );
    if (rows.length === 0) return { deleted };

    const res = await withRlsBypass((tx) =>
      pick(tx).deleteMany({ where: { id: { in: rows.map((r) => r.id) } } }),
    );
    deleted += res.count;

    // A short page means we've reached the tail of the matching set.
    if (rows.length < BATCH) return { deleted };
  }
}
