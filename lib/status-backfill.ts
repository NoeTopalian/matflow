import type { Prisma } from "@prisma/client";
import { parseTime, usableTimezone, zoneOffsetMs } from "./class-time";
import { recordStatusEventsBulk, type RecordStatusEventInput } from "./member-status";

type TxClient = Prisma.TransactionClient;

/**
 * T8b: source-dated back-fill of status history from the TeamUp import ledger.
 *
 * Every imported member's MemberStatusEvent history starts with one create
 * event on the import day (3 Oct 2026 for Total BJJ), so nothing built on
 * events can show the club before then. `ImportedMembership` keeps every
 * TeamUp membership row with its own dates; this module turns those rows into
 * dated transitions that sit BEFORE the member's first existing event.
 *
 * Rules (ticket T8b, owner decisions Q6 of 17 Oct 2026):
 * - Only ledger rows with a member (`memberId` set, disposition
 *   member_history) count. A member's rows come from ONE import job: the job
 *   that created the member (`Member.importJobId`) when it holds rows for
 *   them, otherwise the most recent job that does. Rows from other jobs are
 *   counted, never merged (a second export of the same rows would double).
 * - Each row is an interval. Start: its Start Date, at midnight in the club's
 *   timezone. End, by TeamUp status:
 *     current / held entitlement      open (still live at the export)
 *     cancelled                       Cancelled Date -> cancelled
 *     completed                       Completed At (else Cancelled Date) ->
 *                                     inactive for a prepaid course
 *                                     ("Completed course", B-2), else cancelled
 *     upgraded / downgraded           Expiry Date (else Cancelled Date) -> cancelled
 *     active / hold, expired          Expiry Date -> inactive if prepaid, else cancelled
 *     anything else                   exception unknown_status
 *   An end on or after the member's first event is treated as open: the
 *   import-day event already records what happened next.
 * - Rows are merged into periods of continuous membership. The next row
 *   continues a period when it starts no later than the day after the
 *   period's end (TeamUp's Expiry Date is the last day covered: an upgrade
 *   that ends 13 Jan and a plan that starts 14 Jan is no exit). A later start
 *   is a gap: an exit at the end, a re-entry ("rejoin") at the next start.
 * - A scheduled row (future start), and any row starting on or after the
 *   member's first event, is left out and counted.
 * - Never invent a date. A row with no Start Date, or an ending that has no
 *   date where the period's end or continuity depends on it, makes the whole
 *   member an exception: emitting the start alone would show them active up
 *   to the import day, and bridging the gap would invent continuity. An end
 *   dated before its own start is an exception too.
 * - Erased members (sentinel email deleted-*@deleted.invalid) get no events
 *   and are reported as exceptions by ledger row id only.
 * - occurredAt is strictly increasing per member (a same-day start and end are
 *   1 ms apart so the replay order is the ledger's), and every transition is
 *   strictly earlier than the member's first existing event.
 *
 * Writes go through `recordStatusEventsBulk(..., { placement: "before-first" })`
 * with reason `import`, changedById null, `sourceJobId` = the ledger's job and
 * `sourceAction` = `import_backfill` (T8d provenance, A-10). The writer
 * refuses any date not earlier than the member's first event, which rolls the
 * club's transaction back. Idempotency: a club that already has any
 * import_backfill event is "already applied" and gets no rows. Rollback
 * deletes exactly the import_backfill events: import-day, refresh and staff
 * events are never touched.
 *
 * Personal data: the plan and every report carry ids and counts only, never a
 * name, email or plan label.
 */

export const STATUS_BACKFILL_SOURCE_ACTION = "import_backfill" as const;
// Audit action names. Not yet in lib/audit-labels.ts (that file collides with
// PR #29; the Activity page humanises an unlabelled action meanwhile). Add the
// two labels once #29 has merged.
export const STATUS_BACKFILL_AUDIT_ACTION = "member.status_history.backfill";
export const STATUS_BACKFILL_ROLLBACK_AUDIT_ACTION = "member.status_history.backfill_rollback";

const ERASED_EMAIL = /^deleted-.*@deleted\.invalid$/i;
const DAY_MS = 86_400_000;
const LIVE_ENTITLEMENTS = new Set(["current", "held"]);
const COUNTED_ENTITLEMENTS = new Set(["current", "held", "history"]);

export interface BackfillLedgerRow {
  id: string;
  memberId: string;
  importJobId: string;
  type: string;
  status: string;
  entitlement: string;
  startDate: Date | null;
  expiryDate: Date | null;
  cancelledDate: Date | null;
  completedAt: Date | null;
}

export type BackfillStatus = "active" | "cancelled" | "inactive";
export type BackfillKind = "start" | "rejoin" | "cancelled" | "completed_course";
export const BACKFILL_KINDS: readonly BackfillKind[] = ["start", "rejoin", "cancelled", "completed_course"];

export interface BackfillTransition {
  fromStatus: BackfillStatus | null;
  toStatus: BackfillStatus;
  occurredAt: Date;
  kind: BackfillKind;
  ledgerRowId: string;
}

export type BackfillExceptionKind = "erased_member" | "undated_start" | "undated_end" | "end_before_start" | "unknown_status";
export const BACKFILL_EXCEPTION_KINDS: readonly BackfillExceptionKind[] = [
  "erased_member",
  "undated_start",
  "undated_end",
  "end_before_start",
  "unknown_status",
];

export interface BackfillException {
  kind: BackfillExceptionKind;
  /** The ledger rows behind the exception. Ids only: no names, emails or plan labels. */
  ledgerRowIds: string[];
}

export interface MemberDerivation {
  transitions: BackfillTransition[];
  exception: BackfillException | null;
  /** Rows left out: scheduled, or starting on or after the member's first event. */
  excludedRowIds: string[];
}

// ── Club-calendar helpers ────────────────────────────────────────────────────

/** Midnight, in the club's timezone, of a date-only ledger value (stored as UTC midnight). */
export function clubMidnight(date: Date, timeZone: string): Date {
  return parseTime("00:00", date, timeZone);
}

function localMs(at: Date, timeZone: string): number {
  return at.getTime() + zoneOffsetMs(at, timeZone);
}

/** The club-calendar day number of an instant (days since 1970-01-01 in the club's zone). */
export function clubDayIndex(at: Date, timeZone: string): number {
  return Math.floor(localMs(at, timeZone) / DAY_MS);
}

/** "YYYY-MM" of an instant in the club's timezone. */
export function clubMonthKey(at: Date, timeZone: string): string {
  return new Date(localMs(at, timeZone)).toISOString().slice(0, 7);
}

// ── Pure derivation ──────────────────────────────────────────────────────────

type End =
  | { kind: "open" }
  | { kind: "undated" }
  | { kind: "unknown" }
  | { kind: "dated"; at: Date; toStatus: "cancelled" | "inactive" };

function endOf(row: BackfillLedgerRow, timeZone: string): End {
  if (LIVE_ENTITLEMENTS.has(row.entitlement)) return { kind: "open" };
  const status = row.status.trim().toLowerCase();
  const prepaid = row.type.trim().toLowerCase() === "prepaid";
  const day = (d: Date | null) => (d ? clubMidnight(d, timeZone) : null);
  const dated = (at: Date | null, toStatus: "cancelled" | "inactive"): End =>
    at ? { kind: "dated", at, toStatus } : { kind: "undated" };
  switch (status) {
    case "cancelled":
    case "canceled":
      return dated(day(row.cancelledDate), "cancelled");
    case "completed":
    case "complete":
      return dated(row.completedAt ?? day(row.cancelledDate), prepaid ? "inactive" : "cancelled");
    case "upgraded":
    case "downgraded":
      return dated(day(row.expiryDate) ?? day(row.cancelledDate), "cancelled");
    case "active":
    case "hold":
      // History entitlement on an active/hold row means it had expired by the export.
      return dated(day(row.expiryDate), prepaid ? "inactive" : "cancelled");
    default:
      return { kind: "unknown" };
  }
}

type Item = {
  rowId: string;
  start: Date;
  startDay: number;
  end: End;
};

type Period = {
  start: Date;
  startRowId: string;
  open: boolean;
  end: { at: Date; day: number; toStatus: "cancelled" | "inactive"; rowId: string } | null;
  undatedRowIds: string[];
};

/**
 * Turn ONE member's ledger rows (all from one job) into ordered transitions.
 * `cutoff` is the member's first existing event: every transition is strictly
 * earlier. Pure: no database, no clock.
 */
export function deriveMemberTransitions(
  rows: BackfillLedgerRow[],
  { timeZone, cutoff }: { timeZone: string; cutoff: Date },
): MemberDerivation {
  const excludedRowIds: string[] = [];
  const fail = (kind: BackfillExceptionKind, ids: string[]): MemberDerivation => ({
    transitions: [],
    exception: { kind, ledgerRowIds: [...ids].sort() },
    excludedRowIds,
  });
  const cut = cutoff.getTime();

  const items: Item[] = [];
  for (const row of rows) {
    if (!COUNTED_ENTITLEMENTS.has(row.entitlement)) {
      excludedRowIds.push(row.id);
      continue;
    }
    if (!row.startDate) return fail("undated_start", [row.id]);
    const start = clubMidnight(row.startDate, timeZone);
    if (start.getTime() >= cut) {
      excludedRowIds.push(row.id);
      continue;
    }
    let end = endOf(row, timeZone);
    if (end.kind === "unknown") return fail("unknown_status", [row.id]);
    if (end.kind === "dated" && end.at.getTime() >= cut) end = { kind: "open" };
    if (end.kind === "dated" && end.at.getTime() < start.getTime()) return fail("end_before_start", [row.id]);
    items.push({ rowId: row.id, start, startDay: clubDayIndex(start, timeZone), end });
  }
  items.sort((a, b) => a.start.getTime() - b.start.getTime() || a.rowId.localeCompare(b.rowId));

  const startPeriod = (it: Item): Period => ({
    start: it.start,
    startRowId: it.rowId,
    open: it.end.kind === "open",
    end: it.end.kind === "dated" ? { at: it.end.at, day: clubDayIndex(it.end.at, timeZone), toStatus: it.end.toStatus, rowId: it.rowId } : null,
    undatedRowIds: it.end.kind === "undated" ? [it.rowId] : [],
  });
  const extend = (p: Period, it: Item) => {
    if (it.end.kind === "open") p.open = true;
    else if (it.end.kind === "undated") p.undatedRowIds.push(it.rowId);
    else if (it.end.kind === "dated" && (!p.end || it.end.at.getTime() > p.end.at.getTime())) {
      p.end = { at: it.end.at, day: clubDayIndex(it.end.at, timeZone), toStatus: it.end.toStatus, rowId: it.rowId };
    }
  };

  const periods: Period[] = [];
  let p: Period | null = null;
  for (const it of items) {
    if (!p) {
      p = startPeriod(it);
      continue;
    }
    if (p.open) continue; // live to the cutoff: everything later is inside it
    const continuous = p.end !== null && it.startDay <= p.end.day + 1;
    if (continuous) {
      extend(p, it);
    } else if (p.undatedRowIds.length > 0) {
      // Whether this row continues the period depends on an end with no date.
      return fail("undated_end", p.undatedRowIds);
    } else {
      periods.push(p);
      p = startPeriod(it);
    }
  }
  if (p) {
    if (!p.open && p.undatedRowIds.length > 0) return fail("undated_end", p.undatedRowIds);
    periods.push(p);
  }

  const transitions: BackfillTransition[] = [];
  let prevStatus: BackfillStatus | null = null;
  let prevAt = Number.NEGATIVE_INFINITY;
  const emit = (toStatus: BackfillStatus, at: Date, kind: BackfillKind, ledgerRowId: string): boolean => {
    const t = Math.max(at.getTime(), prevAt + 1);
    if (t >= cut) return false;
    transitions.push({ fromStatus: prevStatus, toStatus, occurredAt: new Date(t), kind, ledgerRowId });
    prevStatus = toStatus;
    prevAt = t;
    return true;
  };
  for (const period of periods) {
    if (!emit("active", period.start, prevStatus === null ? "start" : "rejoin", period.startRowId)) break;
    if (period.open || !period.end) continue;
    const kind: BackfillKind = period.end.toStatus === "inactive" ? "completed_course" : "cancelled";
    if (!emit(period.end.toStatus, period.end.at, kind, period.end.rowId)) break;
  }
  return { transitions, exception: null, excludedRowIds };
}

// ── Per-club plan (reads only) ───────────────────────────────────────────────

export type BackfillEventInput = RecordStatusEventInput & { occurredAt: Date; sourceJobId: string; sourceAction: typeof STATUS_BACKFILL_SOURCE_ACTION };

export interface TenantBackfillPlan {
  tenantId: string;
  timeZone: string;
  /** Back-filled events already on record for this club (a second run writes nothing). */
  existingBackfillEvents: number;
  alreadyApplied: boolean;
  ledgerRows: number;
  membersWithLedger: number;
  /** Members that get at least one event. */
  membersPlanned: number;
  /** Members whose ledger spans more than one import job (only one job's rows are used). */
  membersOnSeveralJobs: number;
  /** Ledger rows ignored because they belong to another job than the one chosen for the member. */
  rowsFromOtherJobs: number;
  /** Rows left out: scheduled, or starting on or after the member's first event. */
  excludedRows: number;
  /** The events apply would write, in writer order (strictly increasing per member). */
  inputs: BackfillEventInput[];
  /** Proposed events per club month ("YYYY-MM") and kind. */
  byMonth: Record<string, Record<BackfillKind, number>>;
  /** One entry per member skipped, by ledger row id. */
  exceptions: BackfillException[];
  exceptionCounts: Record<BackfillExceptionKind, number>;
}

function emptyKinds(): Record<BackfillKind, number> {
  return { start: 0, rejoin: 0, cancelled: 0, completed_course: 0 };
}

export async function planTenantBackfill(tx: TxClient, tenantId: string): Promise<TenantBackfillPlan> {
  if (!tenantId) throw new Error("planTenantBackfill requires a tenantId");
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  const timeZone = usableTimezone(tenant?.timezone);

  const existingBackfillEvents = await tx.memberStatusEvent.count({
    where: { tenantId, sourceAction: STATUS_BACKFILL_SOURCE_ACTION },
  });

  const ledger = await tx.importedMembership.findMany({
    where: { tenantId, memberId: { not: null }, disposition: "member_history" },
    select: {
      id: true,
      memberId: true,
      importJobId: true,
      type: true,
      status: true,
      entitlement: true,
      startDate: true,
      expiryDate: true,
      cancelledDate: true,
      completedAt: true,
    },
    orderBy: [{ memberId: "asc" }, { sourceRow: "asc" }],
  });
  const rows = ledger.filter((r): r is typeof r & { memberId: string } => !!r.memberId);
  const memberIds = [...new Set(rows.map((r) => r.memberId))];
  const jobIds = [...new Set(rows.map((r) => r.importJobId))];

  // Sequential, not Promise.all: one interactive transaction is one connection.
  const members = memberIds.length
    ? await tx.member.findMany({
        where: { tenantId, id: { in: memberIds } },
        select: { id: true, email: true, importJobId: true },
      })
    : [];
  const jobs = jobIds.length
    ? await tx.importJob.findMany({ where: { tenantId, id: { in: jobIds } }, select: { id: true, createdAt: true } })
    : [];
  const firstEvents = memberIds.length
    ? await tx.memberStatusEvent.groupBy({
        by: ["memberId"],
        where: { tenantId, memberId: { in: memberIds } },
        _min: { occurredAt: true },
      })
    : [];
  const memberById = new Map(members.map((m) => [m.id, m]));
  const jobCreated = new Map(jobs.map((j) => [j.id, j.createdAt.getTime()]));
  const firstAt = new Map<string, Date>();
  for (const f of firstEvents) if (f._min.occurredAt) firstAt.set(f.memberId, f._min.occurredAt);

  const rowsByMember = new Map<string, BackfillLedgerRow[]>();
  for (const r of rows) {
    const list = rowsByMember.get(r.memberId) ?? [];
    list.push(r as BackfillLedgerRow);
    rowsByMember.set(r.memberId, list);
  }

  const plan: TenantBackfillPlan = {
    tenantId,
    timeZone,
    existingBackfillEvents,
    alreadyApplied: existingBackfillEvents > 0,
    ledgerRows: rows.length,
    membersWithLedger: rowsByMember.size,
    membersPlanned: 0,
    membersOnSeveralJobs: 0,
    rowsFromOtherJobs: 0,
    excludedRows: 0,
    inputs: [],
    byMonth: {},
    exceptions: [],
    exceptionCounts: { erased_member: 0, undated_start: 0, undated_end: 0, end_before_start: 0, unknown_status: 0 },
  };
  const except = (e: BackfillException) => {
    plan.exceptions.push(e);
    plan.exceptionCounts[e.kind] += 1;
  };

  for (const memberId of [...rowsByMember.keys()].sort()) {
    const member = memberById.get(memberId);
    const all = rowsByMember.get(memberId)!;
    if (!member) continue; // not visible in this club: nothing to write against
    if (ERASED_EMAIL.test(member.email)) {
      except({ kind: "erased_member", ledgerRowIds: all.map((r) => r.id).sort() });
      continue;
    }
    const memberJobs = [...new Set(all.map((r) => r.importJobId))];
    let jobId = memberJobs[0];
    if (memberJobs.length > 1) {
      plan.membersOnSeveralJobs += 1;
      jobId =
        member.importJobId && memberJobs.includes(member.importJobId)
          ? member.importJobId
          : [...memberJobs].sort((a, b) => (jobCreated.get(b) ?? 0) - (jobCreated.get(a) ?? 0) || b.localeCompare(a))[0];
    }
    const own = all.filter((r) => r.importJobId === jobId);
    plan.rowsFromOtherJobs += all.length - own.length;

    // The member's first event; with none on record (not expected for an
    // imported member), the moment the job that holds their ledger was created.
    const jobAt = jobCreated.get(jobId);
    const cutoff = firstAt.get(memberId) ?? (jobAt !== undefined ? new Date(jobAt) : null);
    if (!cutoff) continue;
    const d = deriveMemberTransitions(own, { timeZone, cutoff });
    plan.excludedRows += d.excludedRowIds.length;
    if (d.exception) {
      except(d.exception);
      continue;
    }
    if (d.transitions.length === 0) continue;
    plan.membersPlanned += 1;
    for (const t of d.transitions) {
      plan.inputs.push({
        tenantId,
        memberId,
        fromStatus: t.fromStatus,
        toStatus: t.toStatus,
        reason: "import",
        changedById: null,
        occurredAt: t.occurredAt,
        sourceJobId: jobId,
        sourceAction: STATUS_BACKFILL_SOURCE_ACTION,
      });
      const month = clubMonthKey(t.occurredAt, timeZone);
      plan.byMonth[month] ??= emptyKinds();
      plan.byMonth[month][t.kind] += 1;
    }
  }
  return plan;
}

/** Proposed or written events per month, all kinds together: what the after-apply detection compares. */
export function monthTotals(byMonth: Record<string, Record<BackfillKind, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [month, kinds] of Object.entries(byMonth)) out[month] = BACKFILL_KINDS.reduce((s, k) => s + kinds[k], 0);
  return out;
}

// ── Apply and rollback (one club, inside the caller's withTenantContext) ─────

async function lockClub(tx: TxClient, tenantId: string) {
  // Two runs for one club serialise here, so the "already applied" check below
  // cannot be raced into a double write. Released when the transaction ends.
  const key = `t8b-status-backfill:${tenantId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

export type ApplyBackfillResult =
  | { status: "already_applied"; tenantId: string; written: 0; existingBackfillEvents: number; plan: TenantBackfillPlan }
  | { status: "nothing_to_do"; tenantId: string; written: 0; plan: TenantBackfillPlan }
  | { status: "applied"; tenantId: string; written: number; plan: TenantBackfillPlan };

/**
 * Write the club's back-fill. Runs inside the caller's `withTenantContext`
 * transaction: any refusal (the writer's before-first check) or failure rolls
 * back every row for this club, and the AuditLog row with them.
 */
export async function applyTenantBackfill(
  tx: TxClient,
  tenantId: string,
  { runId }: { runId: string },
): Promise<ApplyBackfillResult> {
  if (!tenantId) throw new Error("applyTenantBackfill requires a tenantId");
  if (!runId) throw new Error("applyTenantBackfill requires a runId");
  await lockClub(tx, tenantId);
  const plan = await planTenantBackfill(tx, tenantId);
  if (plan.alreadyApplied) {
    return { status: "already_applied", tenantId, written: 0, existingBackfillEvents: plan.existingBackfillEvents, plan };
  }
  if (plan.inputs.length === 0) return { status: "nothing_to_do", tenantId, written: 0, plan };

  const written = await recordStatusEventsBulk(tx, plan.inputs, { placement: "before-first" });
  if (written !== plan.inputs.length) {
    throw new Error(`[status-backfill] wrote ${written} of ${plan.inputs.length} planned events for club ${tenantId}; rolled back`);
  }
  await tx.auditLog.create({
    data: {
      tenantId,
      userId: null,
      action: STATUS_BACKFILL_AUDIT_ACTION,
      entityType: "Tenant",
      entityId: tenantId,
      metadata: {
        runId,
        ranAt: new Date().toISOString(),
        written,
        membersPlanned: plan.membersPlanned,
        excludedRows: plan.excludedRows,
        exceptions: plan.exceptions.length,
        exceptionCounts: plan.exceptionCounts,
        byMonth: monthTotals(plan.byMonth),
      },
    },
  });
  return { status: "applied", tenantId, written, plan };
}

/**
 * Remove exactly the club's back-filled events (sourceAction import_backfill).
 * Import-day, refresh, rollback and staff events are never matched.
 */
export async function rollbackTenantBackfill(
  tx: TxClient,
  tenantId: string,
  { runId }: { runId: string },
): Promise<{ tenantId: string; removed: number }> {
  if (!tenantId) throw new Error("rollbackTenantBackfill requires a tenantId");
  if (!runId) throw new Error("rollbackTenantBackfill requires a runId");
  await lockClub(tx, tenantId);
  const res = await tx.memberStatusEvent.deleteMany({
    where: { tenantId, reason: "import", sourceAction: STATUS_BACKFILL_SOURCE_ACTION },
  });
  if (res.count > 0) {
    await tx.auditLog.create({
      data: {
        tenantId,
        userId: null,
        action: STATUS_BACKFILL_ROLLBACK_AUDIT_ACTION,
        entityType: "Tenant",
        entityId: tenantId,
        metadata: { runId, ranAt: new Date().toISOString(), removed: res.count },
      },
    });
  }
  return { tenantId, removed: res.count };
}

// ── Detection (ticket T8b, Data impact) ──────────────────────────────────────

export interface BackfillDetection {
  /** Back-filled events on record per club month. After apply this must equal the preview's monthTotals. */
  byMonth: Record<string, number>;
  /** (member, occurredAt, toStatus) written more than once by the back-fill. Expected 0. */
  duplicates: number;
  /** Members whose latest event's toStatus differs from Member.status. Must not change across apply. */
  latestEventMismatches: number;
}

export async function detectBackfill(tx: TxClient, tenantId: string, timeZone: string): Promise<BackfillDetection> {
  const events = await tx.memberStatusEvent.findMany({
    where: { tenantId, sourceAction: STATUS_BACKFILL_SOURCE_ACTION },
    select: { memberId: true, occurredAt: true, toStatus: true },
  });
  const byMonth: Record<string, number> = {};
  const seen = new Map<string, number>();
  for (const e of events) {
    const m = clubMonthKey(e.occurredAt, timeZone);
    byMonth[m] = (byMonth[m] ?? 0) + 1;
    const k = `${e.memberId}|${e.occurredAt.toISOString()}|${e.toStatus}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const duplicates = [...seen.values()].filter((n) => n > 1).length;
  const [mismatch] = await tx.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM "Member" m
    JOIN LATERAL (
      SELECT e."toStatus" FROM "MemberStatusEvent" e
      WHERE e."tenantId" = m."tenantId" AND e."memberId" = m.id
      ORDER BY e."occurredAt" DESC, e."createdAt" DESC, e.id DESC
      LIMIT 1
    ) l ON true
    WHERE m."tenantId" = ${tenantId} AND l."toStatus" <> m.status`;
  return { byMonth, duplicates, latestEventMismatches: Number(mismatch?.n ?? 0) };
}
