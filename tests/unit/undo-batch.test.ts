import { describe, it, expect, vi, beforeEach } from "vitest";
import { planUndoTo, executeUndo, UndoBatchFailed } from "@/lib/undo-batch";
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
  const tx = fake as unknown as TxLike;

  beforeEach(() => {
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
});
