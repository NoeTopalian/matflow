import { describe, it, expect, vi, beforeEach } from "vitest";
import { decideUndo, applyUndo as applyUndoReal, REASON, UndoStale, type AuditRowLike, type TxLike } from "@/lib/undo-registry";

/**
 * Undo registry (1 Oct 2026). Pure decisions + handlers against a fake tx.
 * Red on revert: delete a handler and its "restores" case fails; loosen the
 * stale check and the "refused when changed since" cases fail.
 */
const row = (action: string, metadata: unknown, extra: Partial<AuditRowLike> = {}): AuditRowLike => ({
  id: "a1",
  tenantId: "t1",
  userId: "u-mgr",
  action,
  entityType: "Member",
  entityId: "m1",
  metadata,
  createdAt: new Date("2026-10-01T10:00:00Z"),
  ...extra,
});

type Fn = ReturnType<typeof vi.fn>;
const fake = {
  member: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  tenant: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  user: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  class: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  classRoster: { deleteMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  memberRank: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  attendanceRecord: { deleteMany: vi.fn() },
} satisfies Record<string, Record<string, Fn>>;
const tx = fake as unknown as TxLike;
const applyUndo = (t: TxLike, r: AuditRowLike) => applyUndoReal(t, r);

beforeEach(() => {
  for (const d of Object.values(fake)) for (const f of Object.values(d)) (f as Fn).mockReset();
});

describe("decideUndo — what the owner is told", () => {
  it("money, Stripe, email, security, operator and import rows are refused with their reason", () => {
    expect(decideUndo(row("payment.manual", {}), false)).toEqual({ ok: false, reason: REASON.money });
    expect(decideUndo(row("payment.refund", {}), false)).toEqual({ ok: false, reason: REASON.money });
    expect(decideUndo(row("stripe.disconnect", {}), false)).toEqual({ ok: false, reason: REASON.stripe });
    expect(decideUndo(row("payment.chase", {}), false)).toEqual({ ok: false, reason: REASON.email });
    expect(decideUndo(row("staff.invite", {}), false)).toEqual({ ok: false, reason: REASON.email });
    expect(decideUndo(row("auth.logout_all", {}), false)).toEqual({ ok: false, reason: REASON.security });
    expect(decideUndo(row("member.totp_reset", {}), false)).toEqual({ ok: false, reason: REASON.security });
    expect(decideUndo(row("admin.tenant.suspended", {}), false)).toEqual({ ok: false, reason: REASON.operator });
    expect(decideUndo(row("import.commit", {}), false)).toEqual({ ok: false, reason: REASON.importer });
    expect(decideUndo(row("member.dsar_erase", {}), false)).toEqual({ ok: false, reason: REASON.record });
    expect(decideUndo(row("undo.member.update", {}), false)).toEqual({ ok: false, reason: REASON.undoOfUndo });
  });

  it("an already-undone row is refused", () => {
    expect(decideUndo(row("member.update", { changes: { name: { from: "A", to: "B" } } }), true)).toEqual({ ok: false, reason: REASON.alreadyUndone });
  });

  it("a member.update with neither snapshot nor diff is refused honestly", () => {
    expect(decideUndo(row("member.update", { fields: ["name"] }), false)).toEqual({ ok: false, reason: REASON.noSnapshot });
  });

  it("a member.update with a diff is reversible; with a before snapshot too", () => {
    expect(decideUndo(row("member.update", { changes: { name: { from: "A", to: "B" } } }), false)).toEqual({ ok: true });
    expect(decideUndo(row("member.update", { before: { name: "A" }, after: { name: "B" } }), false)).toEqual({ ok: true });
  });

  it("a hold that paused Stripe is refused; a desk-only hold is reversible", () => {
    expect(decideUndo(row("member.hold.start", { priorPaymentStatus: "paid", stripePaused: true }), false)).toEqual({ ok: false, reason: REASON.stripe });
    expect(decideUndo(row("member.hold.start", { priorPaymentStatus: "paid", stripePaused: false, stripeSubscriptionId: null }), false)).toEqual({ ok: true });
  });

  it("a demotion that removed class bookings is refused", () => {
    expect(decideUndo(row("member.rank.demote", { fromRankId: "r1", toRankId: "r0", cancelledSubscriptions: 2 }), false)).toEqual({ ok: false, reason: REASON.cascade });
    expect(decideUndo(row("member.rank.demote", { fromRankId: "r1", toRankId: "r0", cancelledSubscriptions: 0 }), false)).toEqual({ ok: true });
  });
});

describe("applyUndo — restores exactly what was recorded, or refuses", () => {
  it("member.update (diff): puts `from` back when the row still holds `to`", async () => {
    fake.member.findFirst.mockResolvedValue({ id: "m1", name: "B", phone: "2" });
    await applyUndo(tx, row("member.update", { changes: { name: { from: "A", to: "B" }, phone: { from: "1", to: "2" } } }));
    expect(fake.member.update).toHaveBeenCalledWith({ where: { id: "m1" }, data: { name: "A", phone: "1" } });
  });

  it("member.update (diff): refused when someone changed it since", async () => {
    fake.member.findFirst.mockResolvedValue({ id: "m1", name: "C" });
    await expect(applyUndo(tx, row("member.update", { changes: { name: { from: "A", to: "B" } } }))).rejects.toBeInstanceOf(UndoStale);
    expect(fake.member.update).not.toHaveBeenCalled();
  });

  it("member.update (snapshot): restores only allowed fields the action touched", async () => {
    fake.member.findFirst.mockResolvedValue({ id: "m1", name: "B", status: "cancelled", tenantId: "t1" });
    await applyUndo(tx, row("member.update", {
      before: { name: "A", status: "active", tenantId: "OTHER", stripeCustomerId: "cus_x" },
      after: { name: "B", status: "cancelled", tenantId: "OTHER", stripeCustomerId: "cus_x" },
    }));
    expect(fake.member.update).toHaveBeenCalledWith({ where: { id: "m1" }, data: { name: "A", status: "active" } });
  });

  it("tenant.settings.update (snapshot) restores settings", async () => {
    fake.tenant.findFirst.mockResolvedValue({ id: "t1", name: "New", timezone: "Europe/Rome" });
    await applyUndo(tx, row("tenant.settings.update", { before: { name: "Old", timezone: "Europe/London" }, after: { name: "New", timezone: "Europe/Rome" } }, { entityType: "Tenant", entityId: "t1" }));
    expect(fake.tenant.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { name: "Old", timezone: "Europe/London" } });
  });

  it("class.roster.add → removes the roster row; refused if already gone", async () => {
    fake.classRoster.deleteMany.mockResolvedValue({ count: 1 });
    await applyUndo(tx, row("class.roster.add", { classId: "c1", memberId: "m1" }, { entityType: "ClassRoster", entityId: "cr1" }));
    expect(fake.classRoster.deleteMany).toHaveBeenCalled();
    fake.classRoster.deleteMany.mockResolvedValue({ count: 0 });
    await expect(applyUndo(tx, row("class.roster.add", { classId: "c1", memberId: "m1" }))).rejects.toBeInstanceOf(UndoStale);
  });

  it("class.roster.remove → re-adds; refused if already back", async () => {
    fake.classRoster.findFirst.mockResolvedValue(null);
    await applyUndo(tx, row("class.roster.remove", { classId: "c1", memberId: "m1" }));
    expect(fake.classRoster.create).toHaveBeenCalledWith({ data: { tenantId: "t1", classId: "c1", memberId: "m1", addedByUserId: "u-mgr" } });
    fake.classRoster.findFirst.mockResolvedValue({ id: "cr1" });
    await expect(applyUndo(tx, row("class.roster.remove", { classId: "c1", memberId: "m1" }))).rejects.toBeInstanceOf(UndoStale);
  });

  it("member.link.child → back to the previous guardian (or none)", async () => {
    fake.member.updateMany.mockResolvedValue({ count: 1 });
    await applyUndo(tx, row("member.link.child", { parentMemberId: "p2", childMemberId: "k1", previousParentMemberId: "p1" }, { entityId: "k1" }));
    expect(fake.member.updateMany).toHaveBeenCalledWith({
      where: { id: "k1", tenantId: "t1", parentMemberId: "p2" },
      data: { parentMemberId: "p1" },
    });
  });

  it("member.hold.start → resumes to the recorded prior status; refused if no longer on hold", async () => {
    fake.member.updateMany.mockResolvedValue({ count: 1 });
    await applyUndo(tx, row("member.hold.start", { priorPaymentStatus: "overdue", stripePaused: false }));
    expect(fake.member.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", tenantId: "t1", paymentStatus: "paused" },
      data: { paymentStatus: "overdue", holdUntil: null, holdPriorStatus: null },
    });
    fake.member.updateMany.mockResolvedValue({ count: 0 });
    await expect(applyUndo(tx, row("member.hold.start", { priorPaymentStatus: "paid" }))).rejects.toBeInstanceOf(UndoStale);
  });

  it("member.rank.promote → previous rank, or the row removed on a first grading", async () => {
    fake.memberRank.findFirst.mockResolvedValue({ id: "mr1" });
    await applyUndo(tx, row("member.rank.promote", { fromRankId: "white", toRankId: "blue", fromStripes: 3 }));
    expect(fake.memberRank.update).toHaveBeenCalledWith({ where: { id: "mr1" }, data: { rankSystemId: "white", stripes: 3, promotedById: "u-mgr" } });
    await applyUndo(tx, row("member.rank.promote", { fromRankId: null, toRankId: "blue" }));
    expect(fake.memberRank.delete).toHaveBeenCalledWith({ where: { id: "mr1" } });
  });

  it("attendance.mark → the check-in record is removed; refused if already gone", async () => {
    fake.attendanceRecord.deleteMany.mockResolvedValue({ count: 1 });
    await applyUndo(tx, row("attendance.mark", {}, { entityType: "AttendanceRecord", entityId: "att1" }));
    expect(fake.attendanceRecord.deleteMany).toHaveBeenCalledWith({ where: { id: "att1", member: { tenantId: "t1" } } });
    fake.attendanceRecord.deleteMany.mockResolvedValue({ count: 0 });
    await expect(applyUndo(tx, row("attendance.mark", {}, { entityType: "AttendanceRecord", entityId: "att1" }))).rejects.toBeInstanceOf(UndoStale);
  });
});
