import { describe, it, expect, vi, beforeEach } from "vitest";
import { decideUndo, applyUndo as applyUndoReal, sameValue, REASON, UndoStale, type AuditRowLike, type TxLike } from "@/lib/undo-registry";
import { updateMetadata } from "@/lib/audit-snapshot";

/**
 * Undo registry (1 Oct 2026, hardened after the independent review). Pure
 * decisions + handlers against a fake tx. Red on revert: delete a handler and
 * its "restores" case fails; loosen the stale check and the "refused when
 * changed since" cases fail; drop a refusal and its case fails.
 */
vi.mock("@/lib/checkin", () => ({ restorePackCreditsForAttendance: vi.fn(async () => 0) }));
import { restorePackCreditsForAttendance } from "@/lib/checkin";

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
  membershipTier: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  classRoster: { deleteMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  memberRank: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  attendanceRecord: { findMany: vi.fn(), deleteMany: vi.fn() },
} satisfies Record<string, Record<string, Fn>>;
const tx = fake as unknown as TxLike;
const applyUndo = (t: TxLike, r: AuditRowLike) => applyUndoReal(t, r);

beforeEach(() => {
  for (const d of Object.values(fake)) for (const f of Object.values(d)) (f as Fn).mockReset();
  vi.mocked(restorePackCreditsForAttendance).mockClear();
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

  it("a removed check-in and a card-scan batch are refused with honest reasons (not 'before snapshots')", () => {
    expect(decideUndo(row("attendance.override", { classInstanceId: "ci", memberId: "m1" }), false)).toEqual({ ok: false, reason: REASON.reMark });
    expect(decideUndo(row("attendance.card_scan", {}, { entityType: "ClassInstance", entityId: "ci" }), false)).toEqual({ ok: false, reason: REASON.batchScan });
  });

  it("an already-undone row is refused", () => {
    expect(decideUndo(row("member.update", { changes: { name: { from: "A", to: "B" } } }), true)).toEqual({ ok: false, reason: REASON.alreadyUndone });
  });

  it("a member.update with neither snapshot nor diff is refused honestly", () => {
    expect(decideUndo(row("member.update", { fields: ["name"] }), false)).toEqual({ ok: false, reason: REASON.noSnapshot });
  });

  it("member.update: a login-address change is not restorable from here (AH-H2, 9 Oct 2026)", () => {
    // The staff PATCH records an address change as digests only; an undo would
    // restore an address without the claim, the token retirement or the
    // sign-out. Email-only → refused with its reason; email + name → the name
    // is still put back, the address is left alone.
    expect(decideUndo(row("member.update", { fields: ["email"], oldEmailSha256: "a".repeat(64), newEmailSha256: "b".repeat(64) }), false))
      .toEqual({ ok: false, reason: REASON.loginAddress });
    expect(decideUndo(row("member.update", { changes: { email: { from: "old@x.test", to: "new@x.test" } } }), false))
      .toEqual({ ok: false, reason: REASON.loginAddress });
    expect(decideUndo(row("member.update", { fields: ["email", "name"], changes: { name: { from: "A", to: "B" } }, oldEmailSha256: "a".repeat(64) }), false))
      .toEqual({ ok: true });
  });

  it("member.self_update: never undone by staff — the honest reason, and the login-address reason for an address change", () => {
    expect(decideUndo(row("member.self_update", { source: "self", changes: { name: { from: "A", to: "B" } } }), false))
      .toEqual({ ok: false, reason: REASON.selfEdit });
    expect(decideUndo(row("member.self_update", { source: "self", oldEmailSha256: "a".repeat(64), newEmailSha256: "b".repeat(64), unverified: true }), false))
      .toEqual({ ok: false, reason: REASON.loginAddress });
  });

  it("a member.update with a diff is reversible; with a before snapshot too", () => {
    expect(decideUndo(row("member.update", { changes: { name: { from: "A", to: "B" } } }), false)).toEqual({ ok: true });
    expect(decideUndo(row("member.update", { before: { name: "A" }, after: { name: "B" } }), false)).toEqual({ ok: true });
  });

  it("a member edit that cancelled (or reactivated) them, or that touched Stripe, is refused", () => {
    expect(decideUndo(row("member.update", { changes: { status: { from: "active", to: "cancelled" } } }), false)).toEqual({ ok: false, reason: REASON.cancellation });
    expect(decideUndo(row("member.update", { changes: { status: { from: "cancelled", to: "active" } } }), false)).toEqual({ ok: false, reason: REASON.cancellation });
    expect(decideUndo(row("member.update", { changes: { name: { from: "A", to: "B" } }, stripe: { stripeCancelled: true, cancelAt: null } }), false)).toEqual({ ok: false, reason: REASON.stripe });
    expect(decideUndo(row("member.update", { changes: { status: { from: "taster", to: "active" } } }), false)).toEqual({ ok: true });
  });

  it("text too long to keep a safe copy of is refused", () => {
    expect(decideUndo(row("tenant.settings.update", { fields: ["waiverContent"], truncated: true, before: {}, after: {} }, { entityType: "Tenant", entityId: "t1" }), false)).toEqual({ ok: false, reason: REASON.tooLong });
  });

  it("a hold that paused Stripe is refused; a desk-only hold is reversible", () => {
    expect(decideUndo(row("member.hold.start", { priorPaymentStatus: "paid", stripePaused: true }), false)).toEqual({ ok: false, reason: REASON.stripe });
    expect(decideUndo(row("member.hold.start", { priorPaymentStatus: "paid", stripePaused: false, stripeSubscriptionId: null }), false)).toEqual({ ok: true });
  });

  it("rank: a first grading, a demotion that removed bookings, and a row without fromStripes are refused", () => {
    expect(decideUndo(row("member.rank.promote", { fromRankId: null, toRankId: "blue" }), false)).toEqual({ ok: false, reason: REASON.firstGrading });
    expect(decideUndo(row("member.rank.demote", { fromRankId: "r1", toRankId: "r0", fromStripes: 2, cancelledSubscriptions: 2 }), false)).toEqual({ ok: false, reason: REASON.cascade });
    expect(decideUndo(row("member.rank.promote", { fromRankId: "white", toRankId: "blue" }), false)).toEqual({ ok: false, reason: REASON.noSnapshot });
    expect(decideUndo(row("member.rank.demote", { fromRankId: "r1", toRankId: "r0", fromStripes: 2, cancelledSubscriptions: 0 }), false)).toEqual({ ok: true });
  });

  it("a child link that also retyped the account is refused; undoing 'make default' is refused", () => {
    expect(decideUndo(row("member.link.child", { parentMemberId: "p", childMemberId: "k", accountType: "kids" }), false)).toEqual({ ok: false, reason: REASON.retyped });
    expect(decideUndo(row("location.update", { before: { isDefault: false }, after: { isDefault: true } }, { entityType: "Location", entityId: "l1" }), false)).toEqual({ ok: false, reason: REASON.defaultVenue });
    expect(decideUndo(row("location.update", { before: { name: "A" }, after: { name: "B" } }, { entityType: "Location", entityId: "l1" }), false)).toEqual({ ok: true });
  });
});

describe("sameValue — the stale check", () => {
  it("only a date-only value matches the ISO instant of that day", () => {
    expect(sameValue("1990-01-01", "1990-01-01T00:00:00.000Z")).toBe(true);
    expect(sameValue("Jon Smith!", "Jon Smith! (edited)")).toBe(false); // 10 chars is not a date
    expect(sameValue("1990-01-01", "1990-01-01x")).toBe(false);
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue(new Date("2026-10-01T00:00:00Z"), "2026-10-01T00:00:00.000Z")).toBe(true);
  });
});

describe("applyUndo — restores exactly what was recorded, or refuses", () => {
  it("member.update (diff): puts `from` back when the row still holds `to`", async () => {
    fake.member.findFirst.mockResolvedValue({ id: "m1", name: "B", phone: "2" });
    await applyUndo(tx, row("member.update", { changes: { name: { from: "A", to: "B" }, phone: { from: "1", to: "2" } } }));
    expect(fake.member.update).toHaveBeenCalledWith({ where: { id: "m1" }, data: { name: "A", phone: "1" } });
  });

  it("member.update: a legacy diff that still carries an email never writes the address back", async () => {
    fake.member.findFirst.mockResolvedValue({ id: "m1", name: "B", email: "new@x.test" });
    await applyUndo(tx, row("member.update", { changes: { name: { from: "A", to: "B" }, email: { from: "old@x.test", to: "new@x.test" } } }));
    expect(fake.member.update).toHaveBeenCalledWith({ where: { id: "m1" }, data: { name: "A" } });
  });

  it("member.update (diff): refused when someone changed it since", async () => {
    fake.member.findFirst.mockResolvedValue({ id: "m1", name: "C" });
    await expect(applyUndo(tx, row("member.update", { changes: { name: { from: "A", to: "B" } } }))).rejects.toBeInstanceOf(UndoStale);
    expect(fake.member.update).not.toHaveBeenCalled();
  });

  it("member.update: a cleared date of birth is restored as a Date even though the row now holds null", async () => {
    fake.member.findFirst.mockResolvedValue({ id: "m1", dateOfBirth: null });
    await applyUndo(tx, row("member.update", { changes: { dateOfBirth: { from: "1990-01-01", to: null } } }));
    const data = fake.member.update.mock.calls[0][0].data as { dateOfBirth: unknown };
    expect(data.dateOfBirth).toBeInstanceOf(Date);
  });

  it("member.update (snapshot): restores only allowed fields the action touched", async () => {
    fake.member.findFirst.mockResolvedValue({ id: "m1", name: "B", paymentStatus: "overdue", tenantId: "t1" });
    await applyUndo(tx, row("member.update", {
      before: { name: "A", paymentStatus: "paid", tenantId: "OTHER", stripeCustomerId: "cus_x", medicalConditions: "x" },
      after: { name: "B", paymentStatus: "overdue", tenantId: "OTHER", stripeCustomerId: "cus_x", medicalConditions: "y" },
    }));
    expect(fake.member.update).toHaveBeenCalledWith({ where: { id: "m1" }, data: { name: "A", paymentStatus: "paid" } });
  });

  it("tenant.settings.update (snapshot) restores settings, and refuses a row for another club", async () => {
    fake.tenant.findFirst.mockResolvedValue({ id: "t1", name: "New", timezone: "Europe/Rome" });
    await applyUndo(tx, row("tenant.settings.update", { before: { name: "Old", timezone: "Europe/London" }, after: { name: "New", timezone: "Europe/Rome" } }, { entityType: "Tenant", entityId: "t1" }));
    expect(fake.tenant.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { name: "Old", timezone: "Europe/London" } });
    await expect(applyUndo(tx, row("tenant.settings.update", { before: { name: "Old" }, after: { name: "New" } }, { entityType: "Tenant", entityId: "t-OTHER" }))).rejects.toBeInstanceOf(UndoStale);
  });

  it("staff.update: undoing a role change signs the person out everywhere (email is no longer restorable: S-2)", async () => {
    fake.user.findFirst.mockResolvedValue({ id: "u2", role: "manager" });
    await applyUndo(tx, row("staff.update", { before: { role: "coach" }, after: { role: "manager" } }, { entityType: "User", entityId: "u2" }));
    expect(fake.user.update).toHaveBeenCalledWith({ where: { id: "u2" }, data: { role: "coach", sessionVersion: { increment: 1 } } });
    fake.user.update.mockClear();
    fake.user.findFirst.mockResolvedValue({ id: "u2", name: "Mo" });
    await applyUndo(tx, row("staff.update", { before: { name: "Mohammed" }, after: { name: "Mo" } }, { entityType: "User", entityId: "u2" }));
    expect(fake.user.update).toHaveBeenCalledWith({ where: { id: "u2" }, data: { name: "Mohammed" } });
  });

  it("membership.tier.update: a price change on a plan with a Stripe price is refused", async () => {
    fake.membershipTier.findFirst.mockResolvedValue({ id: "tier1", pricePence: 5500, stripePriceId: "price_x" });
    await expect(applyUndo(tx, row("membership.tier.update", { before: { pricePence: 4500 }, after: { pricePence: 5500 } }, { entityType: "MembershipTier", entityId: "tier1" }))).rejects.toThrow(/Stripe price/);
    fake.membershipTier.findFirst.mockResolvedValue({ id: "tier1", name: "B", stripePriceId: "price_x" });
    await applyUndo(tx, row("membership.tier.update", { before: { name: "A" }, after: { name: "B" } }, { entityType: "MembershipTier", entityId: "tier1" }));
    expect(fake.membershipTier.update).toHaveBeenCalledWith({ where: { id: "tier1" }, data: { name: "A" } });
  });

  // B1-a (15 Oct 2026): what Undo does for a cleared class limit, and how a
  // later edit of the same plan changes that. The metadata is built by the
  // real route helper, so these follow what the PATCH actually records.
  describe("membership.tier.update: undoing a cleared class limit", () => {
    const FIELDS = ["name", "description", "pricePence", "currency", "billingCycle", "maxClassesPerWeek", "isKids", "isActive", "locationId"] as const;
    const tierRow = (over: Record<string, unknown>): Record<string, unknown> => ({ id: "tier1", name: "Plan A", pricePence: 4500, currency: "GBP", billingCycle: "monthly", maxClassesPerWeek: 3, stripePriceId: null, ...over });
    const clearRow = () =>
      row(
        "membership.tier.update",
        updateMetadata(["maxClassesPerWeek"], tierRow({}), tierRow({ maxClassesPerWeek: null }), FIELDS),
        { entityType: "MembershipTier", entityId: "tier1" },
      );

    it("records only the limit, and Undo restores the previous number while it is still Unlimited", async () => {
      const r = clearRow();
      expect(r.metadata).toMatchObject({ before: { maxClassesPerWeek: 3 }, after: { maxClassesPerWeek: null } });
      expect(decideUndo(r, false)).toEqual({ ok: true });
      fake.membershipTier.findFirst.mockResolvedValue(tierRow({ maxClassesPerWeek: null }));
      await applyUndo(tx, r);
      expect(fake.membershipTier.update).toHaveBeenCalledWith({ where: { id: "tier1" }, data: { maxClassesPerWeek: 3 } });
    });

    it("a later edit of a different field does not block it, and that edit is kept", async () => {
      // Only the price moved, so only the price is recorded on that later row —
      // whether or not the request carried the unchanged limit (the editor now
      // omits it; a client that re-sends it records the same diff).
      const later = updateMetadata(
        ["pricePence", "maxClassesPerWeek"],
        tierRow({ maxClassesPerWeek: null }),
        tierRow({ maxClassesPerWeek: null, pricePence: 5000 }),
        FIELDS,
      );
      expect(later).toMatchObject({ before: { pricePence: 4500 }, after: { pricePence: 5000 } });
      expect(later.after).not.toHaveProperty("maxClassesPerWeek");
      fake.membershipTier.findFirst.mockResolvedValue(tierRow({ maxClassesPerWeek: null, pricePence: 5000 }));
      await applyUndo(tx, clearRow());
      expect(fake.membershipTier.update).toHaveBeenCalledWith({ where: { id: "tier1" }, data: { maxClassesPerWeek: 3 } });
    });

    it("a later edit that sets a new limit makes it stale: refused, nothing written", async () => {
      fake.membershipTier.findFirst.mockResolvedValue(tierRow({ maxClassesPerWeek: 5 }));
      await expect(applyUndo(tx, clearRow())).rejects.toBeInstanceOf(UndoStale);
      expect(fake.membershipTier.update).not.toHaveBeenCalled();
    });

    it("the check compares only the current value: cleared, set to 5, cleared again — undoing the first clear still restores 3", async () => {
      // Documented limit (review F2): Undo is not a history replay. If the
      // limit is back to Unlimited when the owner undoes the first clear, the
      // row looks current and the old number returns.
      fake.membershipTier.findFirst.mockResolvedValue(tierRow({ maxClassesPerWeek: null }));
      await applyUndo(tx, clearRow());
      expect(fake.membershipTier.update).toHaveBeenCalledWith({ where: { id: "tier1" }, data: { maxClassesPerWeek: 3 } });
    });
  });

  // T7c (17 Oct 2026): the allowance pair is restorable; rows recorded before
  // T7c (maxClassesPerWeek only) still restore that column.
  describe("membership.tier.update: undoing a class allowance change", () => {
    const FIELDS = ["name", "description", "pricePence", "currency", "billingCycle", "maxClassesPerWeek", "classLimit", "classLimitWeeks", "isKids", "isActive", "locationId"] as const;
    const tierRow = (over: Record<string, unknown>): Record<string, unknown> => ({
      id: "tier1", name: "Plan A", pricePence: 4500, currency: "GBP", billingCycle: "monthly",
      maxClassesPerWeek: 3, classLimit: 3, classLimitWeeks: 1, stripePriceId: null, ...over,
    });
    const asRow = (m: Record<string, unknown>) => row("membership.tier.update", m, { entityType: "MembershipTier", entityId: "tier1" });

    it("3 every week -> 4 every 4 weeks: Undo restores all three columns", async () => {
      const after = tierRow({ maxClassesPerWeek: null, classLimit: 4, classLimitWeeks: 4 });
      const r = asRow(updateMetadata(["classLimit", "classLimitWeeks", "maxClassesPerWeek"], tierRow({}), after, FIELDS));
      expect(decideUndo(r, false)).toEqual({ ok: true });
      fake.membershipTier.findFirst.mockResolvedValue(after);
      await applyUndo(tx, r);
      expect(fake.membershipTier.update).toHaveBeenCalledWith({
        where: { id: "tier1" },
        data: { maxClassesPerWeek: 3, classLimit: 3, classLimitWeeks: 1 },
      });
    });

    it("4 every 4 weeks -> Unlimited: Undo puts the allowance back", async () => {
      const before = tierRow({ maxClassesPerWeek: null, classLimit: 4, classLimitWeeks: 4 });
      const after = tierRow({ maxClassesPerWeek: null, classLimit: null, classLimitWeeks: null });
      const r = asRow(updateMetadata(["classLimit", "classLimitWeeks", "maxClassesPerWeek"], before, after, FIELDS));
      fake.membershipTier.findFirst.mockResolvedValue(after);
      await applyUndo(tx, r);
      expect(fake.membershipTier.update).toHaveBeenCalledWith({ where: { id: "tier1" }, data: { classLimit: 4, classLimitWeeks: 4 } });
    });

    it("a later allowance change makes it stale: refused, nothing written", async () => {
      const before = tierRow({ maxClassesPerWeek: null, classLimit: 4, classLimitWeeks: 4 });
      const after = tierRow({ maxClassesPerWeek: null, classLimit: 6, classLimitWeeks: 4 });
      const r = asRow(updateMetadata(["classLimit", "classLimitWeeks", "maxClassesPerWeek"], before, after, FIELDS));
      fake.membershipTier.findFirst.mockResolvedValue(tierRow({ maxClassesPerWeek: null, classLimit: 8, classLimitWeeks: 4 }));
      await expect(applyUndo(tx, r)).rejects.toBeInstanceOf(UndoStale);
      expect(fake.membershipTier.update).not.toHaveBeenCalled();
    });

    it("a pre-T7c row restores maxClassesPerWeek alone", async () => {
      const r = asRow({ fields: ["maxClassesPerWeek"], before: { maxClassesPerWeek: 3 }, after: { maxClassesPerWeek: null } });
      fake.membershipTier.findFirst.mockResolvedValue(tierRow({ maxClassesPerWeek: null, classLimit: null, classLimitWeeks: null }));
      await applyUndo(tx, r);
      expect(fake.membershipTier.update).toHaveBeenCalledWith({ where: { id: "tier1" }, data: { maxClassesPerWeek: 3 } });
    });

    it("a restore that would split the pair is refused in words, not by the database", async () => {
      // A hand-built row whose before carries the number alone, against a row
      // that is Unlimited now: classLimit would be set with no weeks.
      const r = asRow({ fields: ["classLimit"], before: { classLimit: 4 }, after: { classLimit: null } });
      fake.membershipTier.findFirst.mockResolvedValue(tierRow({ maxClassesPerWeek: null, classLimit: null, classLimitWeeks: null }));
      await expect(applyUndo(tx, r)).rejects.toThrow(/class allowance has changed since/);
      expect(fake.membershipTier.update).not.toHaveBeenCalled();
    });
  });

  it("class.roster.add → removes the roster row; refused if already gone", async () => {
    fake.classRoster.deleteMany.mockResolvedValue({ count: 1 });
    await applyUndo(tx, row("class.roster.add", { classId: "c1", memberId: "m1" }, { entityType: "ClassRoster", entityId: "cr1" }));
    expect(fake.classRoster.deleteMany).toHaveBeenCalled();
    fake.classRoster.deleteMany.mockResolvedValue({ count: 0 });
    await expect(applyUndo(tx, row("class.roster.add", { classId: "c1", memberId: "m1" }))).rejects.toBeInstanceOf(UndoStale);
  });

  it("class.roster.remove → re-adds inside the club; refused if already back or the class is gone", async () => {
    fake.class.findFirst.mockResolvedValue({ id: "c1" });
    fake.member.findFirst.mockResolvedValue({ id: "m1" });
    fake.classRoster.findFirst.mockResolvedValue(null);
    await applyUndo(tx, row("class.roster.remove", { classId: "c1", memberId: "m1" }));
    expect(fake.classRoster.create).toHaveBeenCalledWith({ data: { tenantId: "t1", classId: "c1", memberId: "m1", addedByUserId: "u-mgr" } });
    fake.classRoster.findFirst.mockResolvedValue({ id: "cr1" });
    await expect(applyUndo(tx, row("class.roster.remove", { classId: "c1", memberId: "m1" }))).rejects.toBeInstanceOf(UndoStale);
    fake.class.findFirst.mockResolvedValue(null);
    await expect(applyUndo(tx, row("class.roster.remove", { classId: "c1", memberId: "m1" }))).rejects.toBeInstanceOf(UndoStale);
  });

  it("member.link.child → back to the previous guardian (or none)", async () => {
    fake.member.updateMany.mockResolvedValue({ count: 1 });
    await applyUndo(tx, row("member.link.child", { parentMemberId: "p2", childMemberId: "k1", previousParentMemberId: "p1" }, { entityId: "k1" }));
    expect(fake.member.updateMany).toHaveBeenCalledWith({
      where: { id: "k1", tenantId: "t1", parentMemberId: "p2" },
      // put back as a CONFIRMED link (lib/guardianship.ts, 2 Oct 2026)
      data: { parentMemberId: "p1", guardianConfirmedAt: expect.any(Date), guardianSuggestedBy: "staff" },
    });
  });

  it("member.guardian.confirmed → suggested again; refused when it also adopted the login address", async () => {
    fake.member.updateMany.mockResolvedValue({ count: 1 });
    await applyUndo(tx, row("member.guardian.confirmed", { parentMemberId: "p1", suggestedBy: "shared_email", wasConfirmed: false }, { entityId: "k1" }));
    expect(fake.member.updateMany).toHaveBeenCalledWith({
      where: { id: "k1", tenantId: "t1", parentMemberId: "p1", guardianConfirmedAt: { not: null } },
      data: { guardianConfirmedAt: null },
    });
    expect(decideUndo(row("member.guardian.confirmed", { parentMemberId: "p1", emailAdopted: true }), false)).toEqual({ ok: false, reason: REASON.emailAdopted });
    fake.member.updateMany.mockResolvedValue({ count: 0 });
    await expect(applyUndo(tx, row("member.guardian.confirmed", { parentMemberId: "p1", wasConfirmed: false }, { entityId: "k1" }))).rejects.toBeInstanceOf(UndoStale);
  });

  it("member.guardian.rejected → the suggestion is put back as it was; stale once re-linked", async () => {
    fake.member.updateMany.mockResolvedValue({ count: 1 });
    await applyUndo(tx, row("member.guardian.rejected", { parentMemberId: "p1", suggestedBy: "emergency_contact", wasConfirmed: false }, { entityId: "k1" }));
    expect(fake.member.updateMany).toHaveBeenCalledWith({
      where: { id: "k1", tenantId: "t1", parentMemberId: null },
      data: { parentMemberId: "p1", guardianConfirmedAt: null, guardianSuggestedBy: "emergency_contact" },
    });
    fake.member.updateMany.mockResolvedValue({ count: 0 });
    await expect(applyUndo(tx, row("member.guardian.rejected", { parentMemberId: "p1" }, { entityId: "k1" }))).rejects.toBeInstanceOf(UndoStale);
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

  it("member.rank.promote → previous rank AND stripes; the stale check includes the stripes it set", async () => {
    fake.memberRank.findFirst.mockResolvedValue({ id: "mr1" });
    await applyUndo(tx, row("member.rank.promote", { fromRankId: "white", toRankId: "blue", stripes: 0, fromStripes: 3 }));
    expect(fake.memberRank.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ rankSystemId: "blue", stripes: 0 }) }));
    expect(fake.memberRank.update).toHaveBeenCalledWith({ where: { id: "mr1" }, data: { rankSystemId: "white", stripes: 3, promotedById: "u-mgr" } });
    fake.memberRank.findFirst.mockResolvedValue(null);
    await expect(applyUndo(tx, row("member.rank.promote", { fromRankId: "white", toRankId: "blue", stripes: 0, fromStripes: 3 }))).rejects.toBeInstanceOf(UndoStale);
  });

  it("attendance: a staff mark (pair-keyed) and a self check-in (id-keyed) are removed with pack credits restored first", async () => {
    fake.attendanceRecord.findMany.mockResolvedValue([{ id: "att1" }]);
    fake.attendanceRecord.deleteMany.mockResolvedValue({ count: 1 });
    await applyUndo(tx, row("attendance.mark", { classInstanceId: "ci1", memberId: "m1" }, { entityType: "AttendanceRecord", entityId: "ci1:m1" }));
    expect(fake.attendanceRecord.findMany).toHaveBeenCalledWith({ where: { classInstanceId: "ci1", memberId: "m1", member: { tenantId: "t1" } }, select: { id: true, checkInMethod: true, importJobId: true } });
    expect(restorePackCreditsForAttendance).toHaveBeenCalledWith(tx, ["att1"]);
    expect(fake.attendanceRecord.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["att1"] } } });

    fake.attendanceRecord.findMany.mockResolvedValue([{ id: "att2" }]);
    await applyUndo(tx, row("attendance.self_checkin", { method: "self" }, { entityType: "AttendanceRecord", entityId: "att2" }));
    expect(fake.attendanceRecord.findMany).toHaveBeenLastCalledWith({ where: { id: "att2", member: { tenantId: "t1" } }, select: { id: true, checkInMethod: true, importJobId: true } });

    fake.attendanceRecord.findMany.mockResolvedValue([]);
    await expect(applyUndo(tx, row("attendance.mark", { classInstanceId: "ci1", memberId: "m1" }, { entityType: "AttendanceRecord", entityId: "ci1:m1" }))).rejects.toBeInstanceOf(UndoStale);
  });
});

describe("second review round (e9bed13 → follow-up)", () => {
  it("nothing is written back onto a GDPR-erased member", async () => {
    fake.member.findFirst.mockResolvedValue({ id: "m1", email: "deleted-abc@deleted.invalid", phone: null });
    await expect(applyUndo(tx, row("member.update", { changes: { phone: { from: "+447700900111", to: null } } }))).rejects.toThrow(/erased/);
    expect(fake.member.update).not.toHaveBeenCalled();
  });

  it("a notes-only edit is refused with the private-text reason, not 'before snapshots'", () => {
    expect(decideUndo(row("member.update", { fields: ["notes"] }), false)).toEqual({ ok: false, reason: REASON.privateText });
    expect(decideUndo(row("member.update", { fields: ["medicalConditions", "notes"] }), false)).toEqual({ ok: false, reason: REASON.privateText });
    expect(decideUndo(row("member.update", { fields: ["name"] }), false)).toEqual({ ok: false, reason: REASON.noSnapshot });
  });

  it("class.roster.remove is refused when the class has become rank-gated", async () => {
    fake.class.findFirst.mockResolvedValue({ id: "c1", requiredRankId: "blue", maxRankId: null });
    fake.member.findFirst.mockResolvedValue({ id: "m1" });
    await expect(applyUndo(tx, row("class.roster.remove", { classId: "c1", memberId: "m1" }))).rejects.toThrow(/rank-gated/);
    expect(fake.classRoster.create).not.toHaveBeenCalled();
  });

  it("attendance: the exact record id wins over the pair when the row has one", async () => {
    fake.attendanceRecord.findMany.mockResolvedValue([{ id: "att9" }]);
    fake.attendanceRecord.deleteMany.mockResolvedValue({ count: 1 });
    await applyUndo(tx, row("attendance.kiosk_checkin", { classInstanceId: "ci1", memberId: "m1" }, { entityType: "AttendanceRecord", entityId: "att9" }));
    expect(fake.attendanceRecord.findMany).toHaveBeenCalledWith({ where: { id: "att9", member: { tenantId: "t1" } }, select: { id: true, checkInMethod: true, importJobId: true } });
  });

  it("a demotion's stale check includes the 0 stripes it set", async () => {
    fake.memberRank.findFirst.mockResolvedValue(null);
    await expect(applyUndo(tx, row("member.rank.demote", { fromRankId: "blue", toRankId: "white", stripes: 0, fromStripes: 2, cancelledSubscriptions: 0 }))).rejects.toBeInstanceOf(UndoStale);
    expect(fake.memberRank.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ rankSystemId: "white", stripes: 0 }) }));
  });
});
