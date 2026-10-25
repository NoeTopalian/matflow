/**
 * Later uploads never silently overwrite MatFlow (owner decision 25 Oct 2026):
 * new people are added, exact duplicates skipped, differences and ambiguous
 * matches listed. The pure rules in lib/importers/import-conflicts.
 */
import { describe, it, expect } from "vitest";
import { classify, differences, stillDiffers, uploadValues, type CandidateMember } from "@/lib/importers/import-conflicts";
import type { MemberDraft } from "@/lib/importers";

const JOB = "job_now";
const draft = (over: Partial<MemberDraft> = {}): MemberDraft => ({
  name: "Jo Bloggs",
  email: "jo@example.test",
  status: "active",
  paymentStatus: "paid",
  membershipType: "Beginners",
  accountType: "adult",
  sourceKey: "teamup:jo@example.test|jo bloggs",
  sourceRows: [4],
  ...over,
});
const member = (over: Partial<CandidateMember> = {}): CandidateMember => ({
  id: "m1",
  name: "Jo Bloggs",
  email: "jo@example.test",
  phone: null,
  dateOfBirth: null,
  accountType: "adult",
  membershipType: "Beginners",
  membershipTierId: "tier_beg",
  status: "active",
  paymentStatus: "paid",
  cancelledAt: null,
  externalRef: "teamup:jo@example.test|jo bloggs",
  importJobId: "job_first",
  ...over,
});
const plan = { tierId: "tier_beg", label: "Beginners" };

describe("classify", () => {
  it("nobody matches: a new person", () => {
    expect(classify({ draft: draft(), plan, byIdentity: [], byKey: null, jobId: JOB })).toEqual({ kind: "new" });
  });

  it("the same person with the same values is an exact duplicate (skipped, nothing listed)", () => {
    const m = member();
    expect(classify({ draft: draft(), plan, byIdentity: [m], byKey: m, jobId: JOB })).toEqual({ kind: "duplicate", memberId: "m1" });
  });

  it("case, spacing and phone formatting are not differences", () => {
    const m = member({ name: "jo  bloggs", phone: "07700 900 123" });
    expect(classify({ draft: draft({ phone: "07700900123" }), plan, byIdentity: [m], byKey: m, jobId: JOB }).kind).toBe("duplicate");
  });

  it("a plan and a status staff changed in MatFlow are listed, not overwritten", () => {
    const m = member({ membershipType: "Advanced", membershipTierId: "tier_adv", status: "inactive" });
    const c = classify({ draft: draft(), plan, byIdentity: [m], byKey: m, jobId: JOB });
    expect(c).toMatchObject({ kind: "conflict", memberId: "m1", rows: [4] });
    expect(c.kind === "conflict" && c.fields).toEqual([
      { field: "plan", upload: "Beginners", matflow: "Advanced" },
      { field: "status", upload: "active", matflow: "inactive" },
    ]);
  });

  it("a member cancelled in MatFlow stays cancelled: the file's 'active' is a listed difference", () => {
    const m = member({ status: "cancelled", cancelledAt: new Date("2026-09-30T00:00:00Z") });
    const c = classify({ draft: draft(), plan, byIdentity: [m], byKey: m, jobId: JOB });
    expect(c.kind).toBe("conflict");
    expect(c.kind === "conflict" && c.fields).toContainEqual({ field: "status", upload: "active", matflow: "cancelled" });
  });

  it("a record with no edit history (created in MatFlow, no record key) is preserved and the difference flagged", () => {
    const m = member({ externalRef: null, importJobId: null, paymentStatus: "overdue" });
    const c = classify({ draft: draft(), plan, byIdentity: [m], byKey: null, jobId: JOB });
    expect(c.kind).toBe("conflict");
    expect(c.kind === "conflict" && c.fields).toEqual([{ field: "paymentStatus", upload: "paid", matflow: "overdue" }]);
  });

  it("a value the file does not state is no information, never a difference", () => {
    const m = member({ phone: "07700 900123", dateOfBirth: new Date("1990-01-01T00:00:00Z") });
    expect(classify({ draft: draft({ phone: undefined, dateOfBirth: undefined }), plan, byIdentity: [m], byKey: m, jobId: JOB }).kind).toBe("duplicate");
  });

  it("email points at one member and the record key at another: ambiguous, nobody chosen", () => {
    const a = member({ id: "a", externalRef: null });
    const b = member({ id: "b", email: "jo.old@example.test" });
    const c = classify({ draft: draft(), plan, byIdentity: [a], byKey: b, jobId: JOB });
    expect(c).toMatchObject({ kind: "ambiguous", memberIds: ["a", "b"] });
  });

  it("two members share the name and date of birth: ambiguous", () => {
    const c = classify({ draft: draft({ email: "x@no-login.matflow.local", nonContactable: true }), plan, byIdentity: [member({ id: "a" }), member({ id: "b" })], byKey: null, jobId: JOB });
    expect(c).toMatchObject({ kind: "ambiguous", memberIds: ["a", "b"] });
  });

  it("same email, but the member carries a DIFFERENT record key from an earlier import: ambiguous", () => {
    const m = member({ externalRef: "teamup:someone-else" });
    expect(classify({ draft: draft(), plan, byIdentity: [m], byKey: null, jobId: JOB })).toMatchObject({ kind: "ambiguous", memberIds: ["m1"] });
  });

  it("a member this same job created on an interrupted call is its own work, not a duplicate", () => {
    const m = member({ importJobId: JOB });
    expect(classify({ draft: draft(), plan, byIdentity: [m], byKey: m, jobId: JOB })).toEqual({ kind: "own", memberId: "m1" });
  });

  it("a synthesised no-login address is never compared as an email", () => {
    const m = member({ email: "abc@no-login.matflow.local" });
    expect(differences(uploadValues(draft({ email: "xyz@no-login.matflow.local", nonContactable: true }), plan), m).map((f) => f.field)).not.toContain("email");
  });
});

describe("stillDiffers (what the review list shows against MatFlow now)", () => {
  it("reads 'matches now' once someone has changed the member by hand", () => {
    expect(stillDiffers("status", "cancelled", "cancelled")).toBe(false);
    expect(stillDiffers("status", "cancelled", "active")).toBe(true);
    expect(stillDiffers("plan", "Beginners", "beginners")).toBe(false);
  });
});
