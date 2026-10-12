/**
 * Vercel cron entry — runs daily at 03:30 UTC.
 * Schedule defined in vercel.json: "30 3 * * *".
 *
 * Closes audit findings P0-4 (published retention policy was fiction — no
 * deleteMany existed anywhere for AuditLog / EmailLog / tokens / ImportJob),
 * P2-2 (expired auth tokens accumulated forever with email + IP + UA), and
 * P1-6 ("deleted" tenants were never actually deleted despite the operator
 * UI promising "reversible for 30 days, then a cron hard-deletes").
 *
 * Design rules, all deliberate:
 *
 *  - Every rule is INDEPENDENT. One failing rule must not stop the others,
 *    so each runs in its own try/catch and reports `{ deleted }` or
 *    `{ error }` into the JSON response. Failures are also console.error'd
 *    so they surface in Vercel logs even when the cron reports 200.
 *
 *  - Every rule is CHUNKED. Deletes run as `findMany({ select: { id }, take })`
 *    followed by `deleteMany({ where: { id: { in: … } } })`, each batch in its
 *    own transaction. A 300s function timeout therefore truncates the sweep
 *    mid-way at a committed batch boundary — never mid-cascade — and the next
 *    night's run picks up exactly where this one stopped. No poison state.
 *
 *  - Runtime is CAPPED. maxDuration is 300s; we stop starting new rules (and
 *    stop starting new batches inside a rule) after 240s. A rule cut short
 *    reports `{ partial: true, processed: n }` and an untouched rule reports
 *    `{ skipped: true }` — neither is a failure. Retention is eventually
 *    consistent by design: what's left tonight runs tomorrow.
 *
 * Retention windows are the ones published at /legal/privacy. Change them
 * together or the policy goes back to being fiction.
 */
import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/constant-time";
import { checkCronAuthAttempt } from "@/lib/rate-limit";
import { del } from "@vercel/blob";
import { Prisma } from "@prisma/client";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { isVercelBlobUrl } from "@/lib/blob-url";
import { DB_UPLOAD_PREFIX } from "@/lib/import-storage";
import { purgeSoftDeletedTenants } from "@/lib/tenant-purge";
import { auditLogRetentionWhere } from "@/lib/audit-log";
import { runStripeReconciliation, type ReconcileResult } from "@/lib/stripe/reconcile";

export const runtime = "nodejs";
export const maxDuration = 300;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows deleted per statement. Keeps each transaction inside the 15s budget. */
const BATCH = 1000;
/** Stop starting new work after this, leaving 60s of the 300s budget spare. */
const DEADLINE_MS = 240_000;

// Published retention windows (app/legal/privacy/page.tsx §6). AuditLog's
// windows live in lib/audit-log.ts (auditLogRetentionWhere): twelve months for
// ordinary rows, six years for platform evidence — operator actions, support
// sessions and erasure records (operator audit 5 Oct 2026, Q9).
const EMAIL_LOG_RETENTION_MS = 365 * DAY_MS;
/**
 * Sign-in records (LoginEvent: one row per person per device, approximate IP +
 * browser summary) are written on every sign-in since the E2E flow 9 fix (6 Oct
 * 2026). A device not signed in from for twelve months is dropped (review of
 * lane I). Keyed on lastSeenAt, which only moves at sign-in — an Auth.js
 * session that keeps rolling does not touch it — so someone who stays signed
 * in for a year loses the row and their next sign-in counts as a new device.
 */
const LOGIN_EVENT_RETENTION_MS = 365 * DAY_MS;
/**
 * 24h grace AFTER expiry rather than deleting on expiry: a sign-in link being
 * verified at the instant it lapses must still resolve to "this link has
 * expired" rather than "invalid link", and the row is what tells those apart.
 */
const EXPIRED_TOKEN_GRACE_MS = DAY_MS;
/** RateLimitHit windows are ≤1h; anything a day old is dead weight. */
const RATE_LIMIT_HIT_RETENTION_MS = DAY_MS;
/** Stripe's event replay window is ~30 days; 90 is a generous idempotency margin. */
const STRIPE_EVENT_RETENTION_MS = 90 * DAY_MS;
/** Abandoned CSV imports still hold member PII in blob storage. */
const IMPORT_JOB_RETENTION_MS = 30 * DAY_MS;
/**
 * ImportJob.dryRunSummary / errorLog keep verbatim CSV row content — up to five
 * MemberDrafts (name, email, phone, dateOfBirth) plus error strings that embed
 * raw addresses. On a `complete` job the row is import history we keep, so the
 * rule below would never touch it and that PII would outlive the member's own
 * Article 17 erasure, forever. These two columns are diagnostics with a
 * days-long useful life, not history: the row's counters carry the history.
 */
const IMPORT_JOB_DIAGNOSTICS_RETENTION_MS = 30 * DAY_MS;
// The 30-day tenant soft-delete window is TENANT_SOFT_DELETE_GRACE_MS in
// lib/tenant-lifecycle.ts, shared with the restore route so the two agree.

/**
 * ImportJob status vocabulary (app/api/admin/import/*): pending | preview |
 * running | complete | failed. `complete` is the only terminal success — its
 * blob is already deleted by the commit route, and the row is import history
 * the owner can still see. Everything else older than the window is an
 * abandoned job whose CSV is still sitting in blob storage.
 */
const IMPORT_JOB_TERMINAL_STATUSES = ["complete"];

type RuleResult = {
  rule: string;
  deleted?: number;
  error?: string;
  skipped?: boolean;
  /**
   * True when the deadline cut the rule short. Not an error: every rule is
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
 * The first live run of this sweep is a one-way door, and the scheduler entry
 * in vercel.json would take it the moment a CRON_SECRET is set. So the live
 * sweep runs only when this variable is EXACTLY the string "true"; anything
 * else (unset, "1", "TRUE", " true") answers 503 `retention cron disabled`
 * after the bearer check and BEFORE any work — no reconcile, no count, no
 * delete. `?dryRun=1` is still allowed with the gate off: counts only, zero
 * deletes, and the response says the gate is off.
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
 * payload (counts name what a club holds; reconcile carries Stripe ids).
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

  // `?dryRun=1`: count what every rule WOULD remove and delete nothing. The
  // first-ever production run of this sweep is a one-way door — it purges a
  // year of logs, 90 days of Stripe events and any tenant past its 30-day
  // soft-delete grace in one pass — so the counts get read by a human before
  // the scheduler is allowed to run it for real. Reconcile still runs (it is
  // read-only). The bearer is still required: counts name tenants.
  const dryRun = dryRunRequested;
  const sweep = (pick: PickModel, where: object) =>
    dryRun ? countOnly(pick, where) : deleteInBatches(pick, where, elapsed);

  // Stripe reconciliation runs here rather than on its own schedule: Vercel's
  // Hobby plan allows 2 cron entries and monthly-reports + this one use both.
  //
  // It goes FIRST and startedAt is stamped BEFORE it, deliberately. Reconcile is
  // read-only, bounded by a 72h lookback, and cannot resume — a truncated run
  // just misses drops. Retention is chunked and explicitly eventually consistent:
  // whatever it doesn't reach tonight it picks up tomorrow at a committed batch
  // boundary. So reconcile gets guaranteed time and retention absorbs the cost,
  // and because elapsed() counts reconcile's time, retention's own 240s soft cap
  // still bounds the whole function inside maxDuration.
  //
  // Never let a reconcile failure take the retention sweep down with it.
  let reconcile: ReconcileResult | { error: string };
  try {
    reconcile = await runStripeReconciliation();
  } catch (e) {
    reconcile = { error: (e as Error)?.message ?? "unknown" };
    console.error("[cron/retention] Stripe reconciliation step failed", { error: reconcile.error });
  }

  const rules: Array<{ name: string; run: () => Promise<Omit<RuleResult, "rule">> }> = [
    {
      name: "auditLog",
      run: () =>
        sweep(
          (tx) => tx.auditLog as unknown as BatchDeletable,
          auditLogRetentionWhere(now),
        ),
    },
    {
      name: "emailLog",
      run: () =>
        sweep(
          (tx) => tx.emailLog as unknown as BatchDeletable,
          { createdAt: { lt: ago(EMAIL_LOG_RETENTION_MS) } },
        ),
    },
    {
      name: "loginEvent",
      run: () =>
        sweep(
          (tx) => tx.loginEvent as unknown as BatchDeletable,
          { lastSeenAt: { lt: ago(LOGIN_EVENT_RETENTION_MS) } },
        ),
    },
    {
      name: "magicLinkToken",
      run: () =>
        sweep(
          (tx) => tx.magicLinkToken as unknown as BatchDeletable,
          { expiresAt: { lt: ago(EXPIRED_TOKEN_GRACE_MS) } },
        ),
    },
    {
      name: "passwordResetToken",
      run: () =>
        sweep(
          (tx) => tx.passwordResetToken as unknown as BatchDeletable,
          { expiresAt: { lt: ago(EXPIRED_TOKEN_GRACE_MS) } },
        ),
    },
    {
      name: "rateLimitHit",
      run: () =>
        sweep(
          (tx) => tx.rateLimitHit as unknown as BatchDeletable,
          { hitAt: { lt: ago(RATE_LIMIT_HIT_RETENTION_MS) } },
        ),
    },
    {
      // StripeEvent carries no createdAt — `processedAt @default(now())` is
      // the only timestamp on the model (schema:653-658).
      name: "stripeEvent",
      run: () =>
        sweep(
          (tx) => tx.stripeEvent as unknown as BatchDeletable,
          { processedAt: { lt: ago(STRIPE_EVENT_RETENTION_MS) } },
        ),
    },
    {
      // Chunked import uploads (lib/import-upload.ts) live 24h. An expired one
      // that never fed a job is a stranded copy of a member CSV; chunks cascade.
      // A consumed upload belongs to its import job and goes with it (rule f).
      name: "importUpload",
      run: () =>
        sweep(
          (tx) => tx.importUpload as unknown as BatchDeletable,
          { expiresAt: { lt: now }, status: { not: "consumed" } },
        ),
    },
    { name: "importJob", run: () => purgeAbandonedImportJobs(ago(IMPORT_JOB_RETENTION_MS), elapsed, dryRun) },
    {
      name: "importJobDiagnostics",
      run: () => scrubImportJobDiagnostics(ago(IMPORT_JOB_DIAGNOSTICS_RETENTION_MS), dryRun),
    },
    { name: "tenantHardDelete", run: () => purgeSoftDeletedTenants(now, () => elapsed() > DEADLINE_MS, dryRun) },
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
  // check. 500 makes Vercel's cron dashboard mark the run failed; per-rule
  // independence above already guarantees the other rules completed, and the
  // next nightly run re-evaluates time-relative predicates, so there is no
  // retry-storm risk in surfacing the failure.
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

// ─── Generic chunked delete ──────────────────────────────────────────────────

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

// ─── Rule f — abandoned CSV import jobs (rows + their blobs) ─────────────────

async function purgeAbandonedImportJobs(
  cutoff: Date,
  elapsed: () => number,
  dryRun = false,
): Promise<{ deleted: number; partial?: true; processed?: number; details: Record<string, unknown> }> {
  const where = {
    status: { notIn: IMPORT_JOB_TERMINAL_STATUSES },
    createdAt: { lt: cutoff },
    // An attendance import that STARTED writing (running, or stopped part-way
    // as "failed") owns ledger rows, sessions and visits; its job row is what
    // a resume or a rollback needs. Never "abandoned" by age (3 Oct 2026).
    NOT: { source: "teamup-attendance", status: { in: ["running", "failed"] } },
  };

  if (dryRun) {
    const wouldDelete = await withRlsBypass((tx) => tx.importJob.count({ where }));
    return { deleted: 0, details: { wouldDelete } };
  }

  let deleted = 0;
  let blobsDeleted = 0;
  for (;;) {
    if (elapsed() > DEADLINE_MS) {
      return { deleted, partial: true, processed: deleted, details: { blobsDeleted } };
    }

    const jobs = await withRlsBypass((tx) =>
      tx.importJob.findMany({ where, select: { id: true, tenantId: true, fileBlobUrl: true }, take: BATCH }),
    );
    if (jobs.length === 0) return { deleted, details: { blobsDeleted } };

    // Best-effort blob cleanup BEFORE the rows go: once the row is gone the
    // URL is unrecoverable and the CSV (member PII) is orphaned forever.
    // Guarded by isVercelBlobUrl so legacy/data: values never reach del().
    const blobUrls = jobs.map((j) => j.fileBlobUrl).filter(isVercelBlobUrl);
    if (blobUrls.length > 0) {
      blobsDeleted += await deleteBlobsBestEffort(blobUrls);
    }
    // Files uploaded in chunks live in Postgres (db-upload://<id>), not Blob.
    blobsDeleted += await deleteDbUploadsForJobs(jobs);

    const res = await withRlsBypass((tx) =>
      tx.importJob.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } }),
    );
    deleted += res.count;

    if (jobs.length < BATCH) return { deleted, details: { blobsDeleted } };
  }
}

// ─── Rule f2 — scrub PII-bearing import diagnostics (all statuses) ───────────

/**
 * Null `dryRunSummary` and `errorLog` on every ImportJob older than the window,
 * INCLUDING `complete` ones. Rule f above deliberately exempts `complete` jobs
 * because the row is import history the owner can still see — but that
 * exemption made the CSV row content inside these two Json columns permanent,
 * outliving the erasure of the very members it names (GDPR NEW-1). The row and
 * its counters (totalRows/importedRows/…) survive untouched; only the
 * PII-bearing diagnostics go.
 *
 * A single updateMany, not a chunked walk: it touches at most a handful of rows
 * per tenant per month and takes no deadline argument for that reason.
 *
 * Both columns are `Json?` (schema: ImportJob.errorLog / dryRunSummary), so the
 * write is `Prisma.DbNull` — plain `null` on a Json field is a Prisma type
 * error, and `Prisma.JsonNull` would store the JSON value `null` rather than
 * SQL NULL.
 */
async function scrubImportJobDiagnostics(
  cutoff: Date,
  dryRun = false,
): Promise<{ deleted: number; details: Record<string, unknown> }> {
  const where = {
    createdAt: { lt: cutoff },
    OR: [{ dryRunSummary: { not: Prisma.DbNull } }, { errorLog: { not: Prisma.DbNull } }],
  };
  if (dryRun) {
    const wouldScrub = await withRlsBypass((tx) => tx.importJob.count({ where }));
    return { deleted: 0, details: { wouldScrub } };
  }
  const res = await withRlsBypass((tx) =>
    tx.importJob.updateMany({
      where,
      data: { dryRunSummary: Prisma.DbNull, errorLog: Prisma.DbNull },
    }),
  );
  // A stopped attendance import keeps its job row (a resume or a rollback
  // needs it; rule f never purges it) but not, after this window, the
  // uploaded file of member names and emails (acceptance review, 3 Oct 2026).
  const stoppedAttendance = await withRlsBypass((tx) =>
    tx.importJob.findMany({
      where: { source: "teamup-attendance", status: "failed", createdAt: { lt: cutoff }, fileBlobUrl: { startsWith: DB_UPLOAD_PREFIX } },
      select: { tenantId: true, fileBlobUrl: true },
    }),
  );
  const uploadsDeleted = await deleteDbUploadsForJobs(stoppedAttendance);
  return { deleted: res.count, details: { scrubbed: res.count, stoppedAttendanceUploadsDeleted: uploadsDeleted } };
}

/**
 * Delete the chunked uploads (db-upload://<id>) these import jobs point at,
 * each scoped to its own job's tenant. Chunks cascade. Best-effort like the
 * Blob delete: a failure leaves the upload for its own expiry rule.
 */
async function deleteDbUploadsForJobs(
  jobs: Array<{ tenantId: string; fileBlobUrl: string | null }>,
): Promise<number> {
  const targets = jobs
    .filter((j) => j.fileBlobUrl?.startsWith(DB_UPLOAD_PREFIX))
    .map((j) => ({ id: j.fileBlobUrl!.slice(DB_UPLOAD_PREFIX.length), tenantId: j.tenantId }));
  if (targets.length === 0) return 0;
  try {
    const res = await withRlsBypass((tx) => tx.importUpload.deleteMany({ where: { OR: targets } }));
    return res.count;
  } catch (e) {
    console.warn("[cron/retention] import upload delete failed (best-effort)", e);
    return 0;
  }
}

/**
 * del() the given blob URLs, swallowing failures. Blob storage is not the
 * source of truth — a failed delete must never roll back or abort a retention
 * sweep, it just leaves an orphan for the next pass to miss.
 */
async function deleteBlobsBestEffort(urls: string[]): Promise<number> {
  if (urls.length === 0) return 0;
  try {
    await del(urls);
    return urls.length;
  } catch (e) {
    console.warn("[cron/retention] blob delete failed (best-effort)", e);
    return 0;
  }
}

// Rule g (tenant hard-delete) lives in lib/tenant-purge.ts so the
// restore-versus-purge coordination can be tested against a real database.
