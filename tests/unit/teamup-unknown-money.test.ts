/**
 * Unknown money (Total BJJ handover, 3 Oct 2026). TeamUp's export carries no
 * prices or cycles, so the tiers created for its plan labels have no real
 * price. The recommended tier (scripts/readiness/teamup-tier-plan.mjs
 * tierFields): price 0, billing cycle "none", not a kids plan, no Stripe
 * price, description "Price not yet confirmed — billed by TeamUp (…)".
 *
 * Pinned here: a TeamUp-billed member on such a tier
 *  (a) is never overdue and never "No payment yet" — not by the list queries
 *      (lib/overdue.ts overdueClause / noPaymentYetWhere), and no due date is
 *      ever seeded for them, by the import or by a later tier change;
 *  (b) produces no revenue (revenue is summed from Payment rows only), and is
 *      never labelled "Free" — the import and the refresh never write
 *      paymentStatus "free".
 */
import { describe, it, expect, vi } from "vitest";
import { overdueClause, noPaymentYetWhere, owesMoneyClause, advanceDueDate, isOverdue } from "@/lib/overdue";
import { membershipTierWrite } from "@/lib/membership-tier";
import { paymentStatusLabel } from "@/lib/payment-status";
import { parseTeamUp } from "@/lib/importers/teamup";
import { standingFromDraft, tierMap } from "@/lib/importers/teamup-refresh";
import { tierFields } from "../../scripts/readiness/teamup-tier-plan.mjs";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

// ── A Prisma `where` evaluated in memory (the shapes lib/overdue.ts uses) ────

type Row = Record<string, unknown>;
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Row[]).some((w) => matches(row, w));
    if (v === null) return (row[k] ?? null) === null;
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const op = v as { not?: unknown; in?: unknown[]; notIn?: unknown[]; lt?: Date };
      if ("not" in op) return (row[k] ?? null) !== op.not;
      if ("notIn" in op) return !op.notIn!.includes(row[k]);
      if ("in" in op) return op.in!.includes(row[k]);
      if ("lt" in op) return row[k] instanceof Date && (row[k] as Date) < op.lt!;
      throw new Error(`unhandled operator on ${k}`);
    }
    return (row[k] ?? null) === v;
  });
}

const NOW = new Date("2026-11-15T12:00:00Z");
const TIER = { id: "tier_aa", ...tierFields("Adults Advanced 2026") };

function teamupMember(over: Row = {}): Row {
  return {
    billedBy: "teamup",
    status: "active",
    paymentStatus: "paid",
    membershipTierId: TIER.id,
    nextDueAt: null,
    stripeSubscriptionId: null,
    ...over,
  };
}

describe("(a) a TeamUp-billed member on a price-not-set tier never owes MatFlow anything", () => {
  for (const paymentStatus of ["paid", "paused", "cancelled", "pending", "free"]) {
    it(`paymentStatus ${paymentStatus}: not in overdueClause, not in noPaymentYetWhere`, () => {
      const m = teamupMember({ paymentStatus });
      expect(matches(m, { OR: overdueClause(NOW) })).toBe(paymentStatus === "overdue");
      expect(matches(m, noPaymentYetWhere())).toBe(false);
      expect(matches(m, { OR: owesMoneyClause(NOW) })).toBe(false);
    });
  }

  it("even with a due date in the past (set by hand), the list queries leave a TeamUp member out", () => {
    const m = teamupMember({ nextDueAt: new Date("2026-10-01T00:00:00Z") });
    expect(matches(m, { OR: overdueClause(NOW) })).toBe(false);
  });

  it("the same member billed by MatFlow WOULD be listed — the exclusion is billedBy, not luck", () => {
    expect(matches(teamupMember({ billedBy: "matflow", nextDueAt: new Date("2026-10-01T00:00:00Z") }), { OR: overdueClause(NOW) })).toBe(true);
    expect(matches(teamupMember({ billedBy: "matflow", paymentStatus: "pending" }), noPaymentYetWhere())).toBe(true);
  });

  it("no due date is seeded: not by the TeamUp import (no opts), not by a staff tier change (cycle none)", () => {
    // app/api/admin/import/[id]/commit/route.ts: membershipTierWrite(tier, undefined) for TeamUp.
    expect(membershipTierWrite(TIER, undefined)).toEqual({ membershipTierId: TIER.id, membershipType: TIER.name });
    // app/api/members/[id]/route.ts: membershipTierWrite(tier, { currentNextDueAt }) on a staff tier change.
    expect(membershipTierWrite(TIER, { currentNextDueAt: null, now: NOW }).nextDueAt).toBeUndefined();
    expect(advanceDueDate(null, TIER.billingCycle, NOW)).toBeNull();
    // With no due date the in-memory rule agrees: not overdue.
    expect(isOverdue({ paymentStatus: "paid", nextDueAt: null }, NOW)).toBe(false);
  });

  it("cycle 'none' is belt and braces: a recurring cycle seeds a date for a MatFlow-billed member, never a TeamUp one", () => {
    const fourWeekly = { ...TIER, billingCycle: "four_weekly" };
    expect(membershipTierWrite(fourWeekly, { currentNextDueAt: null, now: NOW }).nextDueAt).toBeInstanceOf(Date);
    // 23122b5 (3 Oct 2026): the tier write and the in-memory rule now both skip TeamUp-billed members.
    expect(membershipTierWrite(fourWeekly, { currentNextDueAt: null, now: NOW, billedBy: "teamup" }).nextDueAt).toBeUndefined();
    expect(isOverdue({ paymentStatus: "paid", nextDueAt: new Date("2026-10-01T00:00:00Z"), billedBy: "teamup" }, NOW)).toBe(false);
  });
});

// ── (b) revenue and the word "Free" ───────────────────────────────────────────

const HEADER = "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
const r = (name: string, email: string, plan: string, status: string, start: string, extra: { expiry?: string; cancelled?: string; type?: string; dob?: string; completed?: string } = {}) =>
  [name, email, "", plan, extra.type ?? "recurring", status, "Stripe", start, start, extra.expiry ?? "", extra.cancelled ?? "", "Yes", extra.completed ?? "", "", "", "", "", "", "GB", "", "", "", extra.dob ?? "1990-01-01", "", "", ""].join(",");
const FILE = [
  HEADER,
  r("Ada Active", "ada@example.test", "Adults Advanced 2026", "active", "2026-01-14"),
  r("Hal Hold", "hal@example.test", "Beginner Course", "hold", "2026-03-01"),
  r("Tom Gone", "tom@example.test", "Adults Advanced 2026", "cancelled", "2025-01-01", { expiry: "2025-06-01", cancelled: "2025-06-01" }),
  r("Cat Course", "cat@example.test", "8 Week Beginners Course", "completed", "2025-01-01", { type: "prepaid", expiry: "2025-03-01", completed: "2025-03-02T10:00:00+00:00" }),
  r("Kid Kay", "ada@example.test", "Kids Unlimited 2026", "active", "2026-02-01", { dob: "2017-05-05" }),
].join("\n");

describe("(b) no revenue, and never 'Free'", () => {
  const parsed = parseTeamUp(FILE, { asOf: "2026-10-02" });

  it("the TeamUp import never writes paymentStatus 'free' (only paid / paused / cancelled)", () => {
    const statuses = new Set(parsed.drafts.map((d) => d.paymentStatus));
    expect([...statuses].every((s) => ["paid", "paused", "cancelled"].includes(s ?? ""))).toBe(true);
    for (const s of statuses) expect(paymentStatusLabel(s)).not.toBe("Free");
  });

  it("nor does a status refresh, even onto a price-0 tier", () => {
    const tiers = tierMap([{ id: TIER.id, name: TIER.name, billingCycle: TIER.billingCycle, pricePence: 0 }]);
    for (const d of parsed.drafts) {
      expect(standingFromDraft(d, tiers, { id: "job", sourceExportedAt: "2026-10-02T17:00:00.000Z" }).paymentStatus).not.toBe("free");
    }
  });

  it("revenue is summed from Payment rows only: a club of TeamUp-billed members on price-0 tiers shows £0 revenue, not a price", async () => {
    vi.resetModules();
    vi.doMock("@/lib/api-authz", () => ({ requireApiOwner: async () => ({ ok: true, tenantId: "t1", userId: "u1", role: "owner" }) }));
    vi.doMock("next/server", () => ({ NextResponse: { json: (body: unknown) => ({ status: 200, json: async () => body }) } }));
    vi.doMock("@/lib/prisma-tenant", () => ({
      withTenantContext: async (_t: string, fn: (tx: unknown) => unknown) =>
        fn({
          payment: { findMany: async () => [] },
          member: {
            count: async () => 2,
            groupBy: async () => [{ membershipType: "Adults Advanced 2026", _count: 1 }, { membershipType: "Beginner Course", _count: 1 }],
          },
          membershipTier: { findMany: async () => [{ name: TIER.name, pricePence: 0 }] },
        }),
    }));
    const { GET } = await import("@/app/api/revenue/summary/route");
    const body = (await (await GET()).json()) as { mrr: number; arr: number; avgPerMember: number; memberships: { name: string; price: number }[] };
    expect(body.mrr).toBe(0);
    expect(body.arr).toBe(0);
    expect(body.avgPerMember).toBe(0);
    // KNOWN DISPLAY GAP (out of this lane's scope, reported): the Settings →
    // Revenue "Membership Tiers" card renders `£{price}/mo`, and the route
    // answers 0 both for a price-0 tier and for a label with no tier at all.
    expect(body.memberships.map((m) => m.price)).toEqual([0, 0]);
  });
});

// ── The owner's Memberships page: no "£0.00" for a price nobody knows ───────

import { tierPriceText, tierCycleText } from "@/components/dashboard/MembershipsManager";

describe("Memberships page wording for a TeamUp-billed tier", () => {
  it("the recommended tier reads 'Price not set' / 'Billed by TeamUp', not £0.00 / One-off", () => {
    const t = { ...TIER, currency: "GBP" };
    expect(tierPriceText(t)).toBe("Price not set");
    expect(tierCycleText(t)).toBe("Billed by TeamUp");
  });

  it("a genuinely free tier, or a priced one, reads as before", () => {
    expect(tierPriceText({ pricePence: 0, currency: "GBP", billingCycle: "none", description: "Free taster" })).toBe("£0.00");
    expect(tierCycleText({ pricePence: 0, billingCycle: "none", description: "Free taster" })).toBe("One-off / Drop-in");
    expect(tierPriceText({ pricePence: 6500, currency: "GBP", billingCycle: "monthly", description: TIER.description })).toBe("£65.00");
    // Price 0 on a recurring cycle is not the marker: shown as £0.00 (the owner chose it).
    expect(tierPriceText({ pricePence: 0, currency: "GBP", billingCycle: "four_weekly", description: TIER.description })).toBe("£0.00");
  });
});
