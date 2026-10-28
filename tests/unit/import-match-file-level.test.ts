// Preview = commit, including uncertainty inside the file itself (27 Oct 2026):
// rows sharing one email, and children whose parent row is refused or uncertain.
import { describe, it, expect } from "vitest";
import { blockedParents, classifyAdults, classifyChildren, fileRepeats } from "@/lib/importers/import-match";
import { scrubImportRecord } from "@/lib/importers/import-conflicts-scrub";
import type { MemberDraft } from "@/lib/importers";

type Row = Record<string, unknown>;
/** A reader over an in-memory member list, enough for the matching queries. */
function reader(rows: Row[]) {
  return {
    member: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const inList = (v: unknown, cond: unknown) => !!cond && typeof cond === "object" && "in" in (cond as object) && ((cond as { in: unknown[] }).in).includes(v);
        return rows.filter((r) => {
          if (r.tenantId !== where.tenantId) return false;
          if (where.email && typeof where.email === "object" && "in" in (where.email as object)) return inList(r.email, where.email);
          if (where.externalRef) return inList(r.externalRef, where.externalRef);
          if (where.OR) return (where.OR as Row[]).some((o) => (o.email ? inList(r.email, o.email) : inList(r.unverifiedEmail, o.unverifiedEmail)));
          return false;
        }).map((r) => ({ children: [], ...r }));
      },
    },
  } as never;
}
const plan = () => ({ tierId: null, label: null });
const adult = (name: string, email: string, over: Partial<MemberDraft> = {}): MemberDraft => ({ name, email, accountType: "adult", status: "active", ...over });
const member = (id: string, name: string, email: string): Row => ({
  id, tenantId: "t1", name, email, phone: null, dateOfBirth: null, accountType: "adult", membershipType: null, membershipTierId: null,
  status: "active", paymentStatus: "paid", cancelledAt: null, joinedAt: null, emergencyContactName: null, emergencyContactPhone: null,
  emergencyContactRelation: null, externalRef: null, importJobId: null, unverifiedEmail: null,
});

describe("rows of one file sharing an email", () => {
  it("an exact repeat is skipped; the first row is classified as usual", async () => {
    const a = adult("Ann Lee", "ann@example.test");
    const b = adult("Ann Lee", "ann@example.test");
    const repeats = fileRepeats([a, b]);
    const out = await classifyAdults(reader([]), "t1", [a, b], { jobId: "j", planOf: plan, repeats });
    expect(out.get(a)).toEqual({ kind: "new" });
    expect(out.get(b)).toEqual({ kind: "repeat" });
  });

  it("two different people on one address: both uncertain, nobody created — whichever slice each lands in", async () => {
    const a = adult("Ann Lee", "shared@example.test");
    const b = adult("Bob Lee", "SHARED@example.test");
    const repeats = fileRepeats([a, b]);
    // The commit classifies in slices; each slice still sees the whole-file reading.
    const first = await classifyAdults(reader([]), "t1", [a], { jobId: "j", planOf: plan, repeats });
    const second = await classifyAdults(reader([]), "t1", [b], { jobId: "j", planOf: plan, repeats });
    expect(first.get(a)).toMatchObject({ kind: "ambiguous", memberIds: [], reason: "2 rows of this file share this email with different details" });
    expect(second.get(b)).toMatchObject({ kind: "ambiguous", memberIds: [] });
  });

  it("no-email people (synthesised logins) are never grouped", () => {
    const a = adult("Ann Lee", "x1@no-login.matflow.local", { nonContactable: true });
    const b = adult("Bob Lee", "x1@no-login.matflow.local", { nonContactable: true });
    expect(fileRepeats([a, b]).size).toBe(0);
  });
});

describe("a child is never attached to a refused or uncertain parent row", () => {
  const kid: MemberDraft = { name: "Kit Lee", email: "k1@no-login.matflow.local", accountType: "kids", parentEmail: "pat@example.test", dateOfBirth: "2016-01-01", nonContactable: true };

  it("parent row is uncertain (the address belongs to a member with another name): the child is listed, linked to nobody", async () => {
    const pat = adult("Pat Lee", "pat@example.test");
    const db = reader([member("m-other", "Someone Else", "pat@example.test")]);
    const adults = await classifyAdults(db, "t1", [pat], { jobId: "j", planOf: plan });
    expect(adults.get(pat)?.kind).toBe("ambiguous");
    const blocked = blockedParents([pat], adults, new Set());
    const kids = await classifyChildren(db, "t1", [kid], { jobId: "j", planOf: plan, blocked });
    expect(kids.get(kid)).toMatchObject({ parentId: null, classification: { kind: "ambiguous", memberIds: [] } });
    // Without the block (9dc60b9c), the child was linked to "Someone Else".
    const unblocked = await classifyChildren(db, "t1", [kid], { jobId: "j", planOf: plan });
    expect(unblocked.get(kid)).toMatchObject({ parentId: "m-other", classification: { kind: "new" } });
  });

  it("parent row refused (a staff login holds the address): the child is 'without parent' in the preview too", async () => {
    const pat = adult("Pat Lee", "pat@example.test");
    const blocked = blockedParents([pat], new Map(), new Set(["pat@example.test"]));
    const kids = await classifyChildren(reader([]), "t1", [kid], { jobId: "j", planOf: plan, blocked, parentsInFile: new Set(["pat@example.test"]) });
    expect(kids.get(kid)).toEqual({ classification: null, parentId: null });
  });

  it("a confident parent (new, or the same person differing) is not blocked", () => {
    const pat = adult("Pat Lee", "pat@example.test");
    const b = blockedParents([pat], new Map([[pat, { kind: "new" } as const]]), new Set());
    expect([...b.refused, ...b.uncertain]).toEqual([]);
  });
});

describe("erasure scrubs every stored entry that names the member by id or source key", () => {
  it("review list keeps a kind; exceptions, kept lists, changes and decisions lose the entry; other people stay", () => {
    const manifest = {
      conflicts: [{ kind: "conflict", memberId: "m1", name: "Ann Lee", fields: [{ field: "phone", upload: "07700 900999", matflow: null }] }, { kind: "ambiguous", memberIds: ["m2"], name: "Bob" }],
      refresh: {
        changes: [{ memberId: "m1", name: "Ann Lee", before: {}, after: {} }],
        exceptions: { notInFile: [{ memberId: "m1", name: "Ann Lee" }, { memberId: "m2", name: "Bob" }], holdKept: [{ memberId: "m1", name: "Ann Lee", teamUpSays: "paid" }], notInMatFlow: [] },
      },
      rollback: { kept: [{ memberId: "m1", name: "Ann Lee", reasons: ["edited after the import"] }], restoredIds: ["m1", "m2"] },
      teamup2: { decisions: [{ name: "Ann Lee", sourceKey: "teamup:ann@example.test|ann lee", options: ["A", "B"] }], scheduled: [] },
    };
    const r = scrubImportRecord(manifest, "m1", "teamup:ann@example.test|ann lee");
    const text = JSON.stringify(r.value);
    expect(text).not.toContain("Ann Lee");
    expect(text).not.toContain("07700 900999");
    expect(text).not.toContain("m1");
    expect(text).not.toContain("ann@example.test");
    expect(text).toContain("Bob");
    expect((r.value as typeof manifest).conflicts).toEqual([{ kind: "conflict" }, { kind: "ambiguous", memberIds: ["m2"], name: "Bob" }]);
    expect((r.value as typeof manifest).rollback.restoredIds).toEqual(["m2"]);
    expect(r.scrubbed).toBe(7);
  });

  it("a null source key never matches entries with no key", () => {
    const r = scrubImportRecord({ teamup2: { decisions: [{ name: "Cy", sourceKey: null }] } }, "m1", null);
    expect(r.scrubbed).toBe(0);
  });
});
