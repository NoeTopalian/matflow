// One audit row as the Activity timeline shows it: the sentence, its links,
// the detail line, the source, and what a manager is not shown. The rows here
// are shaped like the ones the product really writes (see each logAudit call).
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AUDIT_LABELS } from "@/lib/audit-labels";
import { emptyLookups, hrefFor, plainFallbackEntry, sourceOf, toFeedEntries, toFeedEntry, type ActivityLookups, type FeedContext, type FeedRow } from "@/lib/activity-feed";
import type { FeedEntry, Part } from "@/lib/activity-types";

const TZ = "Europe/London";
const JACK = { id: "u_jack", name: "Jack Streeter" };

function lookups(): ActivityLookups {
  const L = emptyLookups();
  L.members.set("m_mel", { name: "Melody Orekoya", erased: false });
  L.members.set("m_faisal", { name: "Faisal Alshukri", erased: false });
  L.members.set("m_kid", { name: "Zara Alshukri", erased: false });
  L.members.set("m_a", { name: "Ada Obi", erased: false });
  L.members.set("m_b", { name: "Ben Cole", erased: false });
  L.members.set("m_c", { name: "Cy Dent", erased: false });
  L.members.set("m_erased", { name: "Deleted member", erased: true });
  L.deletedMemberNames.set("m_named", "Jane Smith");
  L.classes.set("c_nogi", { name: "Advanced No-Gi" });
  L.sessions.set("s_wed", { classId: "c_nogi", className: "Advanced No-Gi", date: new Date("2026-11-04T00:00:00Z"), startTime: "19:00" });
  L.tiers.set("t_adult", { name: "Adult Unlimited" });
  L.tiers.set("t_twice", { name: "Twice a week (OLD)" });
  L.packs.set("pk_10", { name: "10 class pack" });
  L.ranks.set("r_white", { name: "White belt" });
  L.ranks.set("r_blue", { name: "Blue belt" });
  L.staff.set(JACK.id, { name: JACK.name });
  L.staff.set("u_sean", { name: "Sean Coates" });
  const stripePayment = { id: "p_stripe", memberId: "m_mel", amountPence: 4500, currency: "GBP", stripeInvoiceId: "in_1" };
  const deskPayment = { id: "p_desk", memberId: "m_faisal", amountPence: 2000, currency: "GBP", stripeInvoiceId: null };
  L.payments.set(stripePayment.id, stripePayment);
  L.paymentsByInvoice.set("in_1", stripePayment);
  L.payments.set(deskPayment.id, deskPayment);
  L.orders.set("o_1", { orderRef: "ORD-LMRK4G", memberId: "m_mel", totalPence: 1200, currency: "GBP" });
  return L;
}

let seq = 0;
function row(over: Partial<FeedRow> & Pick<FeedRow, "action">): FeedRow {
  const base: FeedRow = { id: `a${++seq}`, action: over.action, entityType: "Member", entityId: "m_mel", metadata: null, createdAt: new Date("2026-11-04T19:45:00Z"), userId: null, operatorId: null, user: null };
  return { ...base, ...over };
}
const byJack = { userId: JACK.id, user: JACK };

const ctx = (over: Partial<FeedContext> = {}): FeedContext => ({ lookups: lookups(), role: "owner", timeZone: TZ, ...over });
const entry = (r: FeedRow, over: Partial<FeedContext> = {}) => toFeedEntry(r, ctx(over));
const links = (parts: Part[] | null) => (parts ?? []).flatMap((p) => ("subject" in p && p.subject.href ? [`${p.subject.name} -> ${p.subject.href}`] : []));

describe("check-ins", () => {
  it("a member checking themselves in", () => {
    const e = entry(row({ action: "attendance.self_checkin", entityType: "AttendanceRecord", entityId: "rec1", metadata: { classInstanceId: "s_wed", memberId: "m_mel", method: "self", actorId: "m_mel" } }));
    expect(e.plain).toBe("Melody Orekoya checked in to Advanced No-Gi · Wed 4 Nov, 19:00");
    expect(links(e.parts)).toEqual(["Melody Orekoya -> /dashboard/members/m_mel", "Advanced No-Gi · Wed 4 Nov, 19:00 -> /dashboard/attendance?instance=s_wed"]);
    expect(e.type).toBe("checkin");
    expect(e.source).toEqual({ label: "Member app", staff: null, support: false });
  });

  it("a parent checking a child in names both", () => {
    const e = entry(row({ action: "attendance.self_checkin", entityType: "AttendanceRecord", entityId: "rec2", metadata: { classInstanceId: "s_wed", memberId: "m_kid", method: "self", onBehalfOf: "m_kid", actorId: "m_faisal" } }));
    expect(e.plain).toBe("Faisal Alshukri checked Zara Alshukri in to Advanced No-Gi · Wed 4 Nov, 19:00");
  });

  it("a kiosk check-in", () => {
    const e = entry(row({ action: "attendance.kiosk_checkin", entityType: "AttendanceRecord", entityId: "rec3", metadata: { memberId: "m_mel", classInstanceId: "s_wed", coverage: "membership", kioskIpApprox: "10.0.0.0", kioskUaSummary: "iPad", actorId: "m_mel" } }));
    expect(e.plain).toBe("Melody Orekoya checked in to Advanced No-Gi · Wed 4 Nov, 19:00");
    expect(e.source.label).toBe("Kiosk");
  });

  it("a staff tick, with the warning they accepted and the pack credit it used", () => {
    const e = entry(row({ action: "attendance.mark", entityType: "AttendanceRecord", entityId: "s_wed:m_mel", ...byJack, metadata: { classInstanceId: "s_wed", memberId: "m_mel", method: "admin", recordId: "rec4", created: true, paidByClassPack: true, packCreditsRemaining: 4, acknowledged: ["waiver_unsigned", "on_hold"] } }));
    expect(e.plain).toBe("Jack Streeter checked Melody Orekoya in to Advanced No-Gi · Wed 4 Nov, 19:00");
    expect(e.type).toBe("checkin_exception");
    expect(e.detailPlain).toBe("Admitted while on hold · Admitted without a signed waiver · Used a class pack credit · 4 left");
    // Jack is in the sentence, so the source does not repeat him.
    expect(e.source).toEqual({ label: "Staff", staff: null, support: false });
    expect(links(e.parts)[0]).toBe("Jack Streeter -> /dashboard/activity?userId=u_jack");
  });

  it("a card-scan batch: a count, the first three named, and the rest counted", () => {
    const scan = row({ action: "attendance.card_scan", entityType: "ClassInstance", entityId: "s_wed", ...byJack, metadata: { classInstanceId: "s_wed", scanned: 5, recorded: 5, memberIds: ["m_a", "m_b", "m_c", "m_mel", "m_faisal"] } });
    const e = entry(scan);
    expect(e.plain).toBe("Jack Streeter scanned 5 members in to Advanced No-Gi · Wed 4 Nov, 19:00");
    expect(e.detailPlain).toBe("Ada Obi, Ben Cole, Cy Dent + 2 more");
    expect(links(e.detail)).toEqual(["Ada Obi -> /dashboard/members/m_a", "Ben Cole -> /dashboard/members/m_b", "Cy Dent -> /dashboard/members/m_c"]);
    expect(e.source.label).toBe("Card scan");
  });

  it("a batch of one names the member; a member's own view tells it as theirs", () => {
    const one = row({ action: "attendance.card_scan", entityType: "ClassInstance", entityId: "s_wed", ...byJack, metadata: { classInstanceId: "s_wed", scanned: 1, recorded: 1, memberIds: ["m_a"] } });
    expect(entry(one).plain).toBe("Jack Streeter scanned Ada Obi in to Advanced No-Gi · Wed 4 Nov, 19:00");
    expect(entry(one).detail).toBeNull();
    const many = row({ action: "attendance.card_scan", entityType: "ClassInstance", entityId: "s_wed", ...byJack, metadata: { classInstanceId: "s_wed", memberIds: ["m_a", "m_b", "m_c", "m_mel"] } });
    const mine = entry(many, { focusMemberId: "m_mel" });
    expect(mine.plain).toBe("Melody Orekoya was scanned in to Advanced No-Gi · Wed 4 Nov, 19:00");
    expect(mine.detail).toBeNull();
    expect(mine.source).toEqual({ label: "Card scan", staff: JACK, support: false });
  });

  it("a removed check-in", () => {
    const e = entry(row({ action: "attendance.override", entityType: "AttendanceRecord", entityId: "s_wed:m_mel", ...byJack, metadata: { classInstanceId: "s_wed", memberId: "m_mel" } }));
    expect(e.plain).toBe("Jack Streeter removed Melody Orekoya's check-in from Advanced No-Gi · Wed 4 Nov, 19:00");
    expect(e.type).toBe("checkin_removed");
  });

  it("shows a name exactly as the club wrote it, even at the start of a sentence", () => {
    const L = lookups();
    L.members.set("m_lower", { name: "ffion ap Rhys", erased: false });
    const e = toFeedEntry(row({ action: "attendance.self_checkin", entityType: "AttendanceRecord", entityId: "rec", metadata: { classInstanceId: "s_wed", memberId: "m_lower", actorId: "m_lower" } }), ctx({ lookups: L }));
    expect(e.plain).toBe("ffion ap Rhys checked in to Advanced No-Gi · Wed 4 Nov, 19:00");
  });

  it("a session that has since been deleted is said so, never shown as an id", () => {
    const e = entry(row({ action: "attendance.self_checkin", entityType: "AttendanceRecord", entityId: "rec9", metadata: { classInstanceId: "s_gone", memberId: "m_mel", actorId: "m_mel" } }));
    expect(e.plain).toBe("Melody Orekoya checked in to a deleted session");
    expect(links(e.parts)).toEqual(["Melody Orekoya -> /dashboard/members/m_mel"]);
  });
});

describe("memberships", () => {
  const tierChange = (from: string | null, to: string | null) => row({ action: "member.update", ...byJack, metadata: { fields: ["membershipTierId"], changes: { membershipTierId: { from, to } } } });

  it("a staff plan change reads as put on, moved, or taken off", () => {
    expect(entry(tierChange(null, "t_adult")).plain).toBe("Jack Streeter put Melody Orekoya on Adult Unlimited");
    expect(entry(tierChange("t_twice", "t_adult")).plain).toBe("Jack Streeter moved Melody Orekoya from Twice a week (OLD) to Adult Unlimited");
    expect(entry(tierChange("t_adult", null)).plain).toBe("Jack Streeter took Melody Orekoya off Adult Unlimited");
    expect(entry(tierChange(null, "t_adult")).type).toBe("membership_changed");
  });

  it("a plan name is a link for the owner and plain text for a manager", () => {
    expect(links(entry(tierChange(null, "t_adult")).parts)).toContain("Adult Unlimited -> /dashboard/memberships");
    const forManager = links(entry(tierChange(null, "t_adult"), { role: "manager" }).parts);
    expect(forManager.some((l) => l.includes("/dashboard/memberships"))).toBe(false);
    expect(forManager).toContain("Melody Orekoya -> /dashboard/members/m_mel");
  });

  it("a staff cancellation — the only kind at a club that does not bill through Stripe", () => {
    const e = entry(row({ action: "member.update", ...byJack, metadata: { fields: ["status"], changes: { status: { from: "active", to: "cancelled" } } } }));
    expect(e.plain).toBe("Jack Streeter cancelled Melody Orekoya's membership");
    expect(e.type).toBe("cancellation");
  });

  it("a member asking to cancel, with the end date on the club's clock", () => {
    // Stripe's cancel_at, in seconds: 23:30 UTC on 30 Nov is 30 Nov in London.
    const e = entry(row({ action: "member.subscription.cancel", metadata: { initiator: "self", cancelAt: Date.UTC(2026, 10, 30, 23, 30) / 1000, actorId: "m_mel" } }));
    expect(e.plain).toBe("Melody Orekoya asked to cancel their membership — ends 30 Nov 2026");
    expect(e.type).toBe("cancellation");
    expect(e.source.label).toBe("Member app");
  });

  it("a subscription Stripe ended", () => {
    const e = entry(row({ action: "member.subscription.cancelled_by_stripe", metadata: { stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" } }));
    expect(e.plain).toBe("Melody Orekoya's membership ended");
    expect(e.source.label).toBe("Stripe");
  });

  it("a parent starting a child's membership says nothing has been paid yet", () => {
    const e = entry(row({ action: "member.subscription.create.kid", entityId: "m_kid", metadata: { parentMemberId: "m_faisal", priceId: "price_1", paymentMethodType: "card", actorId: "m_faisal" } }));
    expect(e.plain).toBe("Faisal Alshukri started a membership for Zara Alshukri — awaiting first payment");
    expect(e.type).toBe("membership_started");
  });

  it("holds", () => {
    const start = entry(row({ action: "member.hold.start", ...byJack, metadata: { holdUntil: "2026-12-01T00:00:00.000Z", priorPaymentStatus: "paid", stripeSubscriptionId: null, stripePaused: false } }));
    expect(start.plain).toBe("Jack Streeter put Melody Orekoya's membership on hold");
    expect(start.detailPlain).toBe("Until 1 Dec 2026");
    expect(entry(row({ action: "member.hold.end", ...byJack, metadata: { holdUntil: null } })).plain).toBe("Jack Streeter resumed Melody Orekoya's membership");
  });
});

describe("money", () => {
  it("a Stripe payment links the amount to that payment on the member's Payments tab", () => {
    const e = entry(row({ action: "member.payment.succeeded", metadata: { stripeInvoiceId: "in_1", amountPence: 4500, currency: "gbp" } }));
    expect(e.plain).toBe("Melody Orekoya paid £45.00");
    expect(links(e.parts)).toEqual(["Melody Orekoya -> /dashboard/members/m_mel", "£45.00 -> /dashboard/members/m_mel?tab=payments&paymentId=p_stripe"]);
    expect(e.source).toEqual({ label: "Stripe", staff: null, support: false });
  });

  it("a failed payment", () => {
    const e = entry(row({ action: "member.payment.failed", metadata: { stripeInvoiceId: "in_zzz", amountPence: 4500, currency: "gbp", reason: "card_declined" } }));
    expect(e.plain).toBe("Melody Orekoya's payment of £45.00 failed");
    expect(e.detailPlain).toBe("Reason: card declined");
    expect(e.type).toBe("payment_failed");
  });

  it("a payment recorded at the desk", () => {
    const e = entry(row({ action: "payment.manual", entityType: "Payment", entityId: "p_desk", ...byJack, metadata: { memberId: "m_faisal", method: "bank_transfer", amountPence: 2000, notes: "ref 12" } }));
    expect(e.plain).toBe("Jack Streeter recorded a £20.00 payment from Faisal Alshukri");
    expect(e.detailPlain).toBe("Paid by bank transfer");
    expect(JSON.stringify(e)).not.toContain("ref 12");
  });

  it("a refund names the member from the payment — the row itself carries none", () => {
    const e = entry(row({ action: "payment.refund", entityType: "Payment", entityId: "p_desk", ...byJack, metadata: { stripeRefundId: "re_1", amountPence: 500, cumulativeRefundedPence: 500, fullyRefunded: false, reason: "requested_by_customer" } }));
    expect(e.plain).toBe("Jack Streeter refunded £5.00 to Faisal Alshukri");
    expect(e.detailPlain).toBe("Part refund · Reason: requested by customer");
    expect(e.type).toBe("refund");
    expect(links(e.parts)).toContain("£5.00 -> /dashboard/members/m_faisal?tab=payments&paymentId=p_desk");
  });

  it("a card charge by its outcome", () => {
    const charge = (outcome?: string) => row({ action: "payment.adhoc.charge", ...byJack, metadata: { amountPence: 1500, description: "Private lesson", status: "x", ...(outcome ? { outcome } : {}), paymentIntentId: "pi_1", failureReason: null } });
    expect(entry(charge("succeeded")).plain).toBe("Jack Streeter charged Melody Orekoya's card £15.00");
    expect(entry(charge("succeeded")).type).toBe("payment");
    expect(entry(charge()).plain).toBe("Jack Streeter charged Melody Orekoya's card £15.00");
    expect(entry(charge("declined")).plain).toBe("Jack Streeter's £15.00 charge to Melody Orekoya's card was declined");
    expect(entry(charge("declined")).type).toBe("payment_failed");
    expect(entry(charge("unknown")).plain).toBe("Jack Streeter's £15.00 charge to Melody Orekoya's card was not confirmed");
    expect(entry(charge("rejected")).plain).toBe("Jack Streeter's £15.00 charge to Melody Orekoya's card could not be made");
    expect(entry(charge("declined")).detailPlain).toBe("Private lesson");
  });

  it("a payment reminder, sent or not", () => {
    expect(entry(row({ action: "payment.chase", ...byJack, metadata: { amountPence: 4500, emailSent: true } })).plain).toBe("Jack Streeter sent Melody Orekoya a payment reminder");
    expect(entry(row({ action: "payment.chase", ...byJack, metadata: { amountPence: 4500, emailSent: false, suppressed: true } })).plain).toBe("Jack Streeter tried to send Melody Orekoya a payment reminder — not sent");
  });

  it("a shop order marked paid names the order only when it resolves", () => {
    const paid = entry(row({ action: "order.mark_paid", entityType: "Order", entityId: "o_1", ...byJack, metadata: { reason: "Paid cash at the desk", previousStatus: "pending" } }));
    expect(paid.plain).toBe("Jack Streeter marked shop order ORD-LMRK4G as paid");
    expect(paid.detailPlain).toBe("£12.00 · Melody Orekoya · Reason: Paid cash at the desk");
    expect(entry(row({ action: "order.mark_paid", entityType: "Order", entityId: "o_gone", ...byJack, metadata: {} })).plain).toBe("Jack Streeter marked a shop order as paid");
  });

  it("a payment with no member has an amount that is not a link", () => {
    const L = lookups();
    L.payments.set("p_orphan", { id: "p_orphan", memberId: null, amountPence: 900, currency: "GBP", stripeInvoiceId: null });
    const e = toFeedEntry(row({ action: "payment.refund", entityType: "Payment", entityId: "p_orphan", ...byJack, metadata: { amountPence: 900, fullyRefunded: true } }), ctx({ lookups: L }));
    expect(e.plain).toBe("Jack Streeter refunded £9.00");
    expect(links(e.parts)).toEqual(["Jack Streeter -> /dashboard/activity?userId=u_jack"]);
  });
});

describe("ranks, classes and the rest", () => {
  it("a first grading, a new belt, a stripe and a demotion", () => {
    const promote = (m: Record<string, unknown>) => entry(row({ action: "member.rank.promote", ...byJack, metadata: m }));
    const first = promote({ fromRankId: null, fromStripes: null, toRankId: "r_white", stripes: 2 });
    expect(first.plain).toBe("Jack Streeter awarded Melody Orekoya White belt");
    expect(first.detailPlain).toBe("2 stripes");
    expect(promote({ fromRankId: "r_white", fromStripes: 4, toRankId: "r_blue", stripes: 0 }).plain).toBe("Jack Streeter promoted Melody Orekoya from White belt to Blue belt");
    expect(promote({ fromRankId: "r_blue", fromStripes: 2, toRankId: "r_blue", stripes: 3 }).plain).toBe("Jack Streeter awarded Melody Orekoya a stripe on Blue belt (now 3)");
    expect(promote({ toRankId: "r_blue", stripes: 0 }).plain).toBe("Jack Streeter promoted Melody Orekoya to Blue belt");
    expect(entry(row({ action: "member.rank.demote", ...byJack, metadata: { fromRankId: "r_blue", fromStripes: 1, stripes: 0, toRankId: "r_white", reason: null } })).plain).toBe("Jack Streeter moved Melody Orekoya back to White belt");
    expect(links(first.parts)).toContain("White belt -> /dashboard/ranks");
  });

  it("a photo attached while promoting is folded into the promotion", () => {
    const promotion = row({ action: "member.rank.promote", ...byJack, metadata: { fromRankId: "r_white", fromStripes: 4, toRankId: "r_blue", stripes: 0 }, createdAt: new Date("2026-11-04T19:45:10Z") });
    const photo = row({ action: "rank.photo_attached", ...byJack, metadata: { memberRankId: "mr1", caption: "Graded!" }, createdAt: new Date("2026-11-04T19:45:12Z") });
    const lonely = row({ action: "rank.photo_attached", entityId: "m_faisal", ...byJack, metadata: { memberRankId: "mr2", caption: null }, createdAt: new Date("2026-11-04T10:00:00Z") });
    const out = toFeedEntries([photo, promotion, lonely], ctx());
    expect(out.map((e) => e.id)).toEqual([promotion.id, lonely.id]);
    expect(out[0].detailPlain).toBe("Photo attached");
    expect(out[1].plain).toBe("Attached a photo to a rank change — Faisal Alshukri");
    expect(JSON.stringify(out)).not.toContain("Graded!");
  });

  it("class changes name the class and what was done to it", () => {
    const cls = (action: string, metadata: unknown) => entry(row({ action, entityType: "Class", entityId: "c_nogi", ...byJack, metadata }));
    expect(cls("class.created", { name: "Advanced No-Gi", instancesCreated: 8 }).plain).toBe("Jack Streeter created Advanced No-Gi");
    expect(cls("class.updated", { fields: ["isActive"], lifecycle: "paused" }).plain).toBe("Jack Streeter paused Advanced No-Gi");
    expect(cls("class.updated", { fields: ["isActive"], lifecycle: "paused" }).detail).toBeNull();
    expect(cls("class.updated", { fields: ["maxCapacity", "coachUserId"] }).detailPlain).toBe("Fields: Capacity, Coach");
    expect(cls("class.deleted", {}).plain).toBe("Jack Streeter archived Advanced No-Gi");
    expect(links(cls("class.updated", {}).parts)).toContain("Advanced No-Gi -> /dashboard/timetable?classId=c_nogi");
    expect(cls("class.updated", {}).type).toBe("class_changed");
  });

  it("roster changes and a cancelled session", () => {
    expect(entry(row({ action: "class.roster.add", entityType: "ClassRoster", entityId: "cr1", ...byJack, metadata: { classId: "c_nogi", memberId: "m_mel" } })).plain).toBe("Jack Streeter added Melody Orekoya to the Advanced No-Gi roster");
    const cancelled = entry(row({ action: "class.instance_cancelled", entityType: "ClassInstance", entityId: "s_wed", ...byJack, metadata: { classId: "c_nogi", date: "2026-11-04T00:00:00.000Z", startTime: "19:00", reason: "Coach ill" } }));
    expect(cancelled.plain).toBe("Jack Streeter cancelled Advanced No-Gi · Wed 4 Nov, 19:00");
    expect(cancelled.detailPlain).toBe("Reason: Coach ill");
    expect(cancelled.type).toBe("session_cancelled");
    // The session row is gone: the class, day and time recorded on the row still name it, without a link.
    const gone = entry(row({ action: "class.instance_cancelled", entityType: "ClassInstance", entityId: "s_gone", ...byJack, metadata: { classId: "c_nogi", date: "2026-11-05T00:00:00.000Z", startTime: "18:00", reason: null } }));
    expect(gone.plain).toBe("Jack Streeter cancelled Advanced No-Gi · Thu 5 Nov, 18:00");
    expect(links(gone.parts)).toEqual(["Jack Streeter -> /dashboard/activity?userId=u_jack"]);
  });

  it("waivers, including one a parent signs for a child", () => {
    expect(entry(row({ action: "waiver.sign", metadata: { signedWaiverId: "w1", collectedBy: "self" } })).plain).toBe("Melody Orekoya signed the waiver");
    expect(entry(row({ action: "waiver.sign", metadata: { signedWaiverId: "w1", collectedBy: "self" } })).source.label).toBe("Member app");
    const supervised = entry(row({ action: "waiver.sign.supervised", ...byJack, metadata: { signedWaiverId: "w2", collectedBy: "admin_device:u_jack", staffSupervisedBy: "u_jack", emergencyContactName: "Mum", emergencyContactPhone: "07700 900123" } }));
    expect(supervised.plain).toBe("Melody Orekoya signed the waiver at the desk");
    expect(supervised.source).toEqual({ label: "Staff", staff: JACK, support: false });
    expect(JSON.stringify(supervised)).not.toContain("07700");
    const forChild = entry(row({ action: "waiver.sign-for-child", entityId: "m_kid", metadata: { signedWaiverId: "w3", collectedBy: "m_faisal", childName: "Zara Alshukri" } }));
    expect(forChild.plain).toBe("Faisal Alshukri signed Zara Alshukri's waiver");
    expect(forChild.source.label).toBe("Member app");
  });

  it("the kiosk waiver row stores an email as its entity id: it is never looked up, linked or returned", () => {
    const e = entry(row({ action: "member.waiver.signed_via_kiosk", entityId: "someone@example.test", metadata: { signerName: "Some One", method: "kiosk_waiver_link" } }));
    expect(e.plain).toBe("Member signed the waiver at the kiosk");
    expect(JSON.stringify(e)).not.toContain("example.test");
    expect(JSON.stringify(e)).not.toContain("Some One");
    expect(e.source.label).toBe("Kiosk");
  });

  it("an undo row names who undid what", () => {
    const e = entry(row({ action: "undo.member.update", ...byJack, metadata: { undoneAuditId: "a1" } }));
    expect(e.plain).toBe("Jack Streeter undid: updated a member's details — Melody Orekoya");
    expect(e.type).toBe("undo");
    expect(entry(row({ action: "undo.class.updated", entityType: "Class", entityId: "c_nogi", ...byJack, metadata: { undoneLifecycle: "paused" } })).plain).toBe("Jack Streeter undid: paused a class — Advanced No-Gi");
  });

  it("an action with no template says exactly what its label says, then what it is about", () => {
    const e = entry(row({ action: "member.totp_reset", ...byJack, metadata: {} }));
    expect(e.plain).toBe("Reset a member's authenticator — Melody Orekoya");
    expect(e.source).toEqual({ label: "Staff", staff: JACK, support: false });
    expect(entry(row({ action: "announcement.created", entityType: "Announcement", entityId: "an1", ...byJack, metadata: {} })).plain).toBe("Posted an announcement");
    expect(entry(row({ action: "brand.new_thing", entityType: "Widget", entityId: "w1", metadata: null })).plain).toBe("Brand new thing");
    expect(entry(row({ action: "brand.new_thing", entityType: "Widget", entityId: "w1", metadata: null })).type).toBe("other");
  });

  it("a template that lacks what it needs falls back to the label, not to a broken sentence", () => {
    expect(entry(row({ action: "attendance.mark", entityType: "AttendanceRecord", entityId: "x:y", ...byJack, metadata: {} })).plain).toBe("Checked a member in");
    expect(entry(row({ action: "class.roster.add", entityType: "ClassRoster", entityId: "cr", ...byJack, metadata: {} })).plain).toBe("Added a member to a class roster");
    // No staff member on the row (their account was removed): told in the passive, not attributed to anyone.
    expect(entry(row({ action: "member.update", metadata: { changes: { phone: { from: "1", to: "2" } } } })).plain).toBe("Melody Orekoya's details were updated");
  });
});

describe("deleted and erased members", () => {
  it("an erased member is 'Deleted member', never a link, and old values are shown to nobody", () => {
    const e = entry(row({ action: "member.update", entityId: "m_erased", ...byJack, metadata: { changes: { phone: { from: "07700 900111", to: "07700 900222" }, name: { from: "Real Name", to: "Other Name" } } } }));
    expect(e.plain).toBe("Jack Streeter updated Deleted member's details");
    expect(links(e.parts)).toEqual(["Jack Streeter -> /dashboard/activity?userId=u_jack"]);
    expect(e.detailPlain).toBe("Fields: Phone, Name");
    expect(e.changes).toEqual([{ label: "Phone", from: null, to: null }, { label: "Name", from: null, to: null }]);
    const body = JSON.stringify(e);
    for (const secret of ["07700", "Real Name", "Other Name"]) expect(body).not.toContain(secret);
  });

  it("a deleted member keeps the name recorded on their deletion; without one they are 'a deleted member'", () => {
    const named = entry(row({ action: "attendance.self_checkin", entityType: "AttendanceRecord", entityId: "r", metadata: { classInstanceId: "s_wed", memberId: "m_named", actorId: "m_named" } }));
    expect(named.plain).toBe("Jane Smith (deleted) checked in to Advanced No-Gi · Wed 4 Nov, 19:00");
    expect(links(named.parts)).toEqual(["Advanced No-Gi · Wed 4 Nov, 19:00 -> /dashboard/attendance?instance=s_wed"]);
    const unnamed = entry(row({ action: "attendance.self_checkin", entityType: "AttendanceRecord", entityId: "r", metadata: { classInstanceId: "s_wed", memberId: "m_unknown", actorId: "m_unknown" } }));
    expect(unnamed.plain).toBe("A deleted member checked in to Advanced No-Gi · Wed 4 Nov, 19:00");
    const edit = entry(row({ action: "member.update", entityId: "m_unknown", ...byJack, metadata: { changes: { phone: { from: "07700 900111", to: "07700 900222" } } } }));
    expect(edit.detailPlain).toBe("Fields: Phone");
    expect(JSON.stringify(edit)).not.toContain("07700");
  });

  it("the deletion row itself carries the name when one was recorded", () => {
    expect(entry(row({ action: "member.delete", entityId: "m_named", ...byJack, metadata: { name: "Jane Smith", kidsAffected: 0 } })).plain).toBe("Jack Streeter deleted Jane Smith");
    expect(entry(row({ action: "member.delete", entityId: "m_gone", ...byJack, metadata: { kidsAffected: 0 } })).plain).toBe("Jack Streeter deleted a member");
    expect(entry(row({ action: "member.delete", entityId: "m_gone", ...byJack, metadata: {} })).type).toBe("member_removed");
  });
});

describe("what changed", () => {
  const edit = row({
    action: "member.update",
    ...byJack,
    metadata: {
      fields: ["phone", "membershipTierId"],
      changes: {
        phone: { from: null, to: "07700 900123" },
        dateOfBirth: { from: "1990-01-01", to: "1991-02-03" },
        nextDueAt: { from: "2026-11-30T23:30:00.000Z", to: null },
        leaderboardOptOut: { from: false, to: true },
        paymentStatus: { from: "paid", to: "overdue" },
      },
    },
  });

  it("the owner sees every changed field with its old and new value, in words", () => {
    const e = entry(edit);
    expect(e.changes).toEqual([
      { label: "Phone", from: "—", to: "07700 900123" },
      { label: "Date of birth", from: "1 Jan 1990", to: "3 Feb 1991" },
      // 23:30 UTC on 30 Nov is still 30 Nov on the club's clock.
      { label: "Next payment due", from: "30 Nov 2026", to: "—" },
      { label: "Hidden from the leaderboard", from: "off", to: "on" },
      { label: "Payment status", from: "paid", to: "overdue" },
    ]);
    expect(e.detailPlain).toBe("Phone: — → 07700 900123 · Date of birth: 1 Jan 1990 → 3 Feb 1991 · Next payment due: 30 Nov 2026 → — · Hidden from the leaderboard: off → on · Payment status: paid → overdue");
  });

  it("a manager sees which fields changed, never what they held", () => {
    const e = entry(edit, { role: "manager" });
    expect(e.detailPlain).toBe("Fields: Phone, Date of birth, Next payment due, Hidden from the leaderboard, Payment status");
    expect(e.changes?.every((c) => c.from === null && c.to === null)).toBe(true);
    expect(JSON.stringify(e)).not.toContain("07700");
    expect(JSON.stringify(e)).not.toContain("→");
  });

  it("ids become names, and a before/after snapshot is read as a change list", () => {
    const tier = entry(row({ action: "member.update", ...byJack, metadata: { changes: { membershipTierId: { from: "t_twice", to: "t_adult" } } } }));
    expect(tier.changes).toEqual([{ label: "Plan", from: "Twice a week (OLD)", to: "Adult Unlimited" }]);
    const plan = entry(row({ action: "membership.tier.update", entityType: "MembershipTier", entityId: "t_adult", ...byJack, metadata: { before: { name: "Adult", pricePence: 4000, currency: "GBP", isActive: true }, after: { name: "Adult Unlimited", pricePence: 4500, currency: "GBP", isActive: true } } }));
    expect(plan.changes).toEqual([{ label: "Name", from: "Adult", to: "Adult Unlimited" }, { label: "Price", from: "£40.00", to: "£45.00" }]);
    expect(plan.plain).toBe("Updated a membership plan — Adult Unlimited");
    expect(plan.type).toBe("plan_setup");
  });

  it("never prints a column name or a bare record id", () => {
    const e = entry(row({ action: "class.updated", entityType: "Class", entityId: "c_nogi", ...byJack, metadata: { before: { coachUserId: "u_sean", requiredRankId: null, someNewThingId: "cmb1x2y3z4a5b6c7d8e9f0g1h" }, after: { coachUserId: "u_jack", requiredRankId: "r_blue", someNewThingId: "cmc1x2y3z4a5b6c7d8e9f0g1h" } } }));
    expect(e.changes).toEqual([{ label: "Coach", from: "Sean Coates", to: "Jack Streeter" }, { label: "Lowest rank allowed", from: "—", to: "Blue belt" }, { label: "Some new thing", from: "(changed)", to: "(changed)" }]);
    expect(e.detailPlain).not.toMatch(/[a-z][A-Z]/);
    expect(e.detailPlain).not.toMatch(/\bc[a-z0-9]{24}\b/);
  });
});

describe("source", () => {
  const L = lookups();
  it("one case per rule, in order", () => {
    const of = (over: Partial<FeedRow> & Pick<FeedRow, "action">) => sourceOf(row(over), L).label;
    expect(of({ action: "member.update", ...byJack, operatorId: "op1" })).toBe("MatFlow support");
    expect(of({ action: "member.update", ...byJack, metadata: { actingAs: "op1" } })).toBe("MatFlow support");
    expect(of({ action: "admin.tenant.suspended", operatorId: "op1" })).toBe("MatFlow support");
    expect(of({ action: "attendance.kiosk_checkin", metadata: { actorId: "m_mel" } })).toBe("Kiosk");
    expect(of({ action: "attendance.card_scan", ...byJack })).toBe("Card scan");
    expect(of({ action: "member.update", ...byJack })).toBe("Staff");
    expect(of({ action: "member.payment.succeeded" })).toBe("Stripe");
    expect(of({ action: "stripe.dispute.needs_response" })).toBe("Stripe");
    expect(of({ action: "attendance.self_checkin", metadata: { actorId: "m_mel" } })).toBe("Member app");
    expect(of({ action: "billing.portal.open" })).toBe("Member app");
    expect(of({ action: "class.instances_generated" })).toBe("Automatic");
  });

  it("a support edit is told as MatFlow support's, not as the account it was made through", () => {
    const e = entry(row({ action: "member.update", ...byJack, operatorId: "op1", metadata: { actingAs: "op1", changes: { phone: { from: "1", to: "2" } } } }));
    expect(e.plain).toBe("MatFlow support updated Melody Orekoya's details");
    expect(e.source).toEqual({ label: "MatFlow support", staff: null, support: true });
    expect(JSON.stringify(e)).not.toContain("op1");
    expect(JSON.stringify(e)).not.toContain("Jack Streeter");
    const charge = entry(row({ action: "payment.adhoc.charge", ...byJack, metadata: { actingAs: "op1", amountPence: 1500, outcome: "declined" } }));
    expect(charge.plain).toBe("MatFlow support's £15.00 charge to Melody Orekoya's card was declined");
  });

  it("a staff action whose author's account has been removed is still staff, not automatic", () => {
    const e = entry(row({ action: "member.update", metadata: { changes: { phone: { from: "1", to: "2" } } } }));
    expect(e.plain).toBe("Melody Orekoya's details were updated");
    expect(e.source).toEqual({ label: "Staff (account removed)", staff: null, support: false });
    // A durable row records that a user made it; a member's own action carries their id and is not mistaken for staff.
    expect(sourceOf(row({ action: "member.hold.end", metadata: { actorType: "user" } }), lookups()).label).toBe("Staff (account removed)");
    expect(sourceOf(row({ action: "member.subscription.cancel", metadata: { actorType: "user", actorId: "m_mel" } }), lookups()).label).toBe("Member app");
    expect(sourceOf(row({ action: "member.hold.end", metadata: {} }), lookups()).label).toBe("Automatic");
    expect(sourceOf(row({ action: "task.member_note.complete", metadata: { memberId: "m_mel" } }), lookups()).label).toBe("Member app");
  });

  it("no entry names the same person in the sentence and in the source", () => {
    const rows = [
      row({ action: "member.update", ...byJack, metadata: {} }),
      row({ action: "member.totp_reset", ...byJack, metadata: {} }),
      row({ action: "staff.update", entityType: "User", entityId: "u_sean", ...byJack, metadata: {} }),
      row({ action: "user.password.changed", entityType: "User", entityId: JACK.id, ...byJack, metadata: {} }),
    ];
    for (const e of rows.map((r) => entry(r))) {
      const inSentence = links(e.parts).filter((l) => l.includes("/dashboard/activity?userId=")).map((l) => l.split("userId=")[1]);
      if (e.source.staff) expect(inSentence, e.plain).not.toContain(e.source.staff.id);
    }
    expect(entry(rows[2]).plain).toBe("Updated a staff member — Sean Coates");
    expect(entry(rows[3]).plain).toBe("Changed their own password (signed out everywhere)");
  });
});

describe("hrefFor", () => {
  it("every kind, for each role", () => {
    for (const role of ["owner", "manager"] as const) {
      expect(hrefFor({ kind: "member", id: "m1" }, role)).toBe("/dashboard/members/m1");
      expect(hrefFor({ kind: "class", id: "c1" }, role)).toBe("/dashboard/timetable?classId=c1");
      expect(hrefFor({ kind: "session", id: "inst-c1-2026-11-04-19:00" }, role)).toBe("/dashboard/attendance?instance=inst-c1-2026-11-04-19%3A00");
      expect(hrefFor({ kind: "payment", id: "p1", memberId: "m1" }, role)).toBe("/dashboard/members/m1?tab=payments&paymentId=p1");
      expect(hrefFor({ kind: "payment", id: "p1", memberId: null }, role)).toBeNull();
      expect(hrefFor({ kind: "staff", id: "u1" }, role)).toBe("/dashboard/activity?userId=u1");
      expect(hrefFor({ kind: "rank", id: "r1" }, role)).toBe("/dashboard/ranks");
      expect(hrefFor({ kind: "venue", id: "v1" }, role)).toBeNull();
    }
    expect(hrefFor({ kind: "tier", id: "t1" }, "owner")).toBe("/dashboard/memberships");
    expect(hrefFor({ kind: "pack", id: "k1" }, "owner")).toBe("/dashboard/memberships");
    expect(hrefFor({ kind: "tier", id: "t1" }, "manager")).toBeNull();
    expect(hrefFor({ kind: "pack", id: "k1" }, "manager")).toBeNull();
  });

  it("a manager is never sent a link to an owner-only page", () => {
    const kinds = ["member", "class", "session", "payment", "tier", "pack", "staff", "venue", "rank"] as const;
    for (const kind of kinds) {
      const href = hrefFor({ kind, id: "x1", memberId: "m1" }, "manager");
      if (href) expect(href).not.toMatch(/^\/dashboard\/(memberships|settings)/);
    }
  });
});

describe("the entry as a whole", () => {
  it("carries the club day, the instant and the undo decision it is given", () => {
    // 23:30 UTC on 24 Oct is 00:30 on 25 Oct in London (still summer time).
    const late = row({ action: "member.update", ...byJack, metadata: {}, createdAt: new Date("2026-10-24T23:30:00Z") });
    const e = toFeedEntry(late, ctx(), { undone: false, undo: { ok: true } });
    expect(e.dayKey).toBe("2026-10-25");
    expect(e.at).toBe("2026-10-24T23:30:00.000Z");
    expect(e.undo).toEqual({ ok: true, sinceHere: { userId: JACK.id, name: JACK.name } });
    expect(toFeedEntry(late, ctx(), { undo: { ok: false, reason: "Already undone." }, undone: true })).toMatchObject({ undone: true, undo: { ok: false, reason: "Already undone." } });
    expect("undo" in toFeedEntry(late, ctx())).toBe(false);
    // A reversible row with no staff member behind it offers no "since here".
    expect(toFeedEntry(row({ action: "attendance.self_checkin", metadata: { memberId: "m_mel", actorId: "m_mel" } }), ctx(), { undo: { ok: true } }).undo).toEqual({ ok: true, sinceHere: null });
  });

  it("every labelled action yields a clean sentence with no lookups at all", () => {
    const bare = { lookups: emptyLookups(), role: "owner" as const, timeZone: TZ };
    for (const action of Object.keys(AUDIT_LABELS)) {
      for (const metadata of [null, {}, { memberId: "m1", classInstanceId: "s1", classId: "c1", amountPence: 100, memberIds: ["m1", "m2"], toRankId: "r1", fromRankId: null }]) {
        const e: FeedEntry = toFeedEntry(row({ action, metadata, ...byJack }), bare);
        for (const textOut of [e.plain, e.detailPlain ?? ""]) {
          expect(textOut, action).not.toMatch(/undefined|null|NaN|\[object/);
          expect(textOut, action).not.toMatch(/ {2}/);
          expect(textOut, action).not.toMatch(/\bc[a-z0-9]{24}\b/);
        }
        expect(e.plain.length, action).toBeGreaterThan(8);
        expect(e.plain.charAt(0), action).toBe(e.plain.charAt(0).toUpperCase());
      }
    }
  });

  it("the plain fallback says what happened without any names", () => {
    const e = plainFallbackEntry(row({ action: "member.update", ...byJack, metadata: { changes: { phone: { from: "07700 900111", to: "2" } } } }), { timeZone: TZ }, { undo: { ok: true } });
    expect(e.plain).toBe("Updated a member's details");
    expect(e.parts).toEqual([{ text: "Updated a member's details" }]);
    expect(e.detail).toBeNull();
    expect(e.changes).toBeNull();
    expect(e.source).toEqual({ label: "Staff", staff: JACK, support: false });
    expect(e.undo).toEqual({ ok: true, sinceHere: { userId: JACK.id, name: JACK.name } });
    expect(JSON.stringify(e)).not.toContain("07700");
  });

  it("serialises none of the row's private fields, for either role", () => {
    const loud = row({
      action: "member.create",
      ...byJack,
      operatorId: "op_secret",
      metadata: { name: "Melody Orekoya", email: "melody@example.test", actingAs: "op_secret", requestId: "req_1", ipAddress: "203.0.113.9" },
    });
    for (const role of ["owner", "manager"] as const) {
      const body = JSON.stringify(toFeedEntry(loud, ctx({ role }), role === "owner" ? { undo: { ok: true } } : {}));
      for (const key of ["metadata", "ipAddress", "userAgent", "operatorId", "requestId", "actingAs", "email", "tenantId", "example.test", "op_secret", "203.0.113"]) expect(body, `${role}: ${key}`).not.toContain(key);
    }
  });
});

// ── Pinned after the independent reviews of 5 Nov 2026 ───────────────────────

describe("what a member edit is said to have changed", () => {
  // The profile form sends every field on each save; `fields` is what was SENT, not what changed.
  const SENT = ["updatedAt", "name", "phone", "emergencyContactName", "emergencyContactPhone", "emergencyContactRelation", "dateOfBirth", "email", "membershipTierId", "status", "trialRunById", "creditedToUserId", "creditedToMemberId", "creditedToLabel"];

  it("an email-only edit says Email — the row holds two digests that differ, and nothing else changed", () => {
    const e = entry(row({ action: "member.update", ...byJack, metadata: { fields: SENT, oldEmailSha256: "aaa", newEmailSha256: "bbb", unverified: true, sessionsRevoked: true } }));
    expect(e.plain).toBe("Jack Streeter updated Melody Orekoya's details");
    expect(e.detailPlain).toBe("Fields: Email");
    expect(e.changes).toBeNull();
    expect(JSON.stringify(e)).not.toMatch(/aaa|bbb/);
  });

  it("a save that changed nothing lists no fields at all", () => {
    const e = entry(row({ action: "member.update", ...byJack, metadata: { fields: SENT } }));
    expect(e.detail).toBeNull();
    expect(e.detailPlain).toBeNull();
  });

  it("a notes save says Notes; the concurrency token is never called a field", () => {
    expect(entry(row({ action: "member.update", ...byJack, metadata: { fields: ["updatedAt", "notes"] } })).detailPlain).toBe("Fields: Notes");
    expect(entry(row({ action: "member.update", ...byJack, metadata: { fields: ["updatedAt", "medicalConditions"] } })).detailPlain).toBe("Fields: Medical details");
    expect(entry(row({ action: "class.updated", entityType: "Class", entityId: "c_nogi", ...byJack, metadata: { fields: ["updatedAt", "maxCapacity"] } })).detailPlain).toBe("Fields: Capacity");
    expect(entry(row({ action: "member.update", ...byJack, metadata: { fields: ["email"] } })).detailPlain).toBe("Fields: Email");
  });

  it("an email change alongside a diff is added to it, for the owner and for a manager", () => {
    const edit = row({ action: "member.update", ...byJack, metadata: { fields: SENT, changes: { phone: { from: "1", to: "2" } }, oldEmailSha256: "aaa", newEmailSha256: "bbb" } });
    expect(entry(edit).detailPlain).toBe("Phone: 1 → 2 · Also changed: Email");
    expect(entry(edit, { role: "manager" }).detailPlain).toBe("Fields: Phone, Email");
  });

  it("an archived class does not also say Active: on → off", () => {
    const e = entry(row({ action: "class.deleted", entityType: "Class", entityId: "c_nogi", ...byJack, metadata: { before: { isActive: true, deletedAt: null }, after: { isActive: false, deletedAt: "2026-11-05T10:00:00.000Z" } } }));
    expect(e.plain).toBe("Jack Streeter archived Advanced No-Gi");
    expect(e.changes).toEqual([{ label: "Archived", from: "—", to: "5 Nov 2026" }]);
  });
});

describe("free text is shown only to whom it is for", () => {
  const demotion = row({ action: "member.rank.demote", ...byJack, metadata: { fromRankId: "r_blue", fromStripes: 1, stripes: 0, toRankId: "r_white", reason: "Graded in error" } });

  it("a reason staff typed about a member is for the owner, not a manager", () => {
    expect(entry(demotion).detailPlain).toBe("Reason: Graded in error");
    expect(entry(demotion, { role: "manager" }).detail).toBeNull();
    expect(JSON.stringify(entry(demotion, { role: "manager" }))).not.toContain("Graded in error");
  });

  it("a cancelled session's reason and a provider's failure code are for anyone who may see the row", () => {
    const cancelled = row({ action: "class.instance_cancelled", entityType: "ClassInstance", entityId: "s_wed", ...byJack, metadata: { classId: "c_nogi", date: "2026-11-04T00:00:00.000Z", startTime: "19:00", reason: "Coach ill" } });
    expect(entry(cancelled, { role: "manager" }).detailPlain).toBe("Reason: Coach ill");
    const failed = row({ action: "member.payment.failed", metadata: { amountPence: 4500, currency: "gbp", reason: "card_declined" } });
    expect(entry(failed, { role: "manager" }).detailPlain).toBe("Reason: card declined");
  });

  it("nothing typed about a member is shown once they are erased or deleted", () => {
    const aboutErased = row({ action: "member.rank.demote", entityId: "m_erased", ...byJack, metadata: { fromRankId: "r_blue", fromStripes: 1, stripes: 0, toRankId: "r_white", reason: "Private remark" } });
    expect(JSON.stringify(entry(aboutErased))).not.toContain("Private remark");
    const charge = row({ action: "payment.adhoc.charge", entityId: "m_unknown", ...byJack, metadata: { amountPence: 1500, description: "Catch-up for Jane", outcome: "succeeded" } });
    expect(JSON.stringify(entry(charge))).not.toContain("Catch-up for Jane");
  });
});

describe("amounts", () => {
  it("an amount with no currency on its row is in the club's currency, not assumed to be pounds", () => {
    const charge = row({ action: "payment.adhoc.charge", ...byJack, metadata: { amountPence: 1500, outcome: "succeeded" } });
    expect(entry(charge, { currency: "EUR" }).plain).toBe("Jack Streeter charged Melody Orekoya's card €15.00");
    expect(entry(charge).plain).toBe("Jack Streeter charged Melody Orekoya's card £15.00");
    const reminder = entry(row({ action: "payment.chase", ...byJack, metadata: { amountPence: 4500, emailSent: true } }), { currency: "USD" });
    expect(reminder.detailPlain).toBe("Reminder for US$45.00");
  });

  it("a currency code nobody recognises is printed as written; it never fails the page", () => {
    const L = lookups();
    L.payments.set("p_odd", { id: "p_odd", memberId: "m_mel", amountPence: 2000, currency: "1AB", stripeInvoiceId: null });
    const e = toFeedEntry(row({ action: "payment.manual", entityType: "Payment", entityId: "p_odd", ...byJack, metadata: { memberId: "m_mel", method: "cash", amountPence: 2000 } }), ctx({ lookups: L }));
    expect(e.plain).toBe("Jack Streeter recorded a 20.00 1AB payment from Melody Orekoya");
  });

  it("one row that cannot be described is shown as its label; the rest of the page is unaffected", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const L = lookups();
    const realGet = L.sessions.get.bind(L.sessions);
    L.sessions.get = (key: string) => {
      if (key === "s_bad") throw new Error("boom");
      return realGet(key);
    };
    const bad = row({ action: "attendance.self_checkin", entityType: "AttendanceRecord", entityId: "r1", metadata: { classInstanceId: "s_bad", memberId: "m_mel", actorId: "m_mel" } });
    const good = row({ action: "attendance.self_checkin", entityType: "AttendanceRecord", entityId: "r2", metadata: { classInstanceId: "s_wed", memberId: "m_mel", actorId: "m_mel" } });
    const out = toFeedEntries([bad, good], ctx({ lookups: L }));
    expect(out.map((e) => e.plain)).toEqual(["Member checked themselves in", "Melody Orekoya checked in to Advanced No-Gi · Wed 4 Nov, 19:00"]);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

describe("sentences corrected after review", () => {
  it("a register tick for someone already checked in is a confirmation, not a second check-in", () => {
    const e = entry(row({ action: "attendance.mark", entityType: "AttendanceRecord", entityId: "s_wed:m_mel", ...byJack, metadata: { classInstanceId: "s_wed", memberId: "m_mel", created: false } }));
    expect(e.plain).toBe("Jack Streeter confirmed Melody Orekoya's check-in for Advanced No-Gi · Wed 4 Nov, 19:00");
  });

  it("stripes on the same belt: gained, lost, or simply updated when the row does not say", () => {
    const same = (fromStripes: number | undefined, stripes: number) => entry(row({ action: "member.rank.promote", ...byJack, metadata: { fromRankId: "r_blue", ...(fromStripes === undefined ? {} : { fromStripes }), toRankId: "r_blue", stripes } })).plain;
    expect(same(2, 3)).toBe("Jack Streeter awarded Melody Orekoya a stripe on Blue belt (now 3)");
    expect(same(1, 3)).toBe("Jack Streeter awarded Melody Orekoya 2 stripes on Blue belt (now 3)");
    expect(same(3, 2)).toBe("Jack Streeter removed a stripe from Melody Orekoya's Blue belt (now 2)");
    expect(same(2, 2)).toBe("Jack Streeter updated Melody Orekoya's Blue belt (now 2)");
    expect(same(undefined, 2)).toBe("Jack Streeter updated Melody Orekoya's Blue belt (now 2)");
  });

  it("a parent removing a child names the child, from the row", () => {
    const e = entry(row({ action: "member.child.delete", entityId: "m_gone_kid", metadata: { parentMemberId: "m_faisal", childName: "Zara Alshukri", actorId: "m_faisal" } }));
    expect(e.plain).toBe("Faisal Alshukri removed Zara Alshukri");
    expect(e.type).toBe("member_removed");
  });

  it("a child's cancellation that was only requested is not said to have happened", () => {
    const e = entry(row({ action: "member.subscription.cancel.kid", entityId: "m_kid", metadata: { cancelAt: Date.UTC(2026, 10, 30, 12) / 1000 } }));
    expect(e.plain).toBe("A cancellation was requested for Zara Alshukri's membership — ends 30 Nov 2026");
  });

  it("guardian decisions name the guardian", () => {
    const meta = { parentMemberId: "m_faisal", suggestedBy: "import", wasConfirmed: false };
    expect(entry(row({ action: "member.guardian.confirmed", entityId: "m_kid", ...byJack, metadata: meta })).plain).toBe("Jack Streeter confirmed Faisal Alshukri as Zara Alshukri's guardian");
    expect(entry(row({ action: "member.guardian.rejected", entityId: "m_kid", ...byJack, metadata: meta })).plain).toBe("Jack Streeter removed Faisal Alshukri as Zara Alshukri's suggested guardian");
  });

  it("a staff task names who it is for", () => {
    expect(entry(row({ action: "task.staff_task.create", entityType: "Task", entityId: "t1", ...byJack, metadata: { assignedToId: "u_sean", titleLength: 12 } })).plain).toBe("Jack Streeter created a task for Sean Coates");
    // A task for yourself has nobody else to name.
    expect(entry(row({ action: "task.staff_task.create", entityType: "Task", entityId: "t2", ...byJack, metadata: { assignedToId: JACK.id, titleLength: 12 } })).plain).toBe("Created a staff task");
  });

  it("a dispute says how much, on which payment, and by when to respond", () => {
    const dispute = (status: string, extra: Record<string, unknown> = {}) => entry(row({ action: `stripe.dispute.${status}`, metadata: { stripeDisputeId: "dp_1", chargeId: "ch_1", paymentId: "p_stripe", status, amountPence: 4500, reason: "fraudulent", evidenceDueAt: "2026-11-12T23:59:59.000Z", ...extra } }));
    const open = dispute("needs_response");
    expect(open.plain).toBe("The dispute over Melody Orekoya's £45.00 payment needs a response — respond by 12 Nov 2026");
    expect(open.type).toBe("payment_failed");
    expect(open.detailPlain).toBe("Reason: fraudulent");
    expect(links(open.parts)).toContain("£45.00 -> /dashboard/members/m_mel?tab=payments&paymentId=p_stripe");
    expect(dispute("won").plain).toBe("The dispute over Melody Orekoya's £45.00 payment was won");
    expect(dispute("lost").plain).toBe("The dispute over Melody Orekoya's £45.00 payment was lost");
    expect(JSON.stringify(open)).not.toMatch(/dp_1|ch_1/);
    // Not tied to a member: the row's own label.
    expect(entry(row({ action: "stripe.dispute.lost", entityType: "Dispute", entityId: "dp_2", metadata: { amountPence: 4500 } })).plain).toBe("Dispute lost");
  });

  it("a failed class-pack payment names the pack, and says less when the checkout had none", () => {
    expect(entry(row({ action: "stripe.checkout.class_pack_payment_failed", entityType: "ClassPack", entityId: "pk_10", metadata: { sessionId: "cs_1", memberId: "m_mel" } })).plain).toBe("Melody Orekoya's payment for the 10 class pack failed — no classes were added");
    const noPack = entry(row({ action: "stripe.checkout.class_pack_payment_failed", entityType: "ClassPack", entityId: "cs_test_a1B2c3", metadata: { sessionId: "cs_test_a1B2c3", memberId: "m_mel" } }));
    expect(noPack.plain).toBe("Melody Orekoya's class pack payment failed — no classes were added");
    expect(JSON.stringify(noPack)).not.toContain("cs_test");
  });
});
