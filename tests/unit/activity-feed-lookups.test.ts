// Names for the ids a page of activity carries: which ids are read off a row,
// how they are looked up (club-scoped, only when needed), and the two scans
// that keep the feed honest — every id key a writer uses is either resolved or
// knowingly ignored, and no client component imports the server module.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

import { IGNORED_ID_KEYS, LOOKUP_CAP, RESOLVED_ID_KEYS, loadLookups, subjectRefs, type FeedRow } from "@/lib/activity-feed";

let seq = 0;
const row = (over: Partial<FeedRow> & Pick<FeedRow, "action">): FeedRow => ({ id: `a${++seq}`, entityType: "Thing", entityId: "x1", metadata: null, createdAt: new Date("2026-11-04T12:00:00Z"), userId: null, operatorId: null, user: null, ...over });

describe("subjectRefs", () => {
  it("reads the entity and every id key a row carries", () => {
    const refs = subjectRefs([
      row({ action: "attendance.mark", entityType: "AttendanceRecord", entityId: "s1:m1", userId: "u1", metadata: { classInstanceId: "s1", memberId: "m1" } }),
      row({ action: "attendance.self_checkin", entityType: "AttendanceRecord", entityId: "rec", metadata: { classInstanceId: "s2", memberId: "kid", actorId: "parent" } }),
      row({ action: "member.update", entityType: "Member", entityId: "m2", metadata: { changes: { membershipTierId: { from: "t1", to: "t2" } } } }),
      row({ action: "class.updated", entityType: "Class", entityId: "c1", metadata: { before: { locationId: "v1", coachUserId: "u2", requiredRankId: null }, after: { locationId: "v2", coachUserId: "u3", requiredRankId: "r1" } } }),
      row({ action: "member.payment.succeeded", entityType: "Member", entityId: "m3", metadata: { stripeInvoiceId: "in_1ABC.def", amountPence: 100 } }),
      row({ action: "payment.refund", entityType: "Payment", entityId: "p1", metadata: {} }),
      row({ action: "order.mark_paid", entityType: "Order", entityId: "o1", metadata: {} }),
      row({ action: "member.rank.promote", entityType: "Member", entityId: "m4", metadata: { fromRankId: "r2", toRankId: "r3" } }),
      row({ action: "waiver.sign-for-child", entityType: "Member", entityId: "kid2", metadata: { collectedBy: "parent2" } }),
      row({ action: "stripe.checkout.class_pack_payment_failed", entityType: "ClassPack", entityId: "pk1", metadata: { memberId: "m5" } }),
    ]);
    expect([...refs.member].sort()).toEqual(["kid", "kid2", "m1", "m2", "m3", "m4", "m5", "parent", "parent2"]);
    expect([...refs.session].sort()).toEqual(["s1", "s2"]);
    expect([...refs.tier].sort()).toEqual(["t1", "t2"]);
    expect([...refs.class]).toEqual(["c1"]);
    expect([...refs.venue].sort()).toEqual(["v1", "v2"]);
    expect([...refs.staff].sort()).toEqual(["u1", "u2", "u3"]);
    expect([...refs.rank].sort()).toEqual(["r1", "r2", "r3"]);
    expect([...refs.invoice]).toEqual(["in_1ABC.def"]);
    expect([...refs.payment]).toEqual(["p1"]);
    expect([...refs.order]).toEqual(["o1"]);
    expect([...refs.pack]).toEqual(["pk1"]);
  });

  it("takes the first five members of a card-scan batch", () => {
    const refs = subjectRefs([row({ action: "attendance.card_scan", entityType: "ClassInstance", entityId: "s1", metadata: { memberIds: ["a", "b", "c", "d", "e", "f", "g"] } })]);
    expect([...refs.member]).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("never treats the kiosk waiver's entity id — an email — as a record to look up", () => {
    const refs = subjectRefs([row({ action: "member.waiver.signed_via_kiosk", entityType: "Member", entityId: "someone@example.test", metadata: { signerName: "Some One" } })]);
    expect(refs.member.size).toBe(0);
  });

  it("ignores anything that is not a plain id", () => {
    const refs = subjectRefs([row({ action: "x.y", entityType: "Member", entityId: "has space", metadata: { memberId: { $ne: null }, classId: ["c1"], actorId: "a".repeat(101), tierId: 7, collectedBy: "self" } })]);
    for (const set of Object.values(refs)) expect(set.size).toBe(0);
  });
});

// ── A stand-in for the transaction: two clubs' records, filtered the way the real `where` would ──

type Rec = Record<string, unknown> & { id: string; tenantId?: string };

function fakeTx(data: Record<string, Rec[]>) {
  const calls: { model: string; where: Record<string, unknown> }[] = [];
  const inList = (cond: unknown, value: unknown) => (cond && typeof cond === "object" && "in" in cond ? (cond.in as unknown[]).includes(value) : cond === value);
  const model = (name: string) => ({
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      calls.push({ model: name, where });
      return (data[name] ?? []).filter((r) => {
        if ("tenantId" in where && r.tenantId !== where.tenantId) return false;
        if (where.class && (r.class as Rec).tenantId !== (where.class as Rec).tenantId) return false;
        if (where.action && r.action !== where.action) return false;
        if (where.entityId && !inList(where.entityId, r.entityId)) return false;
        if (where.OR) return (where.OR as Record<string, unknown>[]).some((o) => (o.id ? inList(o.id, r.id) : inList(o.stripeInvoiceId, r.stripeInvoiceId)));
        return where.id ? inList(where.id, r.id) : true;
      });
    }),
  });
  const tx = { member: model("member"), class: model("class"), classInstance: model("classInstance"), payment: model("payment"), order: model("order"), membershipTier: model("membershipTier"), classPack: model("classPack"), location: model("location"), user: model("user"), rankSystem: model("rankSystem"), auditLog: model("auditLog") };
  return { tx: tx as unknown as Parameters<typeof loadLookups>[0], calls };
}

const CLUB = "club_a";
const DATA: Record<string, Rec[]> = {
  member: [
    { id: "m1", tenantId: CLUB, name: "Ada Obi", email: "ada@example.test" },
    { id: "m_payer", tenantId: CLUB, name: "Pat Payer", email: "pat@example.test" },
    { id: "m_erased", tenantId: CLUB, name: "Deleted member", email: "deleted-m_erased@deleted.invalid" },
    { id: "m_other", tenantId: "club_b", name: "Other Club Person", email: "other@example.test" },
  ],
  classInstance: [
    { id: "s1", date: new Date("2026-11-04T00:00:00Z"), startTime: "19:00", class: { id: "c1", name: "No-Gi", tenantId: CLUB } },
    { id: "s_other", date: new Date("2026-11-04T00:00:00Z"), startTime: "18:00", class: { id: "c_other", name: "Other Club Class", tenantId: "club_b" } },
  ],
  payment: [
    { id: "p1", tenantId: CLUB, memberId: "m_payer", amountPence: 4500, currency: "GBP", stripeInvoiceId: "in_1" },
    { id: "p_other", tenantId: "club_b", memberId: "m_other", amountPence: 999, currency: "GBP", stripeInvoiceId: "in_other" },
  ],
  auditLog: [
    { id: "del1", tenantId: CLUB, action: "member.delete", entityType: "Member", entityId: "m_gone", metadata: { name: "  Jane Smith " } },
    { id: "del2", tenantId: "club_b", action: "member.delete", entityType: "Member", entityId: "m_gone2", metadata: { name: "Other Club Leaver" } },
  ],
  user: [{ id: "u2", tenantId: CLUB, name: "Sean Coates" }],
};

describe("loadLookups", () => {
  it("a page of check-ins costs two lookups: the sessions and the members", async () => {
    const rows = Array.from({ length: 50 }, () => row({ action: "attendance.self_checkin", entityType: "AttendanceRecord", entityId: "rec", metadata: { classInstanceId: "s1", memberId: "m1", actorId: "m1" } }));
    const { tx, calls } = fakeTx(DATA);
    const L = await loadLookups(tx, CLUB, rows);
    expect(calls.map((c) => c.model)).toEqual(["classInstance", "member"]);
    expect(L.members.get("m1")).toEqual({ name: "Ada Obi", erased: false });
    expect(L.sessions.get("s1")).toMatchObject({ classId: "c1", className: "No-Gi", startTime: "19:00" });
  });

  it("scopes every lookup to the club", async () => {
    const rows = [
      row({ action: "a.b", entityType: "Member", entityId: "m1", userId: "u2", metadata: { classInstanceId: "s1", classId: "c1", tierId: "t1", classPackId: "k1", locationId: "v1", toRankId: "r1", stripeInvoiceId: "in_1", memberId: "m_gone" } }),
      row({ action: "a.b", entityType: "Order", entityId: "o1" }),
    ];
    const { tx, calls } = fakeTx(DATA);
    await loadLookups(tx, CLUB, rows);
    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const call of calls) {
      const scoped = call.where.tenantId === CLUB || (call.where.class as Rec | undefined)?.tenantId === CLUB;
      expect(scoped, call.model).toBe(true);
    }
  });

  it("an id from another club resolves to nothing", async () => {
    const rows = [row({ action: "a.b", entityType: "Member", entityId: "m_other", metadata: { classInstanceId: "s_other", stripeInvoiceId: "in_other", memberId: "m_gone2" } })];
    const { tx } = fakeTx(DATA);
    const L = await loadLookups(tx, CLUB, rows);
    expect(L.members.size).toBe(0);
    expect(L.sessions.size).toBe(0);
    expect(L.payments.size).toBe(0);
    expect(L.deletedMemberNames.size).toBe(0);
    expect(JSON.stringify([...L.members, ...L.sessions, ...L.payments, ...L.deletedMemberNames])).not.toContain("Other Club");
  });

  it("the member a payment belongs to is looked up even though the row never names them", async () => {
    const { tx } = fakeTx(DATA);
    const byId = await loadLookups(tx, CLUB, [row({ action: "payment.refund", entityType: "Payment", entityId: "p1", metadata: { amountPence: 500 } })]);
    expect(byId.payments.get("p1")?.memberId).toBe("m_payer");
    expect(byId.members.get("m_payer")?.name).toBe("Pat Payer");
    const byInvoice = await loadLookups(tx, CLUB, [row({ action: "member.payment.succeeded", entityType: "Member", entityId: "m1", metadata: { stripeInvoiceId: "in_1" } })]);
    expect(byInvoice.paymentsByInvoice.get("in_1")?.id).toBe("p1");
  });

  it("flags an erased member, and keeps no address", async () => {
    const { tx } = fakeTx(DATA);
    const L = await loadLookups(tx, CLUB, [row({ action: "a.b", entityType: "Member", entityId: "m_erased", metadata: { memberId: "m1" } })]);
    expect(L.members.get("m_erased")).toEqual({ name: "Deleted member", erased: true });
    expect(JSON.stringify([...L.members])).not.toContain("@");
  });

  it("a member who is gone gets the name recorded on their deletion, asked for once", async () => {
    const { tx, calls } = fakeTx(DATA);
    const L = await loadLookups(tx, CLUB, [row({ action: "a.b", entityType: "Member", entityId: "m_gone", metadata: { memberId: "m1" } })]);
    expect(L.deletedMemberNames.get("m_gone")).toBe("Jane Smith");
    const deletions = calls.filter((c) => c.model === "auditLog");
    expect(deletions).toHaveLength(1);
    expect(deletions[0].where).toMatchObject({ tenantId: CLUB, action: "member.delete", entityType: "Member", entityId: { in: ["m_gone"] } });
  });

  it("uses the actor that came with the row, and looks up only staff it has not seen", async () => {
    const { tx, calls } = fakeTx(DATA);
    const L = await loadLookups(tx, CLUB, [
      row({ action: "a.b", userId: "u1", user: { id: "u1", name: "Jack Streeter" } }),
      row({ action: "class.updated", entityType: "Class", entityId: "c9", userId: "u1", user: { id: "u1", name: "Jack Streeter" }, metadata: { changes: { coachUserId: { from: null, to: "u2" } } } }),
    ]);
    expect(L.staff.get("u1")?.name).toBe("Jack Streeter");
    expect(L.staff.get("u2")?.name).toBe("Sean Coates");
    expect(calls.find((c) => c.model === "user")?.where).toMatchObject({ tenantId: CLUB, id: { in: ["u2"] } });
  });

  it("asks nothing of the database for a page that names nothing", async () => {
    const { tx, calls } = fakeTx(DATA);
    await loadLookups(tx, CLUB, [row({ action: "tenant.settings.update", entityType: "Tenant", entityId: CLUB, metadata: { fields: ["name"] } })]);
    expect(calls).toEqual([]);
  });

  it("looks up at most LOOKUP_CAP ids of a kind", async () => {
    const rows = Array.from({ length: LOOKUP_CAP + 40 }, (_, i) => row({ action: "a.b", entityType: "Member", entityId: `m${i}` }));
    const { tx, calls } = fakeTx(DATA);
    await loadLookups(tx, CLUB, rows);
    const members = calls.find((c) => c.model === "member");
    expect(((members?.where.id as { in: string[] }).in ?? []).length).toBe(LOOKUP_CAP);
  });
});

// ── Scans ────────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** The text of the `{ … }` that opens at `open`. */
function block(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Id-like keys anywhere in the metadata literal that follows an audit `action: "…"`. */
function idKeysWritten(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of [...walk("app"), ...walk("lib")]) {
    if (/[\\/]lib[\\/]activity-(feed|types)\.ts$/.test(file)) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/action:\s*[^,\n]*"[a-z_-]+(?:\.[a-z_-]+)+"[^\n]*/g)) {
      // The object literal the action sits in, then its `metadata: { … }`.
      let depth = 0;
      let open = -1;
      for (let i = m.index; i >= 0; i--) {
        if (src[i] === "}") depth++;
        else if (src[i] === "{") {
          if (depth === 0) {
            open = i;
            break;
          }
          depth--;
        }
      }
      if (open < 0) continue;
      const literal = block(src, open);
      const at = literal.indexOf("metadata:");
      if (at < 0) continue;
      const rest = literal.slice(at + "metadata:".length).trimStart();
      if (!rest.startsWith("{")) continue;
      // Keys only — a name straight after "{" or "," — with comments out of the way:
      // in `memberId: resolvedMemberId` the second name is a value, not a key.
      const body = block(rest, 0).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
      for (const key of body.matchAll(/(?<=[{,]\s*)([A-Za-z]+Ids?)\s*(?=[:,}])/g)) if (!found.has(key[1])) found.set(key[1], file);
    }
  }
  return found;
}

describe("every id an audit row carries is accounted for", () => {
  it("each id key a writer uses is either resolved to a name or listed as deliberately ignored", () => {
    const written = idKeysWritten();
    // The scan must be seeing the real writers.
    for (const expected of ["memberId", "classInstanceId", "parentMemberId", "stripeInvoiceId", "fromRankId"]) expect([...written.keys()], expected).toContain(expected);
    const unaccounted = [...written].filter(([key]) => !(key in RESOLVED_ID_KEYS) && !IGNORED_ID_KEYS.has(key));
    expect(unaccounted.map(([key, file]) => `${key} (${file})`), "add the key to RESOLVED_ID_KEYS or IGNORED_ID_KEYS in lib/activity-feed.ts").toEqual([]);
  });

  it("no key is in both lists", () => {
    expect(Object.keys(RESOLVED_ID_KEYS).filter((k) => IGNORED_ID_KEYS.has(k))).toEqual([]);
  });
});

describe("the server module stays on the server", () => {
  it("nothing under components/ imports lib/activity-feed, and no client file anywhere does", () => {
    const offenders = [...walk("components"), ...walk("app"), ...walk("lib")].filter((file) => {
      const src = readFileSync(file, "utf8");
      if (!/from\s+["']@\/lib\/activity-feed["']/.test(src)) return false;
      return /[\\/]components[\\/]/.test(file) || /^\s*["']use client["']/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("the module declares itself server-only", () => {
    expect(readFileSync(join("lib", "activity-feed.ts"), "utf8")).toMatch(/^import "server-only";$/m);
  });
});
