// T7c: the tier class allowance migration is expand-only, atomic, and its
// CHECK ranges match lib/class-allowance.ts. Reads the SQL file; no database.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLASS_LIMIT_MAX, CLASS_LIMIT_MIN, CLASS_LIMIT_WEEKS_MAX, CLASS_LIMIT_WEEKS_MIN } from "@/lib/class-allowance";

const SQL = readFileSync(
  join(process.cwd(), "prisma", "migrations", "20261017052858_tier_class_allowance", "migration.sql"),
  "utf8",
);
const code = SQL.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
const statements = code.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

describe("20261017052858_tier_class_allowance", () => {
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

  it("the CHECK ranges match the helpers the routes validate with", () => {
    expect(code).toContain(`"classLimit" BETWEEN ${CLASS_LIMIT_MIN} AND ${CLASS_LIMIT_MAX}`);
    expect(code).toContain(`"classLimitWeeks" BETWEEN ${CLASS_LIMIT_WEEKS_MIN} AND ${CLASS_LIMIT_WEEKS_MAX}`);
    expect(code).toContain(`("classLimit" IS NULL) = ("classLimitWeeks" IS NULL)`);
  });
});
