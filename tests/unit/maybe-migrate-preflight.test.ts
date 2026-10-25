/**
 * scripts/maybe-migrate.mjs helpers (brief S2.3, 24 Oct 2026): the build migrates on Neon's DIRECT host, and refuses to
 * start migrating while another transaction has been open longer than the migrations' lock_timeout. No database is
 * contacted here (the preflight is driven with a fake client); the URLs are fabricated.
 */
import { describe, it, expect } from "vitest";
import { directNeonUrl, migrationPreflight, PREFLIGHT_MAX_TRANSACTION_SECONDS } from "../../scripts/maybe-migrate.mjs";

const POOLED = "postgresql://fake-user:fake-secret@ep-some-thing-a1b2c3d4-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require&pgbouncer=true&channel_binding=require";

describe("directNeonUrl", () => {
  it("moves a Neon -pooler host to its direct host, drops pgbouncer=, keeps credentials, database and other parameters", () => {
    const out = new URL(directNeonUrl(POOLED));
    const inp = new URL(POOLED);
    expect(out.hostname).toBe("ep-some-thing-a1b2c3d4.eu-west-2.aws.neon.tech");
    expect(out.searchParams.has("pgbouncer")).toBe(false);
    expect(out.searchParams.get("sslmode")).toBe("require");
    expect(out.searchParams.get("channel_binding")).toBe("require");
    expect(out.username).toBe(inp.username);
    expect(out.password).toBe(inp.password);
    expect(out.pathname).toBe("/neondb");
  });

  it("leaves a direct Neon host, a non-Neon host and an unparsable value exactly as they are", () => {
    const direct = "postgresql://u:p@ep-some-thing-a1b2c3d4.eu-west-2.aws.neon.tech/neondb?sslmode=require";
    expect(directNeonUrl(direct)).toBe(direct);
    const local = "postgresql://postgres:postgres@localhost:5432/postgres?schema=public";
    expect(directNeonUrl(local)).toBe(local);
    const lookalike = "postgresql://u:p@db-pooler.example.invalid/x"; // not *.neon.tech
    expect(directNeonUrl(lookalike)).toBe(lookalike);
    expect(directNeonUrl("not a url")).toBe("not a url");
  });
});

type Q = { sql: string; params?: unknown[] };
function fakeDb(opts: { table: boolean; applied: string[]; activity: Array<{ pid?: number; usename?: string; application_name?: string; state: string | null; age_s: number | null; unseen: boolean }> }) {
  const calls: Q[] = [];
  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql.includes("to_regclass")) return { rows: [{ present: opts.table }] };
      if (sql.includes('FROM "_prisma_migrations"')) return { rows: opts.applied.map((m) => ({ migration_name: m })) };
      if (sql.includes("pg_stat_activity")) return { rows: opts.activity };
      throw new Error(`unexpected query ${sql}`);
    },
  };
}

describe("migrationPreflight", () => {
  const dirs = ["20261009010000_a", "20261017020102_b", "20261021230000_c"];

  it("with nothing pending, it never looks at other sessions", async () => {
    const db = fakeDb({ table: true, applied: dirs, activity: [{ state: "idle in transaction", age_s: 999, unseen: false }] });
    const r = await migrationPreflight(db, dirs);
    expect(r).toEqual({ pending: [], blockers: [], unseen: 0 });
    expect(db.calls.some((c) => c.sql.includes("pg_stat_activity"))).toBe(false);
  });

  it("with migrations pending, a transaction open longer than the bound is a blocker; invisible sessions are counted, not ignored", async () => {
    const db = fakeDb({
      table: true,
      applied: ["20261009010000_a"],
      activity: [
        { pid: 4101, usename: "app_role", application_name: "psql", state: "idle in transaction", age_s: 42, unseen: false },
        { pid: 4102, usename: "app_role", application_name: "", state: "active", age_s: 7, unseen: false },
        { state: null, age_s: null, unseen: true },
      ],
    });
    const r = await migrationPreflight(db, dirs);
    expect(r.pending).toEqual(["20261017020102_b", "20261021230000_c"]);
    // Identified so the session can be ended (review 25 Oct, L-2); none of these is a credential.
    expect(r.blockers).toEqual([
      { state: "idle in transaction", ageS: 42, pid: 4101, role: "app_role", app: "psql" },
      { state: "active", ageS: 7, pid: 4102, role: "app_role", app: null },
    ]);
    expect(r.unseen).toBe(1);
    const activity = db.calls.find((c) => c.sql.includes("pg_stat_activity"))!;
    expect(activity.params).toEqual([PREFLIGHT_MAX_TRANSACTION_SECONDS]);
    expect(activity.sql).toContain("pid <> pg_backend_pid()");
    expect(activity.sql).toContain("datname = current_database()");
  });

  it("a fresh database (no _prisma_migrations) has everything pending", async () => {
    const db = fakeDb({ table: false, applied: [], activity: [] });
    const r = await migrationPreflight(db, dirs);
    expect(r.pending).toEqual(dirs);
    expect(r.blockers).toEqual([]);
  });

  it("the bound is the migrations' own lock_timeout (5 s)", () => {
    expect(PREFLIGHT_MAX_TRANSACTION_SECONDS).toBe(5);
  });
});
