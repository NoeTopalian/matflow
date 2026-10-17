/**
 * T8b (17 Oct 2026): source-dated back-fill of status history from the TeamUp
 * import ledger. No database: the derivation is pure, and the plan / apply /
 * rollback run against an in-memory fake transaction. The same flows on a real
 * database are in tests/integration/t8b-status-backfill-db.test.ts.
 *
 *   1. Interval derivation table (ticket Tests, Unit).
 *   2. The writer's before-first placement (acceptance 7).
 *   3. Plan, apply, re-apply, rollback, erased members, two clubs
 *      (acceptances 1 to 6).
 *   4. The sourceAction CHECK admits import_backfill (folded into T8d's migration).
 *   5. The script's target guard refuses production.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  applyTenantBackfill,
  clubMidnight,
  clubMonthKey,
  deriveMemberTransitions,
  monthDelta,
  monthTotals,
  planTenantBackfill,
  rollbackTenantBackfill,
  STATUS_BACKFILL_AUDIT_ACTION,
  STATUS_BACKFILL_ROLLBACK_AUDIT_ACTION,
  type BackfillLedgerRow,
  type BackfillTransition,
} from "@/lib/status-backfill";
import {
  MEMBER_STATUS_EVENT_SOURCE_ACTIONS,
  recordStatusEvent,
  recordStatusEventsBulk,
  StatusEventPlacementRefused,
} from "@/lib/member-status";
import { backfillMode, backfillTarget } from "../../scripts/backfill-status-events-guard.mjs";

const TZ = "Europe/London";
const IMPORT_DAY = new Date("2026-10-03T11:39:57.000Z");
const D = (s: string) => new Date(`${s}T00:00:00.000Z`); // a @db.Date value as Prisma returns it

let seq = 0;
function row(o: Partial<BackfillLedgerRow> & { status: string }): BackfillLedgerRow {
  seq += 1;
  return {
    id: o.id ?? `r${String(seq).padStart(3, "0")}`,
    memberId: o.memberId ?? "m1",
    importJobId: o.importJobId ?? "job1",
    type: o.type ?? "recurring",
    status: o.status,
    entitlement: o.entitlement ?? (o.status === "active" || o.status === "hold" ? "current" : "history"),
    startDate: o.startDate === undefined ? D("2025-01-01") : o.startDate,
    expiryDate: o.expiryDate ?? null,
    cancelledDate: o.cancelledDate ?? null,
    completedAt: o.completedAt ?? null,
  };
}
const derive = (rows: BackfillLedgerRow[], cutoff = IMPORT_DAY) => deriveMemberTransitions(rows, { timeZone: TZ, cutoff });
const shape = (ts: BackfillTransition[]) => ts.map((t) => `${t.fromStatus ?? "null"}>${t.toStatus}@${t.occurredAt.toISOString()}:${t.kind}`);

/** Replay: the status on `at` from back-filled transitions, then any later events. */
function statusOn(events: Array<{ toStatus: string; occurredAt: Date }>, at: Date): string | null {
  let s: string | null = null;
  for (const e of [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) if (e.occurredAt <= at) s = e.toStatus;
  return s;
}

// ── 1. Derivation table ──────────────────────────────────────────────────────

describe("T8b derivation: ledger rows to transitions", () => {
  it("a single current row: one start at club midnight (GMT date)", () => {
    const d = derive([row({ status: "active", startDate: D("2025-01-10") })]);
    expect(d.exception).toBeNull();
    expect(shape(d.transitions)).toEqual(["null>active@2025-01-10T00:00:00.000Z:start"]);
  });

  it("a start in British Summer Time is midnight London, i.e. 23:00 UTC the day before", () => {
    const d = derive([row({ status: "active", startDate: D("2025-07-01") })]);
    expect(d.transitions[0].occurredAt.toISOString()).toBe("2025-06-30T23:00:00.000Z");
    expect(clubMonthKey(d.transitions[0].occurredAt, TZ)).toBe("2025-07");
  });

  it("cancelled with a Cancelled Date: start, then cancelled on that date", () => {
    const d = derive([row({ status: "cancelled", startDate: D("2025-01-10"), cancelledDate: D("2025-03-31") })]);
    expect(shape(d.transitions)).toEqual([
      "null>active@2025-01-10T00:00:00.000Z:start",
      "active>cancelled@2025-03-30T23:00:00.000Z:cancelled",
    ]);
  });

  it("cancelled WITHOUT a Cancelled Date: an exception, and no end event is invented (acceptance 4)", () => {
    const r = row({ status: "cancelled", startDate: D("2025-01-10") });
    const d = derive([r]);
    expect(d.transitions).toEqual([]);
    expect(d.exception).toEqual({ kind: "undated_end", ledgerRowIds: [r.id] });
  });

  it("a completed prepaid course: inactive at Completed At, labelled completed_course", () => {
    const d = derive([
      row({ status: "completed", type: "prepaid", startDate: D("2025-01-16"), expiryDate: D("2025-07-24"), completedAt: new Date("2025-07-25T00:01:35.000Z") }),
    ]);
    expect(shape(d.transitions)).toEqual([
      "null>active@2025-01-16T00:00:00.000Z:start",
      "active>inactive@2025-07-25T00:01:35.000Z:completed_course",
    ]);
  });

  it("an upgrade followed the next day by the new plan: no exit (adjacency)", () => {
    const d = derive([
      row({ status: "upgraded", startDate: D("2025-11-01"), expiryDate: D("2026-01-13") }),
      row({ status: "active", startDate: D("2026-01-14") }),
    ]);
    expect(shape(d.transitions)).toEqual(["null>active@2025-11-01T00:00:00.000Z:start"]);
  });

  it("an upgrade overlapping the new plan: no exit", () => {
    const d = derive([
      row({ status: "downgraded", startDate: D("2025-11-01"), expiryDate: D("2026-01-20") }),
      row({ status: "cancelled", startDate: D("2026-01-14"), cancelledDate: D("2026-05-01") }),
    ]);
    expect(d.transitions.map((t) => t.kind)).toEqual(["start", "cancelled"]);
    expect(d.transitions[1].occurredAt.toISOString()).toBe("2026-04-30T23:00:00.000Z");
  });

  it("a gap and a rejoin (acceptance 1): active 1 Mar, cancelled 15 Jul, active 1 Oct 2025", () => {
    const d = derive([
      row({ status: "cancelled", startDate: D("2025-01-10"), cancelledDate: D("2025-06-30") }),
      row({ status: "active", startDate: D("2025-09-01") }),
    ]);
    expect(d.transitions.map((t) => t.kind)).toEqual(["start", "cancelled", "rejoin"]);
    expect(d.transitions[2].fromStatus).toBe("cancelled");
    const importDay = { toStatus: "active", occurredAt: IMPORT_DAY };
    const all = [...d.transitions, importDay];
    expect(statusOn(all, new Date("2025-03-01T12:00:00Z"))).toBe("active");
    expect(statusOn(all, new Date("2025-07-15T12:00:00Z"))).toBe("cancelled");
    expect(statusOn(all, new Date("2025-10-01T12:00:00Z"))).toBe("active");
  });

  it("a scheduled future start is left out and counted", () => {
    const cur = row({ status: "active", startDate: D("2025-05-01") });
    const sched = row({ status: "active", entitlement: "scheduled", startDate: D("2026-11-01") });
    const d = derive([cur, sched]);
    expect(d.transitions.map((t) => t.kind)).toEqual(["start"]);
    expect(d.excludedRowIds).toEqual([sched.id]);
  });

  it("a held row beside an active one: still one continuous membership", () => {
    const d = derive([
      row({ status: "active", startDate: D("2025-02-01") }),
      row({ status: "hold", entitlement: "held", startDate: D("2025-06-01") }),
    ]);
    expect(d.transitions.map((t) => t.kind)).toEqual(["start"]);
  });

  it("a same-day start and cancellation stay strictly ordered (1 ms apart)", () => {
    const d = derive([row({ status: "cancelled", startDate: D("2025-02-03"), cancelledDate: D("2025-02-03") })]);
    expect(d.transitions[1].occurredAt.getTime() - d.transitions[0].occurredAt.getTime()).toBe(1);
  });

  it("an end on or after the member's first event is treated as still live", () => {
    const d = derive([row({ status: "cancelled", startDate: D("2025-02-03"), cancelledDate: D("2026-10-10") })]);
    expect(d.transitions.map((t) => t.kind)).toEqual(["start"]);
  });

  it("every transition is strictly earlier than the cutoff and strictly increasing", () => {
    // Exactly midnight London (BST) on 1 Sep: a start AT the cutoff is left out.
    const cutoff = new Date("2025-08-31T23:00:00Z");
    const d = derive(
      [
        row({ status: "cancelled", startDate: D("2025-01-10"), cancelledDate: D("2025-06-30") }),
        row({ status: "active", startDate: D("2025-09-01") }),
      ],
      cutoff,
    );
    expect(d.transitions.map((t) => t.kind)).toEqual(["start", "cancelled"]);
    expect(d.excludedRowIds).toHaveLength(1);
    for (let i = 0; i < d.transitions.length; i += 1) {
      expect(d.transitions[i].occurredAt.getTime()).toBeLessThan(cutoff.getTime());
      if (i > 0) expect(d.transitions[i].occurredAt.getTime()).toBeGreaterThan(d.transitions[i - 1].occurredAt.getTime());
    }
  });

  it("an undated ending that a known continuity makes irrelevant does not block the member", () => {
    const d = derive([
      row({ status: "cancelled", startDate: D("2025-01-01"), cancelledDate: D("2025-06-30") }),
      row({ status: "cancelled", startDate: D("2025-03-01") }), // undated, inside the period
      row({ status: "active", startDate: D("2025-07-01") }), // starts the day after the known end
    ]);
    expect(d.exception).toBeNull();
    expect(d.transitions.map((t) => t.kind)).toEqual(["start"]);
  });

  it("an undated ending that decides whether there was a gap: the whole member is an exception", () => {
    const u = row({ status: "cancelled", startDate: D("2024-01-01") });
    const d = derive([u, row({ status: "active", startDate: D("2025-07-01") })]);
    expect(d.transitions).toEqual([]);
    expect(d.exception).toEqual({ kind: "undated_end", ledgerRowIds: [u.id] });
  });

  it("no Start Date, an unknown status, or an end before its start: exception, no events", () => {
    expect(derive([row({ status: "active", startDate: null })]).exception?.kind).toBe("undated_start");
    expect(derive([row({ status: "pending" })]).exception?.kind).toBe("unknown_status");
    expect(derive([row({ status: "cancelled", startDate: D("2025-05-01"), cancelledDate: D("2025-04-01") })]).exception?.kind).toBe("end_before_start");
  });

  it("an expired active row ends at its Expiry Date (prepaid: inactive)", () => {
    const d = derive([row({ status: "active", entitlement: "history", type: "prepaid", startDate: D("2025-01-06"), expiryDate: D("2025-03-02") })]);
    expect(shape(d.transitions)).toEqual([
      "null>active@2025-01-06T00:00:00.000Z:start",
      "active>inactive@2025-03-02T00:00:00.000Z:completed_course",
    ]);
  });

  it("clubMidnight reads a date-only value in the club zone", () => {
    expect(clubMidnight(D("2025-01-10"), TZ).toISOString()).toBe("2025-01-10T00:00:00.000Z");
    expect(clubMidnight(D("2025-01-10"), "Asia/Makassar").toISOString()).toBe("2025-01-09T16:00:00.000Z");
  });
});

// ── 2. Writer: before-first placement ────────────────────────────────────────

function writerTx(firstAt: Date | null) {
  const createMany = vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length }));
  const groupBy = vi.fn(async () => (firstAt ? [{ tenantId: "t1", memberId: "m1", _min: { occurredAt: firstAt } }] : []));
  const create = vi.fn(async () => ({ id: "e1" }));
  return { tx: { memberStatusEvent: { createMany, groupBy, create, findFirst: vi.fn(async () => null) } } as never, createMany, groupBy, create };
}
const bf = (occurredAt: Date, fromStatus: string | null = null, toStatus = "active") => ({
  tenantId: "t1",
  memberId: "m1",
  fromStatus,
  toStatus,
  reason: "import" as const,
  changedById: null,
  occurredAt,
  sourceJobId: "job1",
  sourceAction: "import_backfill" as const,
});

describe("T8b writer: placement before-first", () => {
  it("writes the supplied dates unchanged (no clamp) when all are earlier than the first event", async () => {
    const h = writerTx(IMPORT_DAY);
    const a = new Date("2025-01-10T00:00:00Z");
    const b = new Date("2025-06-30T23:00:00Z");
    const n = await recordStatusEventsBulk(h.tx, [bf(a), bf(b, "active", "cancelled")], { placement: "before-first" });
    expect(n).toBe(2);
    const data = h.createMany.mock.calls[0][0].data as Array<Record<string, unknown>>;
    expect(data.map((d) => d.occurredAt)).toEqual([a, b]);
    expect(data[0]).toMatchObject({ reason: "import", changedById: null, sourceJobId: "job1", sourceAction: "import_backfill" });
  });

  it("refuses a date not earlier than the member's first event, and writes nothing (acceptance 7)", async () => {
    const h = writerTx(IMPORT_DAY);
    await expect(recordStatusEventsBulk(h.tx, [bf(new Date(IMPORT_DAY))], { placement: "before-first" })).rejects.toBeInstanceOf(StatusEventPlacementRefused);
    await expect(recordStatusEventsBulk(h.tx, [bf(new Date("2026-10-05T00:00:00Z"))], { placement: "before-first" })).rejects.toThrow(/first event/);
    expect(h.createMany).not.toHaveBeenCalled();
  });

  it("refuses dates that are not strictly increasing per member, or missing", async () => {
    const h = writerTx(IMPORT_DAY);
    const t = new Date("2025-01-10T00:00:00Z");
    await expect(recordStatusEventsBulk(h.tx, [bf(t), bf(new Date(t), "active", "cancelled")], { placement: "before-first" })).rejects.toThrow(/strictly increasing/);
    const noDate = { ...bf(t), occurredAt: undefined };
    await expect(recordStatusEventsBulk(h.tx, [noDate as never], { placement: "before-first" })).rejects.toThrow(/valid occurredAt/);
    expect(h.createMany).not.toHaveBeenCalled();
  });

  it("before-first is for import_backfill only, and import_backfill only goes before-first", async () => {
    const h = writerTx(null);
    const t = new Date("2025-01-10T00:00:00Z");
    await expect(
      recordStatusEventsBulk(h.tx, [{ ...bf(t), sourceAction: "import_create" as const }], { placement: "before-first" }),
    ).rejects.toBeInstanceOf(StatusEventPlacementRefused);
    await expect(recordStatusEventsBulk(h.tx, [bf(t)])).rejects.toBeInstanceOf(StatusEventPlacementRefused);
    await expect(recordStatusEvent(h.tx, bf(t))).rejects.toBeInstanceOf(StatusEventPlacementRefused);
    expect(h.createMany).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("a member with no events yet accepts any increasing dates", async () => {
    const h = writerTx(null);
    expect(await recordStatusEventsBulk(h.tx, [bf(new Date("2025-01-10T00:00:00Z"))], { placement: "before-first" })).toBe(1);
  });

  it("the writer's source-action list carries import_backfill", () => {
    expect([...MEMBER_STATUS_EVENT_SOURCE_ACTIONS]).toEqual(["import_create", "import_refresh", "import_rollback", "import_backfill"]);
  });
});

// ── 3. Plan / apply / rollback against an in-memory club ─────────────────────

type Rec = Record<string, unknown> & { id: string };
type Db = { tenants: Rec[]; members: Rec[]; jobs: Rec[]; ledger: Rec[]; events: Rec[]; audit: Rec[] };

function matches(r: Rec, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    const val = r[k] ?? null;
    if (v === null) return val === null;
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const op = v as { not?: unknown; in?: unknown[] };
      if ("in" in op) return (op.in ?? []).includes(val);
      if ("not" in op) return op.not === null ? val !== null : val !== op.not;
    }
    return val === v;
  });
}

function fakeTx(db: Db) {
  let n = 0;
  const pick = (r: Rec, select?: Record<string, boolean>) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k] ?? null])) : r);
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    tenant: { findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
      const t = db.tenants.find((x) => x.id === where.id);
      return t ? pick(t, select) : null;
    } },
    member: { findMany: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => db.members.filter((m) => matches(m, where)).map((m) => pick(m, select)) },
    importJob: { findMany: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => db.jobs.filter((j) => matches(j, where)).map((j) => pick(j, select)) },
    importedMembership: {
      findMany: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) =>
        db.ledger.filter((l) => matches(l, where)).sort((a, b) => String(a.memberId).localeCompare(String(b.memberId)) || Number(a.sourceRow) - Number(b.sourceRow)).map((l) => pick(l, select)),
    },
    memberStatusEvent: {
      count: async ({ where }: { where: Record<string, unknown> }) => db.events.filter((e) => matches(e, where)).length,
      findMany: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => db.events.filter((e) => matches(e, where)).map((e) => pick(e, select)),
      groupBy: async ({ by, where }: { by: string[]; where: Record<string, unknown> }) => {
        const groups = new Map<string, Rec[]>();
        for (const e of db.events.filter((x) => matches(x, where))) {
          const k = by.map((b) => e[b]).join("|");
          groups.set(k, [...(groups.get(k) ?? []), e]);
        }
        return [...groups.values()].map((es) => ({
          ...Object.fromEntries(by.map((b) => [b, es[0][b]])),
          _min: { occurredAt: new Date(Math.min(...es.map((e) => (e.occurredAt as Date).getTime()))) },
          _count: { _all: es.length },
        }));
      },
      createMany: vi.fn(async ({ data }: { data: Rec[] }) => {
        for (const d of data) db.events.push({ ...d, id: `bf${++n}`, createdAt: new Date() });
        return { count: data.length };
      }),
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const keep = db.events.filter((e) => !matches(e, where));
        const count = db.events.length - keep.length;
        db.events = keep;
        return { count };
      },
    },
    auditLog: { create: vi.fn(async ({ data }: { data: Rec }) => { db.audit.push({ ...data, id: `a${db.audit.length + 1}` }); return data; }) },
  };
  return tx;
}

function club(): Db {
  const L = (o: Rec) => ({ memberId: null, entitlement: "history", type: "recurring", startDate: null, expiryDate: null, cancelledDate: null, completedAt: null, disposition: "member_history", importJobId: "jobA", sourceRow: 2, ...o });
  return {
    tenants: [{ id: "tA", timezone: "Europe/London" }, { id: "tB", timezone: "Europe/London" }],
    jobs: [{ id: "jobA", tenantId: "tA", createdAt: new Date("2026-10-03T11:00:00Z") }, { id: "jobB", tenantId: "tB", createdAt: new Date("2026-10-03T11:00:00Z") }],
    members: [
      { id: "ada", tenantId: "tA", email: "ada@example.test", importJobId: "jobA", createdAt: IMPORT_DAY, status: "active" },
      { id: "tom", tenantId: "tA", email: "tom@example.test", importJobId: "jobA", createdAt: IMPORT_DAY, status: "cancelled" },
      { id: "gone", tenantId: "tA", email: "deleted-gone@deleted.invalid", importJobId: "jobA", createdAt: IMPORT_DAY, status: "cancelled" },
      { id: "noDate", tenantId: "tA", email: "nd@example.test", importJobId: "jobA", createdAt: IMPORT_DAY, status: "cancelled" },
      { id: "bea", tenantId: "tB", email: "bea@example.test", importJobId: "jobB", createdAt: IMPORT_DAY, status: "active" },
    ],
    ledger: [
      L({ id: "lA1", tenantId: "tA", memberId: "ada", status: "cancelled", startDate: D("2025-01-10"), cancelledDate: D("2025-06-30"), sourceRow: 2 }),
      L({ id: "lA2", tenantId: "tA", memberId: "ada", status: "active", entitlement: "current", startDate: D("2025-09-01"), sourceRow: 3 }),
      L({ id: "lA3", tenantId: "tA", memberId: "tom", status: "cancelled", startDate: D("2025-02-03"), cancelledDate: D("2025-12-08"), sourceRow: 4 }),
      L({ id: "lA4", tenantId: "tA", memberId: "gone", status: "cancelled", startDate: D("2024-12-01"), cancelledDate: D("2025-08-22"), sourceRow: 5 }),
      L({ id: "lA5", tenantId: "tA", memberId: "noDate", status: "cancelled", startDate: D("2025-03-01"), sourceRow: 6 }),
      L({ id: "lA6", tenantId: "tA", memberId: null, status: "cancelled", disposition: "excluded:deleted_customer", sourceRow: 7 }),
      L({ id: "lB1", tenantId: "tB", memberId: "bea", importJobId: "jobB", status: "active", entitlement: "current", startDate: D("2024-04-01"), sourceRow: 2 }),
    ],
    events: [
      { id: "ia", tenantId: "tA", memberId: "ada", fromStatus: null, toStatus: "active", reason: "import", occurredAt: IMPORT_DAY, sourceJobId: "jobA", sourceAction: "import_create" },
      { id: "it", tenantId: "tA", memberId: "tom", fromStatus: null, toStatus: "cancelled", reason: "import", occurredAt: IMPORT_DAY, sourceJobId: "jobA", sourceAction: "import_create" },
      { id: "ig", tenantId: "tA", memberId: "gone", fromStatus: null, toStatus: "cancelled", reason: "import", occurredAt: IMPORT_DAY, sourceJobId: null, sourceAction: null },
      { id: "in", tenantId: "tA", memberId: "noDate", fromStatus: null, toStatus: "cancelled", reason: "import", occurredAt: IMPORT_DAY, sourceJobId: "jobA", sourceAction: "import_create" },
      { id: "st", tenantId: "tA", memberId: "ada", fromStatus: "active", toStatus: "active", reason: "staff_edit", occurredAt: new Date("2026-10-10T09:00:00Z"), sourceJobId: null, sourceAction: null },
      { id: "ib", tenantId: "tB", memberId: "bea", fromStatus: null, toStatus: "active", reason: "import", occurredAt: IMPORT_DAY, sourceJobId: "jobB", sourceAction: "import_create" },
    ],
    audit: [],
  };
}

describe("T8b plan, apply, re-apply and rollback (in-memory club)", () => {
  it("preview: per-month counts, exceptions by ledger row id (erased and undated), and no writes", async () => {
    const db = club();
    const tx = fakeTx(db);
    const plan = await planTenantBackfill(tx as never, "tA");
    expect(plan.alreadyApplied).toBe(false);
    expect(plan.membersWithLedger).toBe(4);
    expect(plan.membersPlanned).toBe(2);
    expect(plan.inputs).toHaveLength(5); // ada: start, cancelled, rejoin; tom: start, cancelled
    expect(plan.exceptionCounts).toMatchObject({ erased_member: 1, undated_end: 1 });
    expect(plan.exceptions).toEqual([
      { kind: "erased_member", ledgerRowIds: ["lA4"] },
      { kind: "undated_end", ledgerRowIds: ["lA5"] },
    ]);
    expect(plan.inputs.some((i) => i.memberId === "gone" || i.memberId === "noDate")).toBe(false);
    // Only the undated member counts as "TeamUp history without dates"; the erased one does not.
    expect(plan.undatedMemberIds).toEqual(["noDate"]);
    expect(monthTotals(plan.byMonth)).toEqual({ "2025-01": 1, "2025-02": 1, "2025-06": 1, "2025-09": 1, "2025-12": 1 });
    expect(plan.byMonth["2025-06"]).toMatchObject({ cancelled: 1 });
    expect(plan.byMonth["2025-09"]).toMatchObject({ rejoin: 1 });
    // No personal data in what a preview prints.
    const printed = JSON.stringify({ byMonth: plan.byMonth, exceptions: plan.exceptions, counts: plan.exceptionCounts });
    expect(printed).not.toMatch(/example\.test|deleted\.invalid/);
    expect(tx.memberStatusEvent.createMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("apply writes the planned rows with import provenance, one audit row; history reads true (acceptance 1)", async () => {
    const db = club();
    const tx = fakeTx(db);
    const r = await applyTenantBackfill(tx as never, "tA", { runId: "run-1" });
    expect(r.status).toBe("applied");
    expect(r.written).toBe(5);
    expect(tx.$executeRaw).toHaveBeenCalled(); // the per-club advisory lock
    const ada = db.events.filter((e) => e.memberId === "ada");
    expect(statusOn(ada as never, new Date("2025-03-01T12:00:00Z"))).toBe("active");
    expect(statusOn(ada as never, new Date("2025-07-15T12:00:00Z"))).toBe("cancelled");
    expect(statusOn(ada as never, new Date("2025-10-01T12:00:00Z"))).toBe("active");
    // The import-day event is unchanged.
    expect(db.events.find((e) => e.id === "ia")).toMatchObject({ occurredAt: IMPORT_DAY, sourceAction: "import_create" });
    const written = db.events.filter((e) => e.sourceAction === "import_backfill");
    for (const e of written) expect(e).toMatchObject({ reason: "import", changedById: null, sourceJobId: "jobA", tenantId: "tA" });
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({ tenantId: "tA", action: STATUS_BACKFILL_AUDIT_ACTION, entityType: "Tenant", entityId: "tA" });
    expect((db.audit[0].metadata as Record<string, unknown>)).toMatchObject({ runId: "run-1", written: 5, exceptions: 2 });
  });

  it("a second run writes nothing and reports already applied (acceptance 2)", async () => {
    const db = club();
    await applyTenantBackfill(fakeTx(db) as never, "tA", { runId: "run-1" });
    const before = db.events.length;
    const tx = fakeTx(db);
    const r = await applyTenantBackfill(tx as never, "tA", { runId: "run-2" });
    expect(r).toMatchObject({ status: "already_applied", written: 0, existingBackfillEvents: 5 });
    expect(db.events.length).toBe(before);
    expect(tx.memberStatusEvent.createMany).not.toHaveBeenCalled();
    expect(db.audit).toHaveLength(1);
  });

  it("idempotency is per member: a member from a later create import is back-filled by the next run, nobody twice", async () => {
    const db = club();
    await applyTenantBackfill(fakeTx(db) as never, "tA", { runId: "run-1" });
    const firstRun = db.events.filter((e) => e.sourceAction === "import_backfill").map((e) => e.id).sort();
    // A second TeamUp create import brings in a new member with dated ledger rows.
    const LATER = new Date("2026-10-12T10:00:00Z");
    db.jobs.push({ id: "jobA3", tenantId: "tA", createdAt: LATER });
    db.members.push({ id: "kai", tenantId: "tA", email: "kai@example.test", importJobId: "jobA3", createdAt: LATER, status: "active" });
    db.ledger.push({ id: "lK1", tenantId: "tA", memberId: "kai", importJobId: "jobA3", status: "cancelled", type: "recurring", entitlement: "history", startDate: D("2025-04-01"), cancelledDate: D("2025-08-31"), expiryDate: null, completedAt: null, disposition: "member_history", sourceRow: 2 });
    db.ledger.push({ id: "lK2", tenantId: "tA", memberId: "kai", importJobId: "jobA3", status: "active", type: "recurring", entitlement: "current", startDate: D("2026-01-05"), cancelledDate: null, expiryDate: null, completedAt: null, disposition: "member_history", sourceRow: 3 });
    db.events.push({ id: "ik", tenantId: "tA", memberId: "kai", fromStatus: null, toStatus: "active", reason: "import", occurredAt: LATER, sourceJobId: "jobA3", sourceAction: "import_create" });

    const plan = await planTenantBackfill(fakeTx(db) as never, "tA");
    expect(plan.alreadyApplied).toBe(false);
    expect(plan.membersAlreadyBackfilled).toBe(2); // ada and tom
    expect(plan.inputs.map((i) => i.memberId)).toEqual(["kai", "kai", "kai"]);
    expect(plan.inputs.every((i) => i.sourceJobId === "jobA3")).toBe(true);

    const r = await applyTenantBackfill(fakeTx(db) as never, "tA", { runId: "run-2" });
    expect(r).toMatchObject({ status: "applied", written: 3 });
    const all = db.events.filter((e) => e.sourceAction === "import_backfill");
    expect(all.filter((e) => e.memberId !== "kai").map((e) => e.id).sort()).toEqual(firstRun);
    // A third run has nothing left to write.
    expect((await applyTenantBackfill(fakeTx(db) as never, "tA", { runId: "run-3" })).status).toBe("already_applied");
  });

  it("monthDelta: what one run added, so a later run is checked against its own preview", () => {
    expect(monthDelta({ "2025-01": 3, "2025-04": 1, "2025-09": 2 }, { "2025-01": 3, "2025-09": 1 })).toEqual({ "2025-04": 1, "2025-09": 1 });
    expect(monthDelta({ "2025-01": 2 }, { "2025-01": 2 })).toEqual({});
  });

  it("rollback removes only the back-filled rows; import-day and staff events stay (acceptance 3)", async () => {
    const db = club();
    const original = db.events.map((e) => e.id).sort();
    await applyTenantBackfill(fakeTx(db) as never, "tA", { runId: "run-1" });
    const r = await rollbackTenantBackfill(fakeTx(db) as never, "tA", { runId: "run-1" });
    expect(r.removed).toBe(5);
    expect(db.events.map((e) => e.id).sort()).toEqual(original);
    expect(db.audit.map((a) => a.action)).toEqual([STATUS_BACKFILL_AUDIT_ACTION, STATUS_BACKFILL_ROLLBACK_AUDIT_ACTION]);
    // After a rollback the club can be back-filled again.
    expect((await applyTenantBackfill(fakeTx(db) as never, "tA", { runId: "run-3" })).status).toBe("applied");
  });

  it("running for one club leaves the other club's events unchanged (acceptance 5)", async () => {
    const db = club();
    const otherBefore = JSON.stringify(db.events.filter((e) => e.tenantId === "tB"));
    await applyTenantBackfill(fakeTx(db) as never, "tA", { runId: "run-1" });
    await rollbackTenantBackfill(fakeTx(db) as never, "tA", { runId: "run-1" });
    await applyTenantBackfill(fakeTx(db) as never, "tA", { runId: "run-2" });
    expect(JSON.stringify(db.events.filter((e) => e.tenantId === "tB"))).toBe(otherBefore);
    expect(db.events.filter((e) => e.sourceAction === "import_backfill").every((e) => e.tenantId === "tA")).toBe(true);
  });

  it("an erased member gets no events and is counted (acceptance 6)", async () => {
    const db = club();
    const r = await applyTenantBackfill(fakeTx(db) as never, "tA", { runId: "run-1" });
    expect(db.events.filter((e) => e.memberId === "gone").map((e) => e.id)).toEqual(["ig"]);
    expect(r.plan.exceptionCounts.erased_member).toBe(1);
  });

  it("a writer refusal aborts the club: nothing written, no audit row (acceptance 7)", async () => {
    const db = club();
    const tx = fakeTx(db);
    // A concurrent write lands an earlier first event between the plan and the insert.
    const realGroupBy = tx.memberStatusEvent.groupBy;
    tx.memberStatusEvent.groupBy = async (args) => {
      if (args.by.includes("tenantId")) db.events.push({ id: "early", tenantId: "tA", memberId: "ada", fromStatus: null, toStatus: "active", reason: "staff_edit", occurredAt: new Date("2024-01-01T00:00:00Z") });
      return realGroupBy(args);
    };
    await expect(applyTenantBackfill(tx as never, "tA", { runId: "run-1" })).rejects.toBeInstanceOf(StatusEventPlacementRefused);
    expect(tx.memberStatusEvent.createMany).not.toHaveBeenCalled();
    expect(db.audit).toHaveLength(0);
  });

  it("a member on two jobs uses the job that created them, and counts the other job's rows", async () => {
    const db = club();
    db.jobs.push({ id: "jobA2", tenantId: "tA", createdAt: new Date("2026-10-04T00:00:00Z") });
    db.ledger.push({ id: "lX", tenantId: "tA", memberId: "tom", importJobId: "jobA2", status: "cancelled", type: "recurring", entitlement: "history", startDate: D("2025-02-03"), cancelledDate: D("2025-12-08"), expiryDate: null, completedAt: null, disposition: "member_history", sourceRow: 2 });
    const plan = await planTenantBackfill(fakeTx(db) as never, "tA");
    expect(plan.membersOnSeveralJobs).toBe(1);
    expect(plan.rowsFromOtherJobs).toBe(1);
    expect(plan.inputs.filter((i) => i.memberId === "tom")).toHaveLength(2);
    expect(plan.inputs.every((i) => i.sourceJobId === "jobA")).toBe(true);
  });

  it("refuses to run without a club or a run id", async () => {
    const tx = fakeTx(club());
    await expect(planTenantBackfill(tx as never, "")).rejects.toThrow(/tenantId/);
    await expect(applyTenantBackfill(tx as never, "tA", { runId: "" })).rejects.toThrow(/runId/);
    await expect(rollbackTenantBackfill(tx as never, "tA", { runId: "" })).rejects.toThrow(/runId/);
  });
});

// ── 4. Migration ─────────────────────────────────────────────────────────────

describe("T8b migration: the sourceAction CHECK admits import_backfill", () => {
  const DIR = join(process.cwd(), "prisma", "migrations");
  const all = readdirSync(DIR).filter((d) => /^\d{14}_/.test(d)).sort();

  it("is folded into the T8d migration: one definer, no drop-and-re-add migration", () => {
    expect(all.some((d) => d.endsWith("_status_event_backfill_source_action"))).toBe(false);
    const definers = all.filter((d) => {
      try {
        return readFileSync(join(DIR, d, "migration.sql"), "utf8").includes('ADD CONSTRAINT "MemberStatusEvent_sourceAction_check"');
      } catch {
        return false;
      }
    });
    expect(definers).toHaveLength(1);
    expect(definers[0]).toMatch(/_status_event_source_provenance$/);
    const body = readFileSync(join(DIR, definers[0], "migration.sql"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n");
    expect(body).not.toMatch(/\bDROP\b/i);
    const list = /CHECK \("sourceAction" IN \(([^)]*)\)\)/.exec(body)?.[1] ?? "";
    expect(list.split(",").map((x) => x.trim().replace(/'/g, ""))).toContain("import_backfill");
  });
});

// ── 5. Script guard ──────────────────────────────────────────────────────────

describe("T8b script guard: never production", () => {
  const PROD = "postgresql://u:p@ep-bold-wave-abt39t7x-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";
  const TEST = "postgresql://u:p@ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";
  const CHILD = "postgresql://u:p@ep-quiet-river-abcd1234-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";

  it("refuses the production host, the production short name and --production", () => {
    expect(() => backfillTarget(PROD, ["--expect-host", "ep-bold-wave"])).toThrow(/production/);
    expect(() => backfillTarget(PROD, ["--expect-host", "ep-bold-wave-abt39t7x"])).toThrow(/production/);
    expect(() => backfillTarget(PROD, ["--expect-host", "ep-bold-wave", "--production"])).toThrow(/production/);
    expect(() => backfillTarget(TEST, ["--expect-host", "ep-hidden-salad", "--production"])).toThrow(/production/);
    expect(() => backfillTarget(PROD, ["--expect-host", "ep-hidden-salad"])).toThrow(/REFUSED/);
  });

  it("requires --expect-host and admits the TEST endpoint or a whole child-branch endpoint id", () => {
    expect(() => backfillTarget(TEST, [])).toThrow(/expect-host/);
    expect(backfillTarget(TEST, ["--expect-host", "ep-hidden-salad"])).toBe("ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech");
    expect(backfillTarget(CHILD, ["--expect-host", "ep-quiet-river-abcd1234"])).toBe("ep-quiet-river-abcd1234-pooler.eu-west-2.aws.neon.tech");
  });

  it("previews by default and never takes two modes", () => {
    expect(backfillMode([])).toBe("preview");
    expect(backfillMode(["--preview"])).toBe("preview");
    expect(backfillMode(["--apply"])).toBe("apply");
    expect(backfillMode(["--rollback"])).toBe("rollback");
    expect(() => backfillMode(["--apply", "--rollback"])).toThrow(/together/);
    expect(() => backfillMode(["--apply", "--preview"])).toThrow(/together/);
  });
});
