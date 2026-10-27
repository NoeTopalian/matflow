/**
 * The rehearsal and re-stamp scripts refuse production and anything but their own scratch names BEFORE connecting
 * (brief S2.4, 24 Oct 2026). Fabricated URLs; no database is contacted (every case exits 2 at the guard).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const REHEARSAL = path.resolve(__dirname, "../../scripts/readiness/migration-rehearsal.mjs");
const RESTAMP = path.resolve(__dirname, "../../scripts/readiness/test-branch-restamp-migrations.mjs");
const PROD = "postgresql://fake-user:fake-secret-9@ep-bold-wave-abt39t7x-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";
const TEST = "postgresql://fake-user:fake-secret-8@ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";

function run(script: string, args: string[], url: string) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/DATABASE_URL|^PG/i.test(k)) env[k] = v;
  env.X_URL = url;
  const r = spawnSync(process.execPath, [script, ...args], { env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("migration-rehearsal.mjs guards", () => {
  it.each(["create", "list", "drop"])("%s refuses a production URL before connecting", (cmd) => {
    const r = run(REHEARSAL, [cmd, "X_URL", "matflow_rehearsal_20261024000000"], PROD);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/REFUSED/);
  });

  it.each([["migrate", "neondb"], ["seed", "postgres"], ["drop", "neondb"], ["drop", "matflow_rehearsal_x"], ["state", "matflow_rehearsal_2026"]])(
    "%s refuses database %s (only matflow_rehearsal_<14 digits> is ever touched)",
    (cmd, db) => {
      const r = run(REHEARSAL, [cmd, "X_URL", db, "."], TEST);
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/REFUSED: the database must be a matflow_rehearsal_<14 digits> name/);
    },
  );

  it("never prints the URL or its credentials", () => {
    for (const url of [PROD, TEST]) {
      const r = run(REHEARSAL, ["drop", "X_URL", "neondb"], url);
      for (const s of ["fake-secret", "fake-user"]) expect(r.out).not.toContain(s);
    }
  });
});

describe("test-branch-restamp-migrations.mjs guards", () => {
  it("refuses production, a non-scratch --database, and a missing --from", () => {
    expect(run(RESTAMP, ["X_URL", "--from", "HEAD", "20261021230000_member_billing_period_allowance_basis"], PROD).code).toBe(2);
    expect(run(RESTAMP, ["X_URL", "--from", "HEAD", "--database", "neondb", "20261021230000_member_billing_period_allowance_basis"], TEST).code).toBe(2);
    expect(run(RESTAMP, ["X_URL", "20261021230000_member_billing_period_allowance_basis"], TEST).code).toBe(2);
    const r = run(RESTAMP, ["X_URL", "--from", "HEAD", "20261021230000_member_billing_period_allowance_basis"], PROD);
    expect(r.out).not.toContain("fake-secret");
  });
});
