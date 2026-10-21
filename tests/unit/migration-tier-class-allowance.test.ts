// T7c: the tier class allowance migrations are expand-only, atomic, and their
// CHECK ranges match lib/class-allowance.ts. Reads the SQL files; no database.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWANCE_BASES, CLASS_LIMIT_MAX, CLASS_LIMIT_MIN, CLASS_LIMIT_WEEKS_MAX, CLASS_LIMIT_WEEKS_MIN } from "@/lib/class-allowance";

function load(dir: string) {
  const sql = readFileSync(join(process.cwd(), "prisma", "migrations", dir, "migration.sql"), "utf8");
  const code = sql.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
  const statements = code.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { code, statements };
}

describe("20261017052858_tier_class_allowance (the first columns)", () => {
  const { code, statements } = load("20261017052858_tier_class_allowance");

  it("opens with BEGIN and closes with COMMIT", () => {
    expect(statements[0]).toBe("BEGIN;");
    expect(statements[statements.length - 1]).toBe("COMMIT;");
  });

  it("adds two nullable integer columns with no default and no backfill", () => {
    expect(code).toMatch(/ADD COLUMN\s+"classLimit" INTEGER,/);
    expect(code).toMatch(/ADD COLUMN\s+"classLimitWeeks" INTEGER;/);
    expect(code).not.toMatch(/NOT NULL/);
    expect(code).not.toMatch(/DEFAULT/);
    expect(code).not.toMatch(/\bUPDATE\b/);
  });

  it("never drops or renames anything, and leaves maxClassesPerWeek alone", () => {
    expect(code).not.toMatch(/\bDROP\b/i);
    expect(code).not.toMatch(/\bRENAME\b/i);
    expect(code).not.toMatch(/maxClassesPerWeek/);
  });

  it("every ADD CONSTRAINT is NOT VALID followed by VALIDATE", () => {
    const added = [...code.matchAll(/ADD CONSTRAINT "([^"]+)"[\s\S]*?;/g)];
    expect(added.map((m) => m[1]).sort()).toEqual([
      "MembershipTier_classLimitWeeks_check",
      "MembershipTier_classLimit_check",
      "MembershipTier_classLimit_pair_check",
    ]);
    for (const m of added) {
      expect(m[0]).toMatch(/NOT VALID;$/);
      expect(code).toContain(`VALIDATE CONSTRAINT "${m[1]}";`);
    }
  });

  it("the classLimit range matches the helper the routes validate with (the weeks CHECK is replaced by the basis migration)", () => {
    expect(code).toContain(`"classLimit" BETWEEN ${CLASS_LIMIT_MIN} AND ${CLASS_LIMIT_MAX}`);
    expect(code).toContain(`"classLimitWeeks" BETWEEN 1 AND 8`);
  });
});

describe("20261021140000_tier_class_allowance_basis (the explicit reset basis)", () => {
  const { code, statements } = load("20261021140000_tier_class_allowance_basis");

  it("opens with BEGIN and closes with COMMIT", () => {
    expect(statements[0]).toBe("BEGIN;");
    expect(statements[statements.length - 1]).toBe("COMMIT;");
  });

  it("adds a nullable text basis and a nullable date anchor, no default, no backfill", () => {
    expect(code).toMatch(/ADD COLUMN\s+"classLimitBasis" TEXT,/);
    expect(code).toMatch(/ADD COLUMN\s+"classLimitAnchor" DATE;/);
    // No column is NOT NULL (the CHECK on the anchor says "IS NOT NULL", which is a different thing).
    expect(code).not.toMatch(/ADD COLUMN[^;]*NOT NULL/);
    expect(code).not.toMatch(/DEFAULT/);
    expect(code).not.toMatch(/\bUPDATE\b/);
  });

  it("drops only the two superseded CHECKs (never a column), and never renames; maxClassesPerWeek is untouched", () => {
    const drops = [...code.matchAll(/DROP CONSTRAINT IF EXISTS "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(drops).toEqual(["MembershipTier_classLimitWeeks_check", "MembershipTier_classLimit_pair_check"]);
    expect(code).not.toMatch(/DROP COLUMN/i);
    expect(code).not.toMatch(/\bRENAME\b/i);
    expect(code).not.toMatch(/maxClassesPerWeek/);
  });

  it("every ADD CONSTRAINT is NOT VALID followed by VALIDATE", () => {
    const added = [...code.matchAll(/ADD CONSTRAINT "([^"]+)"[\s\S]*?NOT VALID;/g)];
    expect(added.map((m) => m[1]).sort()).toEqual([
      "MembershipTier_classLimitBasis_check",
      "MembershipTier_classLimitWeeks_check",
      "MembershipTier_classLimit_basis_pair_check",
    ]);
    for (const m of added) expect(code).toContain(`VALIDATE CONSTRAINT "${m[1]}";`);
  });

  it("the CHECKs match the helpers the routes validate with", () => {
    expect(code).toContain(`"classLimitBasis" IN (${ALLOWANCE_BASES.map((b) => `'${b}'`).join(", ")})`);
    expect(code).toContain(`("classLimit" IS NULL) = ("classLimitBasis" IS NULL)`);
    expect(code).toContain(`"classLimitWeeks" BETWEEN ${CLASS_LIMIT_WEEKS_MIN} AND ${CLASS_LIMIT_WEEKS_MAX} AND "classLimitAnchor" IS NOT NULL`);
    expect(code).toContain(`"classLimitBasis" IS DISTINCT FROM 'weeks' AND "classLimitWeeks" IS NULL AND "classLimitAnchor" IS NULL`);
  });
});
