// "Done by" in Filters: Everyone, Staff, Members, Automatic, and MatFlow support
// for the owner. Which rows each kind holds is decided once, by the row's source
// line (lib/activity-feed.ts sourceOf), and written as a query so the server
// pages exactly. This file proves the query and the row agree, row by row,
// under SQL's NULLs (tests/unit/activity-where-eval.ts); the database test
// repeats it against Postgres.
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AUDIT_LABELS } from "@/lib/audit-labels";
import { actorKindOf, actorKindWhere, sourceOf, emptyLookups, type FeedRow } from "@/lib/activity-feed";
import { ACTOR_KINDS, NO_FILTERS, apiQuery, hasSubjectFilter, parseActorKind, readFilters, writeFilters, type ActorKind } from "@/lib/activity-url";
import { evaluate, selects } from "./activity-where-eval";

const KINDS: ActorKind[] = ["staff", "members", "automatic", "support"];

const METADATA: unknown[] = [
  null,
  {},
  [1, 2],
  { actorId: "m_mel" },
  { actorId: null },
  { actorId: "" },
  { actorId: 7 },
  { actorType: "user", actorId: "" },
  { actorType: "user" },
  { actorType: "user", actorId: "u_gone" },
  { actorType: "user", actorId: null },
  { actorType: "member" },
  { actorType: 7 },
  { collectedBy: "self" },
  { collectedBy: "staff" },
  { collectedBy: null },
  { actingAs: "op_1" },
  { actingAs: null },
  { actingAs: 7 },
  { memberId: "m_mel", method: "self", actorId: "m_mel" },
];
const ACTIONS = [...Object.keys(AUDIT_LABELS), "attendance.kiosk_checkin", "stripe.invoice.paid", "member.payment.failed", "class.booking.created", "order.paid", "import.commit", "something.nobody.listed"];
const ROWS: FeedRow[] = ACTIONS.flatMap((action, a) =>
  METADATA.flatMap((metadata, m) =>
    [null, "u_jack"].flatMap((userId) =>
      [null, "op_1"].map((operatorId): FeedRow => ({ id: `r${a}-${m}-${userId ?? "x"}-${operatorId ?? "x"}`, action, entityType: "Member", entityId: "m_mel", metadata, createdAt: new Date("2026-11-05T10:00:00Z"), userId, operatorId, user: userId ? { id: userId, name: "Jack Streeter" } : null })),
    ),
  ),
);
const row = (action: string, over: Partial<FeedRow> = {}): FeedRow => ({ id: "r", action, entityType: "Member", entityId: "m_mel", metadata: null, createdAt: new Date(), userId: null, operatorId: null, ...over });

describe("the query and the row agree", () => {
  it("every row is in exactly one kind, and it is the kind the row itself says — never NULL, never two", () => {
    const wrong: string[] = [];
    for (const r of ROWS) {
      const kind = actorKindOf(r);
      for (const k of KINDS) {
        const verdict = evaluate(actorKindWhere(k), r);
        // NULL would drop the row from every kind at once: the bug this is written to prevent.
        if (verdict === null) wrong.push(`${k} is NULL for ${r.action} ${JSON.stringify(r.metadata)} user=${r.userId} op=${r.operatorId}`);
        else if (verdict !== (k === kind)) wrong.push(`${k}: ${r.action} ${JSON.stringify(r.metadata)} user=${r.userId} op=${r.operatorId} — query ${verdict}, row ${kind}`);
      }
    }
    expect(wrong.slice(0, 20)).toEqual([]);
    expect(ROWS.length).toBeGreaterThan(5000);
  });

  it("each kind is the row's source line, in the filter's words", () => {
    for (const r of ROWS.filter((x) => x.operatorId == null && (x.metadata as { actingAs?: unknown } | null)?.actingAs == null)) {
      const label = sourceOf(r, emptyLookups()).label;
      const expected = { Kiosk: "members", "Card scan": "staff", Staff: "staff", "Staff (account removed)": "staff", Stripe: "automatic", "Member app": "members", Automatic: "automatic" }[label];
      expect(actorKindOf(r), `${r.action} ${label}`).toBe(expected);
    }
  });
});

describe("what each kind holds", () => {
  const kindOf = (r: FeedRow) => KINDS.filter((k) => selects(actorKindWhere(k), r));

  it("Staff: a staff user did it — a desk check-in, an edit, a card scan, an import someone ran, or a staff action whose account has gone", () => {
    expect(kindOf(row("attendance.mark", { userId: "u_jack" }))).toEqual(["staff"]);
    expect(kindOf(row("member.update", { userId: "u_jack", metadata: { changes: { phone: { from: "1", to: "2" } } } }))).toEqual(["staff"]);
    expect(kindOf(row("attendance.card_scan", { userId: "u_jack", metadata: { memberIds: ["m1"] } }))).toEqual(["staff"]);
    expect(kindOf(row("import.commit", { userId: "u_owner", metadata: { fileName: "members.csv" } }))).toEqual(["staff"]);
    expect(kindOf(row("member.update", { metadata: { changes: {} } }))).toEqual(["staff"]); // the user was deleted
    expect(kindOf(row("task.staff_task.create", { metadata: { actorType: "user" } }))).toEqual(["staff"]);
  });

  it("Members: a member or their parent did it themselves — self, kiosk and QR check-ins, bookings, purchases, profile edits, waivers", () => {
    expect(kindOf(row("attendance.self_checkin", { metadata: { memberId: "m_mel", actorId: "m_mel" } }))).toEqual(["members"]);
    expect(kindOf(row("attendance.self_checkin", { metadata: { memberId: "m_kid", actorId: "m_parent", onBehalfOf: "m_kid" } }))).toEqual(["members"]);
    expect(kindOf(row("attendance.kiosk_checkin", { metadata: { memberId: "m_mel" } }))).toEqual(["members"]);
    expect(kindOf(row("class.booking.created", { metadata: { memberId: "m_mel" } }))).toEqual(["members"]);
    expect(kindOf(row("member.self_update", { metadata: { actorId: "m_mel", fields: ["phone"] } }))).toEqual(["members"]);
    expect(kindOf(row("waiver.sign", { metadata: { memberId: "m_mel" } }))).toEqual(["members"]);
    expect(kindOf(row("member.waiver.signed_via_kiosk"))).toEqual(["members"]);
  });

  it("Automatic: Stripe, scheduled jobs, and anything nobody did by hand", () => {
    expect(kindOf(row("member.payment.succeeded", { metadata: { amountPence: 4500 } }))).toEqual(["automatic"]);
    expect(kindOf(row("stripe.invoice.paid", { metadata: { actorId: "m_mel" } }))).toEqual(["automatic"]); // Stripe wins over a member id
    expect(kindOf(row("order.paid"))).toEqual(["automatic"]);
    expect(kindOf(row("import.commit", { metadata: { fileName: "members.csv" } }))).toEqual(["automatic"]); // no person on it
    expect(kindOf(row("something.nobody.listed"))).toEqual(["automatic"]);
  });

  it("MatFlow support: an operator route, or anything done during a support session — whoever's account it ran under", () => {
    expect(kindOf(row("admin.impersonate.edit_start", { operatorId: "op_1" }))).toEqual(["support"]);
    expect(kindOf(row("member.update", { userId: "u_owner", metadata: { actingAs: "op_1" } }))).toEqual(["support"]);
    expect(kindOf(row("attendance.kiosk_checkin", { metadata: { actingAs: "op_1" } }))).toEqual(["support"]);
  });
});

describe("the `by` parameter", () => {
  const params = (q: string) => new URLSearchParams(q);

  it("reads a kind, ignores anything else, and an old link without it means everyone", () => {
    expect(readFilters(params("by=members")).by).toBe("members");
    expect(readFilters(params("by=%20staff%20")).by).toBe("staff");
    expect(readFilters(params("by=robots")).by).toBeNull();
    expect(readFilters(params("userId=u_jack&tierId=t1")).by).toBeNull();
    expect(readFilters(params("")).by).toBeNull();
    expect(NO_FILTERS.by).toBeNull();
  });

  it("MatFlow support is the owner's to ask for; a manager's asking is not a filter", () => {
    for (const k of ACTOR_KINDS) expect(parseActorKind(k.key, "owner")).toBe(k.key);
    expect(parseActorKind("support", "manager")).toBeNull();
    expect(parseActorKind("members", "manager")).toBe("members");
    expect(ACTOR_KINDS.filter((k) => !k.ownerOnly).map((k) => k.label)).toEqual(["Staff", "Members", "Automatic"]);
  });

  it("is written into the address and the request beside the other filters, and counts as a filter", () => {
    expect(writeFilters("?types=money&userId=u_jack", { by: "staff" })).toBe("?types=money&userId=u_jack&by=staff");
    expect(writeFilters("?by=staff&day=2026-11-04", { by: null })).toBe("?day=2026-11-04");
    expect(writeFilters("?by=staff&memberId=m1", NO_FILTERS)).toBe("");
    expect(apiQuery({ ...NO_FILTERS, by: "members", day: "2026-11-04" }, { types: "club", take: 50 })).toBe("/api/activity?types=club&by=members&day=2026-11-04&take=50");
    expect(hasSubjectFilter({ ...NO_FILTERS, by: "automatic" })).toBe(true);
  });
});
