// lib/migration-lock.ts (brief S2.3, 24 Oct 2026): the bulk jobs take the SHARED form of Prisma Migrate's own advisory
// lock, without waiting, first in each write transaction. The database behaviour (Prisma's key, the queueing, the
// refusal) is exercised in tests/integration/migration-lock-db.test.ts and the rehearsal record; this file pins the SQL
// and which transactions are covered.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  holdOffMigrations,
  isMigrationInProgress,
  MigrationInProgressError,
  MIGRATION_IN_PROGRESS_MESSAGE,
  PRISMA_MIGRATE_ADVISORY_LOCK_KEY,
} from "@/lib/migration-lock";

function fakeTx(ok: boolean | null) {
  const seen: { sql: string; values: unknown[] }[] = [];
  return {
    seen,
    $queryRaw: (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      seen.push({ sql: strings.join("?"), values });
      return ok === null ? [] : [{ ok }];
    }) as never,
  };
}

describe("holdOffMigrations", () => {
  it("is Prisma Migrate's key, single-bigint form", () => {
    expect(PRISMA_MIGRATE_ADVISORY_LOCK_KEY).toBe(72707369);
  });

  it("takes the shared, transaction-scoped, non-waiting form of the key", async () => {
    const tx = fakeTx(true);
    await expect(holdOffMigrations(tx)).resolves.toBeUndefined();
    expect(tx.seen).toHaveLength(1);
    expect(tx.seen[0].sql).toMatch(/^SELECT pg_try_advisory_xact_lock_shared\(\?::bigint\) AS ok$/);
    expect(tx.seen[0].values).toEqual([72707369]);
  });

  it("refuses with MigrationInProgressError when the key is held or awaited by a migration (or the answer is missing)", async () => {
    for (const ok of [false, null]) {
      const e = await holdOffMigrations(fakeTx(ok)).catch((x) => x);
      expect(e).toBeInstanceOf(MigrationInProgressError);
      expect(isMigrationInProgress(e)).toBe(true);
      expect(e.message).toBe(MIGRATION_IN_PROGRESS_MESSAGE);
      expect(e.status).toBe(503);
    }
    expect(isMigrationInProgress(new Error("other"))).toBe(false);
  });

  it("the owner-facing message says nothing changed and the job can be run again (British English, no jargon)", () => {
    expect(MIGRATION_IN_PROGRESS_MESSAGE).toMatch(/Nothing was changed/);
    expect(MIGRATION_IN_PROGRESS_MESSAGE).toMatch(/try again in a few minutes/);
    expect(MIGRATION_IN_PROGRESS_MESSAGE).not.toMatch(/advisory|lock|Prisma|migration/i);
  });
});

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Transactions whose callback opens with holdOffMigrations (comments allowed before it). */
const firstInTx = (s: string) => [...s.matchAll(/withTenantContext\(\s*tenantId,\s*async \(tx\) => \{\s*(?:\/\/[^\n]*\n\s*)*await holdOffMigrations\(tx\);/g)].length;

describe("which job transactions hold migrations off", () => {
  it("TeamUp commit: the claim, both member slices and the ledger chunks (a refresh writes no member since 25 Oct 2026); a slice never swallows the refusal", () => {
    const s = src("app/api/admin/import/[id]/commit/route.ts");
    expect(firstInTx(s)).toBe(4);
    expect(s.match(/if \(isMigrationInProgress\(e\)\) throw e;/g)?.length).toBe(2);
    expect(s).toMatch(/if \(isMigrationInProgress\(e\)\) return migrationInProgress\(\);/);
  });

  it("TeamUp rollback (members and status refresh): each single transaction, answered 503", () => {
    const s = src("app/api/admin/import/[id]/rollback/route.ts");
    expect(firstInTx(s)).toBe(2);
    expect(s.match(/if \(isMigrationInProgress\(e\)\) return migrationInProgress\(\);/g)?.length).toBe(2);
  });

  it("attendance import: the commit start and the rollback (route), the lease claim and every batch (engine)", () => {
    const route = src("app/api/admin/import/attendance/route.ts");
    expect(firstInTx(route)).toBe(2);
    const engine = src("lib/attendance-import.ts");
    expect(engine).toMatch(/await holdOffMigrations\(tx\);\s*return claimLease\(tx, tenantId, jobId, \["running", "failed"\]\);/);
    expect(engine).toMatch(/async \(tx\) => \{\s*await holdOffMigrations\(tx\);\s*await processBatch\(/);
    // A refusal mid-step gives the lease back and reports busy; it never marks the job failed.
    expect(engine).toMatch(/if \(isMigrationInProgress\(e\)\) \{[\s\S]{0,400}?releaseLease\(tx, tenantId, jobId, token\)\)[\s\S]{0,80}?return \{ kind: "busy" \};/);
  });
});
