import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { classifyVerification, reconcileMatrix, reconcileFindings, reviewerApproved } from "../../scripts/readiness/coverage-reconcile.mjs";

/** Lane F2 (iteration 2): exhaustive, deterministic classification; FIXED counts as PASS only with an approval. */
describe("coverage-reconcile classifyVerification()", () => {
  const cls = (s: string) => classifyVerification(s).cls;
  it("classifies by the final state of a transition history", () => {
    expect(cls("FAIL → FIXED AWAITING RETEST (SF-56)")).toBe("FIXED AWAITING RETEST");
    expect(cls("FIXED AWAITING RETEST (SF-23) → PASS")).toBe("PASS");
    expect(classifyVerification("FIXED AWAITING RETEST (SF-23) → PASS").viaFixed).toBe(true);
  });
  it("treats an arrow to a non-status as a cross-reference", () => {
    expect(cls("PASS (I) for staff removal; transfer → SEC-032")).toBe("PASS");
    expect(cls("PASS member create/edit (U/I); other routes → lane C")).toBe("PASS");
  });
  it("takes the worst of top-level alternatives, including scope-first ones", () => {
    expect(cls("PASS (config) / BLOCKED (live TLS)")).toBe("BLOCKED");
    expect(cls("PASS (advisories) / fuzz NOT RUN")).toBe("NOT RUN");
    expect(cls("PASS (no dangling) / FAIL (no DMARC)")).toBe("FAIL");
  });
  it("maps the remaining vocabulary and refuses anything else", () => {
    expect(cls("OPEN Low (C)")).toBe("FAIL");
    expect(cls("**BLOCKED** (no restore)")).toBe("BLOCKED");
    expect(cls("guard test")).toBe("N/A (guard test)");
    expect(cls("documented only (runbook §4)")).toBe("NOT RUN");
    expect(cls("SF-26 FIXED AWAITING RETEST; SF-58 partial")).toBe("FIXED AWAITING RETEST");
    expect(cls("PASSABLE")).toBe("UNPARSED");
    expect(cls("looks fine")).toBe("UNPARSED");
    expect(cls("")).toBe("UNPARSED");
  });
  it("an approval is named, not implied", () => {
    expect(reviewerApproved("R: approved 9 Oct")).toBe(true);
    expect(reviewerApproved("R: reviewed 9 Oct")).toBe(false);
    expect(reviewerApproved("R: NOT approved")).toBe(false);
    expect(reviewerApproved("—")).toBe(false);
  });
});

describe("coverage-reconcile reconcileMatrix()", () => {
  const header = "| ID | Area | Lane | Risk | Inv | Level | Applicability | Verification | Evidence | Reviewer | Refs |";
  const row = (id: string, app: string, ver: string, rev: string) => `| ${id} | a | A | r | i | U | ${app} | ${ver} | e | ${rev} | — |`;
  const doc = (rows: string[]) => [header, "|---|", ...rows].join("\n");
  it("--require-reviewed counts FIXED as PASS only with an approval", () => {
    const src = doc([row("SEC-001", "APPLICABLE", "FIXED AWAITING RETEST", "R: approved"), row("SEC-002", "APPLICABLE", "FAIL → FIXED", "R: reviewed"), row("SEC-003", "APPLICABLE", "FIXED → PASS", "—")]);
    const plain = reconcileMatrix(src, { expectedCount: 3 }).summary;
    expect(plain.verification).toEqual({ "FIXED AWAITING RETEST": 2, PASS: 1 });
    const strict = reconcileMatrix(src, { expectedCount: 3, requireReviewed: true }).summary;
    expect(strict.verification).toEqual({ "FIXED AWAITING RETEST": 2, PASS: 1 });
    expect(strict.fixedCountedAsPass).toBe(1);
    expect(strict.verdict).toBe("RECONCILED");
  });
  it("fails on a missing, duplicated, malformed, unparsed or inconsistent row", () => {
    const bad = reconcileMatrix(doc([row("SEC-001", "APPLICABLE", "PASS", "—"), row("SEC-001", "APPLICABLE", "maybe", "—"), "| SEC-003 | short |", row("SEC-004", "APPLICABLE", "guard test", "—")]), { expectedCount: 4 }).summary;
    expect(bad.verdict).toBe("FAIL");
    expect(bad.missing).toEqual(["SEC-002"]);
    expect(bad.dups).toEqual(["SEC-001"]);
    expect(bad.malformed[0]).toMatch(/^SEC-003/);
    expect(bad.unparsed).toContain("SEC-001");
    expect(bad.inconsistent[0]).toMatch(/^SEC-004/);
  });
  it("the real matrix reconciles with no UNPARSED row, deterministically", () => {
    const src = readFileSync("docs/security/COVERAGE-MATRIX.md", "utf8");
    const a = reconcileMatrix(src, { requireReviewed: true });
    expect(a.summary.unparsed).toEqual([]);
    expect(a.summary.verdict).toBe("RECONCILED");
    expect(JSON.stringify(reconcileMatrix(src, { requireReviewed: true }))).toBe(JSON.stringify(a));
  });
  it("findings ledger: duplicate ids and rows wider than their header are reported", () => {
    const f = reconcileFindings("| ID | a | b |\n|---|\n| SF-01 | x | y |\n| SF-01 | x | y |\n| SF-03 | x | y | z |");
    expect(f.dups).toEqual(["SF-01"]);
    expect(f.gaps).toEqual(["SF-02"]);
    expect(f.problems[0]).toMatch(/^SF-03/);
  });
});
