/**
 * scripts/maybe-migrate.mjs URL selection (6 Oct 2026).
 *
 * MIGRATION_DATABASE_URL wins when set, otherwise DATABASE_URL, and the
 * production-endpoint guard applies to whichever URL would be migrated.
 * Neither value may ever be printed.
 *
 * Every case here ends BEFORE `prisma migrate deploy` would run (skip or the
 * production guard), so no database is contacted. The URLs are fabricated.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "../../scripts/maybe-migrate.mjs");
const PROD_FAKE = "postgresql://fake-user:fake-secret-1@ep-bold-wave-abt39t7x.example.invalid/neondb";
const BRANCH_FAKE = "postgresql://fake-user:fake-secret-2@ep-not-prod-000000.example.invalid/neondb";

function run(env: Record<string, string | undefined>) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "DATABASE_URL" || k === "MIGRATION_DATABASE_URL" || k === "VERCEL_ENV") continue;
    base[k] = v;
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) base[k] = v;
  const r = spawnSync(process.execPath, [SCRIPT], { env: base as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("maybe-migrate URL selection", () => {
  it("skips when neither URL is set", () => {
    const r = run({});
    expect(r.code).toBe(0);
    expect(r.out).toContain("skipping `prisma migrate deploy`");
  });

  it("prefers MIGRATION_DATABASE_URL: a prod migration URL is refused outside production even if DATABASE_URL is a branch", () => {
    const r = run({ MIGRATION_DATABASE_URL: PROD_FAKE, DATABASE_URL: BRANCH_FAKE });
    expect(r.code).toBe(0);
    expect(r.out).toContain("REFUSING to run migrations: MIGRATION_DATABASE_URL points at the prod Neon endpoint");
    expect(r.out).not.toContain("running `prisma migrate deploy`");
  });

  it("falls back to DATABASE_URL when MIGRATION_DATABASE_URL is unset (today's behaviour)", () => {
    const r = run({ DATABASE_URL: PROD_FAKE });
    expect(r.code).toBe(0);
    expect(r.out).toContain("REFUSING to run migrations: DATABASE_URL points at the prod Neon endpoint");
  });

  it("refuses (exit 1, before migrating) when the two URLs name different endpoints", () => {
    const r = run({ VERCEL_ENV: "production", MIGRATION_DATABASE_URL: PROD_FAKE, DATABASE_URL: BRANCH_FAKE });
    expect(r.code).toBe(1);
    expect(r.out).toContain("do not name the same database endpoint");
    expect(r.out).not.toContain("running `prisma migrate deploy`");
  });

  it("never prints either URL or any part of its credentials", () => {
    for (const env of [
      { MIGRATION_DATABASE_URL: PROD_FAKE, DATABASE_URL: BRANCH_FAKE },
      { DATABASE_URL: PROD_FAKE },
      { VERCEL_ENV: "production", MIGRATION_DATABASE_URL: PROD_FAKE, DATABASE_URL: BRANCH_FAKE },
    ]) {
      const r = run(env);
      for (const secret of ["fake-secret-1", "fake-secret-2", "fake-user", "example.invalid"]) {
        expect(r.out).not.toContain(secret);
      }
    }
  });
});
