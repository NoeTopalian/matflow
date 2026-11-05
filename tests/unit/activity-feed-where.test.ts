// The Type column and the type filter are compiled from the same rules. This
// file proves they agree, row by row, including the rows SQL's NULL would
// otherwise lose; tests/integration/activity-feed-db.test.ts repeats the
// proof against Postgres.
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AUDIT_LABELS } from "@/lib/audit-labels";
import { ACTIVITY_TYPES, visibleTypeKeys } from "@/lib/activity-types";
import { ROW_RULES, classWhere, memberWhere, paymentWhere, tierWhere, typeOf, visibleWhere, whereForTypes } from "@/lib/activity-feed";
import { selects, type EvalRow } from "./activity-where-eval";

const ALL_KEYS = ACTIVITY_TYPES.map((t) => t.key);

/** Metadata shapes that matter to a row rule — above all the ones where the key a rule reads is missing. */
const METADATA: unknown[] = [
  null,
  {},
  { fields: ["phone"] },
  { changes: {} },
  { changes: { phone: { from: "1", to: "2" } } },
  { changes: { status: { from: "active", to: "inactive" } } },
  { changes: { status: { from: "active", to: null } } },
  { changes: { status: { from: "active", to: "cancelled" } } },
  { changes: { membershipTierId: { from: null, to: "tier1" } } },
  { changes: { membershipTierId: { from: "tier1", to: null }, status: { from: "active", to: "cancelled" } } },
  { classInstanceId: "s1", memberId: "m1" },
  { classInstanceId: "s1", memberId: "m1", acknowledged: [] },
  { classInstanceId: "s1", memberId: "m1", acknowledged: ["rank_gate"] },
  { classInstanceId: "s1", memberId: "m1", acknowledged: ["on_hold"] },
  { classInstanceId: "s1", memberId: "m1", acknowledged: ["rank_gate", "waiver_unsigned"] },
  { classInstanceId: "s1", memberId: "m1", acknowledged: ["kids_class"] },
  { amountPence: 500 },
  { amountPence: 500, outcome: null },
  { amountPence: 500, outcome: "succeeded" },
  { amountPence: 500, outcome: "declined" },
  { amountPence: 500, outcome: "rejected" },
  { amountPence: 500, outcome: "unknown" },
];

const ACTIONS = [...Object.keys(AUDIT_LABELS), "stripe.dispute.needs_response", "undo.member.update", "undo.class.updated", "something.nobody.listed"];
const ROWS: EvalRow[] = ACTIONS.flatMap((action) => METADATA.map((metadata) => ({ action, metadata })));

describe("row rules", () => {
  it("each rule belongs to a type that names its action as a rule action, and every rule action has a rule", () => {
    for (const rule of ROW_RULES) expect(ACTIVITY_TYPES.find((t) => t.key === rule.type)?.ruleActions, rule.type).toContain(rule.action);
    for (const t of ACTIVITY_TYPES) for (const action of t.ruleActions) expect(ROW_RULES.some((r) => r.type === t.key && r.action === action), `${t.key} ${action}`).toBe(true);
  });

  it("`where` selects exactly the rows `test` claims, and `whereNot` exactly the rest — never neither", () => {
    for (const rule of ROW_RULES) {
      for (const metadata of METADATA) {
        const row = { action: rule.action, metadata };
        const claimed = rule.test(metadata);
        const label = `${rule.type} ${JSON.stringify(metadata)}`;
        expect(selects(rule.where, row), `where: ${label}`).toBe(claimed);
        expect(selects(rule.whereNot, row), `whereNot: ${label}`).toBe(!claimed);
      }
    }
  });

  it("claims what it should", () => {
    expect(typeOf({ action: "member.update", metadata: { changes: { phone: { from: "1", to: "2" } } } })).toBe("member_updated");
    expect(typeOf({ action: "member.update", metadata: null })).toBe("member_updated");
    expect(typeOf({ action: "member.update", metadata: { changes: { membershipTierId: { from: null, to: "t" } } } })).toBe("membership_changed");
    expect(typeOf({ action: "member.update", metadata: { changes: { status: { from: "active", to: "cancelled" } } } })).toBe("cancellation");
    // Cancelling and losing the plan in one edit is a cancellation: the first rule wins.
    expect(typeOf({ action: "member.update", metadata: { changes: { membershipTierId: { from: "t", to: null }, status: { from: "active", to: "cancelled" } } } })).toBe("cancellation");
    expect(typeOf({ action: "attendance.mark", metadata: { acknowledged: ["waiver_unsigned"] } })).toBe("checkin_exception");
    expect(typeOf({ action: "attendance.mark", metadata: { acknowledged: ["rank_gate"] } })).toBe("checkin");
    expect(typeOf({ action: "attendance.mark", metadata: {} })).toBe("checkin");
    expect(typeOf({ action: "payment.adhoc.charge", metadata: { outcome: "declined" } })).toBe("payment_failed");
    expect(typeOf({ action: "payment.adhoc.charge", metadata: { outcome: "unknown" } })).toBe("payment_failed");
    expect(typeOf({ action: "payment.adhoc.charge", metadata: { outcome: "succeeded" } })).toBe("payment");
    expect(typeOf({ action: "payment.adhoc.charge", metadata: { amountPence: 5 } })).toBe("payment");
    // A rule looks only at its own action.
    expect(typeOf({ action: "member.self_update", metadata: { changes: { status: { to: "cancelled" } } } })).toBe("member_updated");
  });
});

describe("whereForTypes", () => {
  it("for every row, the one type whose filter finds it is the type the row shows", () => {
    const wrong: string[] = [];
    for (const row of ROWS) {
      const found = ALL_KEYS.filter((key) => selects(whereForTypes([key], "owner"), row));
      const shown = typeOf(row);
      if (found.length !== 1 || found[0] !== shown) wrong.push(`${row.action} ${JSON.stringify(row.metadata)}: shows ${shown}, found by [${found.join(", ")}]`);
    }
    expect(wrong).toEqual([]);
  });

  it("a selection finds exactly the rows of its types", () => {
    const chosen = ["cancellation", "checkin", "refund", "other", "undo"];
    for (const row of ROWS) expect(selects(whereForTypes(chosen, "owner"), row), `${row.action} ${JSON.stringify(row.metadata)}`).toBe(chosen.includes(typeOf(row)));
  });

  it("every type at once is no filter for the owner, and nothing chosen finds nothing", () => {
    expect(whereForTypes(ALL_KEYS, "owner")).toEqual({});
    for (const row of ROWS.slice(0, 40)) expect(selects(whereForTypes([], "owner"), row)).toBe(false);
    for (const row of ROWS.slice(0, 40)) expect(selects(whereForTypes(["not-a-type"], "owner"), row)).toBe(false);
  });

  it("never selects an owner-only type for a manager, whatever is asked for", () => {
    const managerTypes = new Set(visibleTypeKeys("manager"));
    for (const row of ROWS) {
      const visible = managerTypes.has(typeOf(row));
      expect(selects(whereForTypes(ALL_KEYS, "manager"), row), `${row.action} ${JSON.stringify(row.metadata)}`).toBe(visible);
      expect(selects(whereForTypes(["staff", "sign_in", "settings", "support", "undo", "other", "import", "data_request", "plan_setup"], "manager"), row)).toBe(false);
    }
  });
});

describe("visibleWhere", () => {
  it("is no restriction for the owner", () => {
    expect(visibleWhere("owner")).toEqual({});
  });

  it("lets a manager see only club-life rows that MatFlow support did not make", () => {
    const managerTypes = new Set(visibleTypeKeys("manager"));
    const where = visibleWhere("manager");
    for (const row of ROWS) expect(selects(where, { ...row, operatorId: null }), `${row.action} ${JSON.stringify(row.metadata)}`).toBe(managerTypes.has(typeOf(row)));
  });

  it("hides anything done by or through MatFlow support, even an ordinary action", () => {
    const where = visibleWhere("manager");
    const edit = { action: "member.update", metadata: { changes: { phone: { from: "1", to: "2" } } } };
    expect(selects(where, { ...edit, operatorId: null })).toBe(true);
    expect(selects(where, { ...edit, operatorId: "op1" })).toBe(false);
    expect(selects(where, { ...edit, operatorId: null, metadata: { ...edit.metadata, actingAs: "op1" } })).toBe(false);
    // No metadata at all is not a support session.
    expect(selects(where, { action: "member.update", metadata: null, operatorId: null })).toBe(true);
  });

  it("hides an action nobody has mapped yet", () => {
    expect(selects(visibleWhere("manager"), { action: "brand.new.thing", metadata: null, operatorId: null })).toBe(false);
  });
});

describe("filters for one member, class, payment or plan", () => {
  const row = (over: Partial<EvalRow>): EvalRow => ({ action: "x.y", entityType: "Thing", entityId: "t1", metadata: null, ...over });

  it("a member: their record, rows that name them, a card-scan batch, a parent or child link, and their payments", () => {
    const where = memberWhere("m1", ["pay1", "pay2"]);
    expect(selects(where, row({ entityType: "Member", entityId: "m1" }))).toBe(true);
    expect(selects(where, row({ metadata: { memberId: "m1" } }))).toBe(true);
    expect(selects(where, row({ metadata: { actorId: "m1", memberId: "kid" } }))).toBe(true);
    expect(selects(where, row({ metadata: { memberIds: ["a", "m1", "b"] } }))).toBe(true);
    expect(selects(where, row({ metadata: { parentMemberId: "m1" } }))).toBe(true);
    expect(selects(where, row({ metadata: { childMemberId: "m1" } }))).toBe(true);
    expect(selects(where, row({ entityType: "Payment", entityId: "pay2" }))).toBe(true);
    expect(selects(where, row({ entityType: "Member", entityId: "m2" }))).toBe(false);
    expect(selects(where, row({ metadata: { memberIds: ["a", "b"] } }))).toBe(false);
    expect(selects(where, row({ entityType: "Payment", entityId: "pay9" }))).toBe(false);
    expect(selects(where, row({ entityType: "Class", entityId: "m1" }))).toBe(false);
    expect(selects(where, row({}))).toBe(false);
    expect(selects(memberWhere("m1", []), row({ entityType: "Payment", entityId: "pay1" }))).toBe(false);
  });

  it("a class: changes to it and rows that name it", () => {
    const where = classWhere("c1");
    expect(selects(where, row({ entityType: "Class", entityId: "c1" }))).toBe(true);
    expect(selects(where, row({ entityType: "ClassRoster", metadata: { classId: "c1", memberId: "m1" } }))).toBe(true);
    expect(selects(where, row({ entityType: "Class", entityId: "c2" }))).toBe(false);
    expect(selects(where, row({}))).toBe(false);
  });

  it("a payment: its own rows, and the Stripe row that carries only its invoice", () => {
    expect(selects(paymentWhere("p1", "in_1"), row({ entityType: "Payment", entityId: "p1" }))).toBe(true);
    expect(selects(paymentWhere("p1", "in_1"), row({ metadata: { paymentId: "p1" } }))).toBe(true);
    expect(selects(paymentWhere("p1", "in_1"), row({ entityType: "Member", entityId: "m1", metadata: { stripeInvoiceId: "in_1" } }))).toBe(true);
    expect(selects(paymentWhere("p1", null), row({ entityType: "Member", entityId: "m1", metadata: { stripeInvoiceId: "in_1" } }))).toBe(false);
    expect(selects(paymentWhere("p1", "in_1"), row({ entityType: "Payment", entityId: "p2" }))).toBe(false);
  });

  it("a plan: changes to it, and members put on it, moved off it or cancelling it", () => {
    const where = tierWhere("t1");
    expect(selects(where, row({ entityType: "MembershipTier", entityId: "t1" }))).toBe(true);
    expect(selects(where, row({ metadata: { tierId: "t1" } }))).toBe(true);
    expect(selects(where, row({ metadata: { membershipTierId: "t1" } }))).toBe(true);
    expect(selects(where, row({ metadata: { changes: { membershipTierId: { from: "t1", to: "t2" } } } }))).toBe(true);
    expect(selects(where, row({ metadata: { changes: { membershipTierId: { from: null, to: "t1" } } } }))).toBe(true);
    expect(selects(where, row({ metadata: { changes: { membershipTierId: { from: "t2", to: "t3" } } } }))).toBe(false);
    expect(selects(where, row({ entityType: "Member", entityId: "t1" }))).toBe(false);
  });
});
