/**
 * Review F5 (batch-c review, 23 Oct 2026): the provenance migration's comment
 * says NOT VALID then VALIDATE avoids a full-table check under the ALTER's
 * lock. Inside its single BEGIN…COMMIT the ADD COLUMN's ACCESS EXCLUSIVE lock
 * is held to COMMIT, so that is wrong (the SQL itself is safe). The migration
 * was applied to the test branch, so its file must not change (a comment edit
 * changes the checksum); the correction lives in the folder's README.
 *
 * 26 Oct 2026 (release integration): the one change since is the bounded-wait
 * header (tests/unit/migrations-bounded-waits.test.ts), with the test branch
 * re-stamped; the pin below is the file with that header.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "prisma", "migrations", "20261017022302_status_event_source_provenance");

describe("provenance migration lock note (review F5)", () => {
  it("the migration SQL is byte-for-byte the reviewed file (statements as applied, plus the bounded-wait header)", () => {
    // Line endings normalised: git stores LF, a Windows checkout may show CRLF.
    const sql = readFileSync(join(DIR, "migration.sql"), "utf8").replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(sql).digest("hex")).toBe("64fbf7fc557e885ac5f1996a6d4ca387cd5c5121c6eacf0a8890464ff820e11c");
  });

  it("a README beside it corrects the lock comment", () => {
    const readme = join(DIR, "README.md");
    expect(existsSync(readme)).toBe(true);
    const text = readFileSync(readme, "utf8");
    expect(text).toMatch(/ACCESS EXCLUSIVE/);
    expect(text).toMatch(/held/);
    expect(text).toMatch(/separate/);
    expect(text).toMatch(/F5/);
  });
});
