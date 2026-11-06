// Prisma Migrate does not run a migration.sql inside a transaction: the 30 Sep
// 2026 failure drill made a migration fail on its second statement and the
// first (an ALTER TABLE) stayed applied, so a failed deploy could leave
// production half-migrated and the documented "resolve --rolled-back, fix,
// redeploy" recovery would then fail on "already exists". Every migration from
// the Total BJJ candidate onwards wraps itself in BEGIN/COMMIT; the same drill
// then left nothing behind and recovered cleanly.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "prisma", "migrations");
// The first migration not yet on production when this rule began.
const FROM = "20260923220000";

const recent = readdirSync(DIR)
  .filter((d) => /^\d{14}_/.test(d) && d.slice(0, 14) >= FROM)
  .sort();

function statements(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, "").trim())
    .filter(Boolean);
}

describe("migrations are all-or-nothing", () => {
  it("finds the candidate migrations (sanity)", () => {
    expect(recent.length).toBeGreaterThanOrEqual(6);
  });

  it.each(recent)("%s opens with BEGIN and closes with COMMIT", (dir) => {
    const lines = statements(readFileSync(join(DIR, dir, "migration.sql"), "utf8"));
    expect(lines[0]?.toUpperCase()).toBe("BEGIN;");
    expect(lines[lines.length - 1]?.toUpperCase()).toBe("COMMIT;");
    // Statements that cannot run inside a transaction would break the wrapper.
    const body = lines.join("\n").toUpperCase();
    expect(body).not.toMatch(/CONCURRENTLY/);
    expect(body).not.toMatch(/ALTER TYPE .* ADD VALUE/);
  });
});
