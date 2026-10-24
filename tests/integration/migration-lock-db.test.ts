// lib/migration-lock.ts against a REAL database (the Neon test branch; tests/setup-test-db.ts refuses production).
//
// A "migration" here is a separate session doing exactly what `prisma migrate deploy` does (verified on Prisma 7.10.0,
// docs/readiness/MIGRATION-SAFETY-2026-10-24.md): `SELECT pg_advisory_lock(72707369)` on its own session. It runs on
// the DIRECT host — through the pgbouncer pooler a session lock outlives the session that took it (the reason
// scripts/maybe-migrate.mjs migrates on the direct host). Every hold is a few hundred milliseconds and is released in
// `finally`, so a parallel `prisma migrate deploy` on this branch at worst waits that long.
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import pg from "pg";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { holdOffMigrations, MigrationInProgressError, PRISMA_MIGRATE_ADVISORY_LOCK_KEY as KEY } from "@/lib/migration-lock";
import { JOB_SOURCE, runStep } from "@/lib/attendance-import";
import { directNeonUrl } from "../../scripts/maybe-migrate.mjs";
import { classifyDbTarget, assertTestBranch, skipReason } from "./helpers/db-target";

const TARGET = classifyDbTarget(process.env.DATABASE_URL);
const HAS_DB = TARGET === "run" || TARGET === "refuse";
const SKIP_NOTE = skipReason(TARGET) ? ` [skipped: ${skipReason(TARGET)}]` : "";
const STAMP = `mlk${Date.now().toString(36)}`;

/** A session on the direct host, as `prisma migrate deploy` has. */
async function session(name: string) {
  const c = new pg.Client({ connectionString: directNeonUrl(process.env.DATABASE_URL!), application_name: `${STAMP}-${name}` });
  c.on("error", () => {});
  await c.connect();
  return c;
}

/** Hold Prisma Migrate's lock (exclusive, session level) for the duration of `fn`. */
async function asMigration<T>(fn: () => Promise<T>): Promise<T> {
  const m = await session("migration");
  try {
    await m.query(`SELECT pg_advisory_lock(${KEY})`);
    return await fn();
  } finally {
    await m.query(`SELECT pg_advisory_unlock(${KEY})`).catch(() => {});
    await m.end().catch(() => {});
  }
}

/** A job transaction holding the shared form until `release()` is called. */
function openJobTransaction(tenantId: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held!: () => void;
  const ready = new Promise<void>((r) => (held = r));
  const done = withTenantContext(tenantId, async (tx) => {
    await holdOffMigrations(tx);
    held();
    await gate;
  }, { timeout: 30_000 });
  return { ready, release, done };
}

describe.skipIf(!HAS_DB)(`migration lock on the test database${SKIP_NOTE}`, () => {
  let tenantId = "";
  let userId = "";

  beforeAll(async () => {
    assertTestBranch(process.env.DATABASE_URL);
    const club = await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} club`, slug: `${STAMP}-club`, onboardingCompleted: true } });
      const u = await tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-owner@example.test`, name: "Owner", role: "owner", passwordHash: "x" } });
      return { t: t.id, u: u.id };
    });
    tenantId = club.t;
    userId = club.u;
  }, 60_000);

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.importJob.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    expect(await withRlsBypass((tx) => tx.tenant.count({ where: { id: tenantId } }))).toBe(0);
  }, 60_000);

  it("with no migration, job transactions are admitted, and two of them hold the shared form at once", async () => {
    const a = openJobTransaction(tenantId);
    await a.ready;
    try {
      await expect(withTenantContext(tenantId, async (tx) => { await holdOffMigrations(tx); return "admitted"; })).resolves.toBe("admitted");
    } finally {
      a.release();
      await a.done;
    }
  }, 60_000);

  it("while a migration holds the lock, a job transaction is refused at once with MigrationInProgressError", async () => {
    await asMigration(async () => {
      const t0 = Date.now();
      const e = await withTenantContext(tenantId, async (tx) => { await holdOffMigrations(tx); return "admitted"; }).catch((x) => x);
      expect(e).toBeInstanceOf(MigrationInProgressError);
      expect(Date.now() - t0).toBeLessThan(10_000); // refused, not queued
    });
    // Released: admitted again.
    await expect(withTenantContext(tenantId, async (tx) => { await holdOffMigrations(tx); return "admitted"; })).resolves.toBe("admitted");
  }, 60_000);

  it("while a job transaction holds the shared form, a migration cannot take the lock (it would wait); once the job commits it can", async () => {
    const a = openJobTransaction(tenantId);
    await a.ready;
    const m = await session("migration-try");
    try {
      expect((await m.query(`SELECT pg_try_advisory_lock(${KEY}) AS ok`)).rows[0].ok).toBe(false);
      a.release();
      await a.done;
      expect((await m.query(`SELECT pg_try_advisory_lock(${KEY}) AS ok`)).rows[0].ok).toBe(true);
    } finally {
      a.release();
      await m.query(`SELECT pg_advisory_unlock_all()`).catch(() => {});
      await m.end().catch(() => {});
    }
  }, 60_000);

  it("once a migration is WAITING behind a job, a new job is refused (it queues behind the migration, so it may not start)", async () => {
    const a = openJobTransaction(tenantId);
    await a.ready;
    const m = await session("migration-waiting");
    const watcher = await session("watcher");
    try {
      const waiting = m.query(`SELECT pg_advisory_lock(${KEY})`);
      let seen = false;
      for (let i = 0; i < 50 && !seen; i++) {
        const r = await watcher.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = ${KEY} AND NOT granted`);
        seen = r.rows[0].n > 0;
        if (!seen) await new Promise((r2) => setTimeout(r2, 100));
      }
      expect(seen, "the migration session is waiting for the lock").toBe(true);
      const e = await withTenantContext(tenantId, async (tx) => { await holdOffMigrations(tx); return "admitted"; }).catch((x) => x);
      expect(e).toBeInstanceOf(MigrationInProgressError);
      a.release();
      await a.done;
      await waiting; // the migration now holds it
    } finally {
      a.release();
      await m.query(`SELECT pg_advisory_unlock_all()`).catch(() => {});
      await m.end().catch(() => {});
      await watcher.end().catch(() => {});
    }
  }, 60_000);

  it("an attendance import step during a migration is 'busy' and touches nothing; after it, the step proceeds", async () => {
    const job = await withRlsBypass((tx) =>
      tx.importJob.create({
        data: { tenantId, createdById: userId, source: JOB_SOURCE, fileName: `${STAMP}.csv`, fileBlobUrl: `test://${STAMP}/missing`, status: "running", processedRows: 0 },
        select: { id: true },
      }),
    );
    const readFile = async () => null; // the file is absent: an admitted step fails on it, which proves it got past the gate
    const before = await withRlsBypass((tx) => tx.importJob.findUniqueOrThrow({ where: { id: job.id } }));
    const during = await asMigration(() => runStep(tenantId, job.id, readFile));
    expect(during).toEqual({ kind: "busy" });
    const mid = await withRlsBypass((tx) => tx.importJob.findUniqueOrThrow({ where: { id: job.id } }));
    expect(mid).toMatchObject({ status: "running", processedRows: 0, leaseToken: null, errorLog: before.errorLog });
    const after = await runStep(tenantId, job.id, readFile);
    expect(after).toMatchObject({ kind: "failed", error: expect.stringContaining("no longer stored") });
  }, 60_000);
});
