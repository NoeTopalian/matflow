/**
 * Security lane D (9 Oct 2026) — SEC-054: an import never overwrites security
 * state. A TeamUp status refresh (lib/importers/teamup-refresh.ts) writes only
 * TeamUp-owned standing; it cannot touch a login address, password, factor,
 * session version, guardian link or import identity, cannot lift a MatFlow hold,
 * and cannot reach an erased record (erasure nulls externalRef). The members
 * import commit only CREATES rows (existing addresses are skipped). The DB-level
 * proofs for a corrected address are tests/integration/contact-email-change-imports-db.test.ts
 * and tests/integration/sec-b-sean-imported-cancelled-db.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { planRefresh, refreshWrite, REFRESH_OWNED_FIELDS, standingOf, type RefreshMember } from "@/lib/importers/teamup-refresh";
import type { MemberDraft } from "@/lib/importers";

const SECURITY_COLUMNS = [
  "email", "passwordHash", "totpSecret", "totpEnabled", "sessionVersion", "externalRef", "unverifiedEmail",
  "parentMemberId", "guardianConfirmedAt", "guardianSuggestedBy", "tenantId", "accountType", "holdUntil",
];

const member = (over: Partial<RefreshMember> = {}): RefreshMember => ({
  id: "m1", name: "secD Ana", externalRef: "teamup:ana@example.test|secd ana", billedBy: "teamup", status: "active", paymentStatus: "paid",
  cancelledAt: null, membershipType: null, membershipTierId: null, billingStatusAsOf: null, billingStatusSource: null, ...over,
});
const draft = (over: Partial<MemberDraft> = {}) =>
  ({ name: "secD Ana", email: "ana@example.test", sourceKey: "teamup:ana@example.test|secd ana", status: "active", paymentStatus: "paid", ...over }) as MemberDraft;
const job = { id: "job_secd", sourceExportedAt: "2026-10-08T12:00:00Z" };

describe("SEC-054 refresh writes standing only", () => {
  it("the write set is exactly the owned standing plus provenance — no security column", () => {
    const keys = Object.keys(refreshWrite(standingOf(member())));
    expect(keys.sort()).toEqual([...REFRESH_OWNED_FIELDS, "billingStatusAsOf", "billingStatusSource"].sort());
    for (const c of SECURITY_COLUMNS) expect(keys).not.toContain(c);
  });

  it("a hold (paused) placed in MatFlow is not lifted by a file that says paid", () => {
    const p = planRefresh({ drafts: [draft({ paymentStatus: "paid" })], errors: [], members: [member({ paymentStatus: "paused" })], tiers: [], job });
    expect(p.matched[0].after.paymentStatus).toBe("paused");
    expect(p.exceptions.holdKept?.map((h) => h.memberId)).toEqual(["m1"]);
  });

  it("an erased record (externalRef nulled by DSAR erase) is never matched — it appears as 'not in MatFlow', nothing is written to it", () => {
    const p = planRefresh({ drafts: [draft()], errors: [], members: [member({ externalRef: null, name: "Erased member" })], tiers: [], job });
    expect(p.matched).toHaveLength(0);
    expect(p.exceptions.notInMatFlow).toHaveLength(1);
  });

  it("a member MatFlow now bills is reported, not refreshed", () => {
    const p = planRefresh({ drafts: [draft({ status: "cancelled" })], errors: [], members: [member({ billedBy: "matflow" })], tiers: [], job });
    expect(p.matched).toHaveLength(0);
    expect(p.exceptions.billedByMatFlow).toHaveLength(1);
  });

  it("a file older than the recorded standing is flagged (the commit refuses it)", () => {
    const p = planRefresh({ drafts: [draft()], errors: [], members: [member({ billingStatusAsOf: new Date("2026-10-09T00:00:00Z"), billingStatusSource: "other" })], tiers: [], job });
    expect(p.olderThanRecorded?.members).toBe(1);
  });
});

describe("SEC-054 members-import commit never rewrites an existing member's security state", () => {
  const src = readFileSync(path.resolve(__dirname, "../../app/api/admin/import/[id]/commit/route.ts"), "utf8");
  it("the commit updates no existing member at all (owner decision 25 Oct 2026: a later upload never overwrites; differences are listed)", () => {
    expect([...src.matchAll(/\.member\.(update|updateMany|upsert)\(/g)]).toEqual([]);
    // The refresh's write helper is gone from the commit too.
    expect(src).not.toMatch(/refreshWrite\(/);
  });
  it("existing addresses are never overwritten: createMany with skipDuplicates, and every match is compared, not skipped blind", () => {
    expect(src).toMatch(/skipDuplicates:\s*true/);
    // Every match goes through the shared matcher (also used by the preview), which compares, never skips blind.
    expect(src).toMatch(/await classifyAdults\(tx, tenantId, slice/);
    expect(src).toMatch(/await classifyChildren\(tx, tenantId, slice/);
    const matcher = readFileSync(path.resolve(__dirname, "../../lib/importers/import-match.ts"), "utf8");
    expect(matcher).toMatch(/byEmail\.has\(d\.email\)/);
    expect(matcher).toMatch(/classify\(\{ draft: d/);
  });
});
