/**
 * Security campaign iteration 2, lane E2 (9 Oct 2026): the containment checklist and every E2 evidence file are
 * redacted. They may carry 12-hex fingerprints, variable NAMES, public prefixes and public identifiers; never a
 * password, key, token, secret value or a connection string with credentials.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanText } from "../../scripts/readiness/secret-scan.mjs";

const ROOT = path.resolve(__dirname, "../..");
const files = [
  "docs/security/CONTAINMENT-CHECKLIST.md",
  ...fs.readdirSync(path.join(ROOT, "docs/security/evidence/E2")).map((f) => `docs/security/evidence/E2/${f}`),
].filter((f) => fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile());

describe("lane E2 deliverables are redacted", () => {
  it("covers the checklist and at least one evidence file", () => {
    expect(files).toContain("docs/security/CONTAINMENT-CHECKLIST.md");
    expect(files.length).toBeGreaterThan(1);
  });

  it.each(files)("%s carries no secret-shaped value", (rel) => {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const candidates = scanText(text, rel).filter((f: { classification: string }) => f.classification === "candidate");
    expect(candidates).toEqual([]);
    expect(text).not.toMatch(/postgres(ql)?:\/\/[^\s:@/]+:[^\s@/]{4,}@/i);
    expect(text).not.toMatch(/\bnpg_[A-Za-z0-9]{6,}/);
    expect(text).not.toMatch(/\bvercel_blob_rw_[A-Za-z0-9]{6,}/i);
    expect(text).not.toMatch(/\b(sk|rk)_live_[A-Za-z0-9]{6,}/);
    expect(text).not.toMatch(/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/);
    expect(text).not.toMatch(/\bwhsec_[A-Za-z0-9]{8,}/);
  });
});
