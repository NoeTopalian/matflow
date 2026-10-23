import { describe, it, expect, vi, beforeEach } from "vitest";
import { planUndoTo, executeUndo, UndoBatchFailed, batchLockTargets } from "@/lib/undo-batch";
import { REASON, type AuditRowLike, type TxLike } from "@/lib/undo-registry";

const at = (iso: string) => new Date(iso);
const r = (id: string, action: string, createdAt: string, metadata: unknown = {}, entity: Partial<AuditRowLike> = {}): AuditRowLike => ({
  id, tenantId: "t1", userId: "u-mgr", action, entityType: "Member", entityId: "m1", metadata, createdAt: at(createdAt), ...entity,
});

const ROWS = [
  r("a4", "payment.manual", "2026-10-01T12:00:00Z", { amountPence: 4500 }),
  r("a3", "member.update", "2026-10-01T11:00:00Z", { changes: { phone: { from: "1", to: "2" } } }),
  r("a2", "class.roster.add", "2026-10-01T10:30:00Z", { classId: "c1", memberId: "m1" }, { entityType: "ClassRoster", entityId: "cr1" }),
  r("a1", "member.update", "2026-10-01T10:00:00Z", { changes: { name: { from: "A", to: "B" } } }),
  r("a0", "member.update", "2026-10-01T09:00:00Z", { changes: { name: { from: "Z", to: "A" } } }),
];

describe("planUndoTo", () => {
  it("includes the target and everything newer, newest first, and separates the irreversible", () => {
    const plan = planUndoTo(ROWS, "a1", new Set());
    expect(plan.reversible.map((p) => p.row.id)).toEqual(["a3", "a2", "a1"]);
    expect(plan.skipped.map((p) => [p.row.id, (p.decision as { reason: string }).reason])).toEqual([["a4", REASON.money]]);
    // a0 is older than the target and never in scope
    expect([...plan.reversible, ...plan.skipped].some((p) => p.row.id === "a0")).toBe(false);
  });

  it("an already-undone row is skipped with its reason", () => {
    const plan = planUndoTo(ROWS, "a1", new Set(["a2"]));
    expect(plan.reversible.map((p) => p.row.id)).toEqual(["a3", "a1"]);
    expect(plan.skipped.find((p) => p.row.id === "a2")?.decision).toEqual({ ok: false, reason: REASON.alreadyUndone });
  });

  it("throws when the target is not in the set", () => {
    expect(() => planUndoTo(ROWS, "nope", new Set())).toThrow();
  });
});

describe("executeUndo", () => {
  type Fn = ReturnType<typeof vi.fn>;
  const fake = {
    member: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    classRoster: { deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
  } satisfies Record<string, Record<string, Fn>>;
  const queryRaw = vi.fn();
  const order: string[] = [];
  const tx = { ...fake, $queryRaw: queryRaw } as unknown as TxLike;

  beforeEach(() => {
    order.length = 0;
    queryRaw.mockReset();
    queryRaw.mockImplementation(async (strings: string[], ...values: unknown[]) => {
      const text = strings.join("?");
      order.push(text.includes('FROM "Class"') ? `lock-class:${JSON.stringify(values[1])}` : `lock-member:${JSON.stringify(values[1])}`);
      return [];
    });
    fake.member.findFirst.mockReset();
    fake.member.update.mockReset();
    fake.classRoster.deleteMany.mockReset();
    fake.auditLog.create.mockReset();
  });

  it("reverses in order and writes one undo.* audit row per reversal", async () => {
    fake.member.findFirst.mockResolvedValueOnce({ id: "m1", phone: "2" }).mockResolvedValueOnce({ id: "m1", name: "B" });
    fake.classRoster.deleteMany.mockResolvedValue({ count: 1 });
    const plan = planUndoTo(ROWS, "a1", new Set());
    const undone = await executeUndo(tx, plan.reversible, { tenantId: "t1", userId: "u-owner" });
    expect(undone).toEqual(["a3", "a2", "a1"]);
    expect(fake.auditLog.create).toHaveBeenCalledTimes(3);
    expect(fake.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: "undo.member.update",
      userId: "u-owner",
      metadata: { undoneAuditId: "a3", undoneAction: "member.update", undoneByUserId: "u-mgr" },
    });
  });

  it("stops at the first stale row and names it (caller's transaction rolls back)", async () => {
    fake.member.findFirst.mockResolvedValueOnce({ id: "m1", phone: "9" }); // a3 changed since
    const plan = planUndoTo(ROWS, "a1", new Set());
    await expect(executeUndo(tx, plan.reversible, { tenantId: "t1", userId: "u-owner" })).rejects.toSatisfy(
      (e: unknown) => e instanceof UndoBatchFailed && e.row.id === "a3",
    );
    expect(fake.auditLog.create).not.toHaveBeenCalled();
  });

  it("locks every Class, then every Member, in id order, before any handler runs (T7 lock order)", async () => {
    fake.member.findFirst.mockImplementation(async () => {
      order.push("handler");
      return order.filter((o) => o === "handler").length === 1 ? { id: "m1", phone: "2" } : { id: "m1", name: "B" };
    });
    fake.classRoster.deleteMany.mockImplementation(async () => {
      order.push("handler");
      return { count: 1 };
    });
    const plan = planUndoTo(ROWS, "a1", new Set());
    await executeUndo(tx, plan.reversible, { tenantId: "t1", userId: "u-owner" });
    expect(order.slice(0, 2)).toEqual(['lock-class:["c1"]', 'lock-member:["m1"]']);
    expect(order.slice(2).every((o) => o === "handler")).toBe(true);
    const [classSql, memberSql] = queryRaw.mock.calls.map((c) => (c[0] as string[]).join("?"));
    expect(classSql).toMatch(/ORDER BY "id" FOR NO KEY UPDATE/);
    expect(memberSql).toMatch(/ORDER BY "id" FOR NO KEY UPDATE/);
    expect(memberSql).toContain('"AttendanceRecord"');
  });

  it("a single item takes no batch lock (one handler cannot interleave with itself)", async () => {
    fake.member.findFirst.mockResolvedValueOnce({ id: "m1", name: "B" });
    const plan = planUndoTo(ROWS, "a1", new Set(["a3", "a2"]));
    expect(plan.reversible).toHaveLength(1);
    await executeUndo(tx, plan.reversible, { tenantId: "t1", userId: "u-owner" });
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe("batchLockTargets", () => {
  it("reads classes, members and attendance record ids off the rows, sorted and unique", () => {
    const items = [
      r("b1", "class.updated", "2026-10-01T12:00:00Z", {}, { entityType: "Class", entityId: "c9" }),
      r("b2", "class.roster.remove", "2026-10-01T11:00:00Z", { classId: "c2", memberId: "m5" }, { entityType: "ClassRoster", entityId: "cr" }),
      r("b3", "attendance.self_checkin", "2026-10-01T10:00:00Z", {}, { entityType: "AttendanceRecord", entityId: "ar-2" }),
      r("b4", "attendance.mark", "2026-10-01T09:00:00Z", { recordId: "ar-1", classInstanceId: "ci", memberId: "m3" }, { entityType: "AttendanceRecord", entityId: "ci:m3" }),
      r("b5", "member.link.child", "2026-10-01T08:00:00Z", { parentMemberId: "p1", childMemberId: "k1" }),
      r("b6", "member.update", "2026-10-01T07:00:00Z", {}, { entityType: "Member", entityId: "m5" }),
    ].map((row) => ({ row, decision: { ok: true as const } }));
    expect(batchLockTargets(items)).toEqual({
      classIds: ["c2", "c9"],
      memberIds: ["k1", "m1", "m3", "m5"],
      recordIds: ["ar-1", "ar-2"],
    });
  });
});

// T8a: executeUndo hands the undoing user to the handler, so a restored status
// is attributed to the person who pressed Undo, not to whoever made the edit.
describe("executeUndo — a restored status is attributed to the undoing user (T8a)", () => {
  it("records inactive -> active with changedById = the actor", async () => {
    const create = vi.fn(async () => ({ id: "evt-1" }));
    const fake = {
      member: { findFirst: vi.fn(async () => ({ id: "m1", status: "inactive", email: "a@x.test" })), update: vi.fn(), updateMany: vi.fn() },
      memberStatusEvent: { create, findFirst: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    const row = r("s1", "member.update", "2026-10-10T10:00:00Z", { changes: { status: { from: "active", to: "inactive" } } });
    await executeUndo(fake as unknown as TxLike, [{ row, decision: { ok: true } }], { tenantId: "t1", userId: "u-owner" });
    expect(create).toHaveBeenCalledWith({
      data: { tenantId: "t1", memberId: "m1", fromStatus: "inactive", toStatus: "active", reason: "staff_edit", changedById: "u-owner" },
      select: { id: true },
    });
  });
});
