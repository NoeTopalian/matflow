// SF-57 / SEC-083 — append-only AuditLog at the runtime-role boundary (security campaign iteration 2, lane F2).
//
// Asserts the effects of docs/security/evidence/F2/proposed-auditlog-append-only-v2.sql AS THE CONNECTING ROLE:
//   matflow_app (or any role that is not the AuditLog owner): UPDATE / DELETE / TRUNCATE refused, INSERT works,
//     createdAt forced to now(), no DDL path (disable/replace/drop the triggers), FK SET NULL still works, the purge
//     function is the only delete path, refuses an out-of-range batch and does not leak the RLS bypass flag;
//   the table owner: UPDATE / TRUNCATE refused, DELETE and back-dated INSERT allowed (the owner exemption is what
//     lets the SECURITY DEFINER purge and a data restore work), purge deletes exactly the rows past the published
//     minimums — and the owner CAN disable the trigger, recorded as the boundary's limit.
// The migration is NOT applied on the TEST branch (adoption was refused to the lead on 9 Oct 2026 and stands), so on
// TEST this file SKIPS with the reason in the suite title and on stderr. It must not be on a skip-gate allow list
// once the migration is applied (see scripts/readiness/test-skip-gate.mjs, BLOCKED_ALLOWED).
//
// Every cell runs in a transaction that is ROLLED BACK; fixtures carry the secF2- prefix; afterAll count-checks
// that nothing with the prefix remains. Run with the guarded runners (owner: att/run-engine.sh; matflow_app:
// q78/run-restricted.sh). SEC_F2_SET_ROLE=<role> emulates a login role with SET ROLE and is honoured ONLY against
// a 127.0.0.1 database (the isolated PGlite restore of backup-restore.mjs); it is refused anywhere else.
import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";

const URL = process.env.DATABASE_URL;
const SET_ROLE = process.env.SEC_F2_SET_ROLE;
const STAMP = `secF2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TRIGGERS = ["AuditLog_append_only", "AuditLog_stamp_created_at", "AuditLog_no_truncate"];
const DAY = 24 * 60 * 60 * 1000;

type Probe = { present: boolean; reason: string; role: string; owner: string; isOwner: boolean; appRoleExists: boolean };

function ident(s: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`unexpected identifier ${s}`);
  return `"${s}"`;
}

async function connect(): Promise<pg.Client> {
  if (SET_ROLE) {
    const host = new globalThis.URL(URL!).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") throw new Error("SEC_F2_SET_ROLE is honoured only against the local isolated restore");
  }
  const c = new pg.Client({ connectionString: URL, application_name: "sec-f2-auditlog-append-only" });
  await c.connect();
  return c;
}

async function probe(): Promise<Probe> {
  const c = await connect();
  try {
    await c.query("BEGIN READ ONLY");
    if (SET_ROLE) await c.query(`SET LOCAL ROLE ${ident(SET_ROLE)}`);
    const r = (await c.query(`select current_user as role, pg_get_userbyid(c.relowner) as owner,
        (select coalesce(array_agg(tgname::text), '{}') from pg_trigger where tgrelid = c.oid and tgenabled <> 'D' and tgname = any($1)) as trg,
        to_regprocedure('public.audit_log_purge(integer)') is not null as purge,
        exists (select 1 from pg_roles where rolname = 'matflow_app') as app
      from pg_class c where c.oid = to_regclass('public."AuditLog"')`, [TRIGGERS])).rows[0];
    await c.query("ROLLBACK");
    const missing = [...TRIGGERS.filter((t) => !(r.trg as string[]).includes(t)), ...(r.purge ? [] : ["audit_log_purge(integer)"])];
    return {
      present: missing.length === 0,
      reason: missing.length ? `SF-57 append-only migration not applied on this database (missing: ${missing.join(", ")})` : "",
      role: r.role, owner: r.owner, isOwner: r.role === r.owner, appRoleExists: r.app,
    };
  } finally {
    await c.end();
  }
}

const P: Probe = URL
  ? await probe()
  : { present: false, reason: "no DATABASE_URL (database tests skip without the guarded runners)", role: "", owner: "", isOwner: false, appRoleExists: false };
if (!P.present) console.warn(`[sec-f2-auditlog-append-only] SKIPPED: ${P.reason}`);

let client: pg.Client | null = null;
async function tx<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  client ??= await connect();
  const c = client;
  await c.query("BEGIN");
  try {
    if (SET_ROLE) await c.query(`SET LOCAL ROLE ${ident(SET_ROLE)}`);
    await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [STAMP]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK");
  }
}
let sp = 0;
async function refused(c: pg.Client, sql: string, params: unknown[] = [], code = "42501"): Promise<void> {
  const name = `s${++sp}`;
  await c.query(`SAVEPOINT ${name}`);
  let err: { code?: string } | null = null;
  // Simple-query protocol for the statement expected to fail (parameters inlined as escaped literals): the PGlite
  // socket used for the isolated restore loses message sync when an extended-protocol statement errors inside a
  // transaction. Behaviour on a real server is identical either way.
  const inlined = sql.replace(/\$(\d+)/g, (_, n: string) => {
    const v = params[Number(n) - 1];
    return v === null || v === undefined ? "NULL" : c.escapeLiteral(String(v));
  });
  try { await c.query(inlined); } catch (e) { err = e as { code?: string }; }
  await c.query(`ROLLBACK TO SAVEPOINT ${name}`);
  expect(err, `expected refusal (${code}) for: ${sql}`).not.toBeNull();
  expect(err!.code).toBe(code);
}
/**
 * Inserts an audit row whose createdAt is `ageDays` before the database's UTC clock (timestamps are computed in SQL:
 * "createdAt" is timestamp WITHOUT time zone holding UTC wall-clock, and a JS Date would be serialised in the
 * client's local zone). Returns the stored row's age in seconds, measured server-side.
 */
async function insertAudit(c: pg.Client, o: { id: string; action?: string; ageDays?: number; metadata?: unknown; userId?: string | null; operatorId?: string | null }) {
  await c.query(
    `insert into "AuditLog"(id, "tenantId", "userId", "operatorId", action, "entityType", "entityId", metadata, "createdAt")
     values ($1, $2, $3, $4, $5, 'SecF2', $1, $6::jsonb, (now() at time zone 'UTC') - make_interval(days => $7::int))`,
    [o.id, STAMP, o.userId ?? null, o.operatorId ?? null, o.action ?? "secF2.ordinary", o.metadata === undefined ? null : JSON.stringify(o.metadata), o.ageDays ?? 0],
  );
  const r = await c.query(`select extract(epoch from ((now() at time zone 'UTC') - "createdAt"))::float8 age from "AuditLog" where id = $1`, [o.id]);
  return r.rows[0].age as number;
}

describe.skipIf(!P.present)(`SF-57 append-only AuditLog as ${P.role || "?"} (${P.isOwner ? "table owner" : "not the owner"})${P.present ? "" : ` — SKIPPED: ${P.reason}`}`, () => {
  it("catalogue: triggers enabled, purge is SECURITY DEFINER owned by the table owner with a pinned search_path; the app role has no UPDATE/DELETE/TRUNCATE and is not a member of the owner", async () => {
    await tx(async (c) => {
      const f = (await c.query(`select pg_get_userbyid(p.proowner) owner, p.prosecdef, array_to_string(p.proconfig, ';') cfg
                                  from pg_proc p where p.oid = 'public.audit_log_purge(integer)'::regprocedure`)).rows[0];
      expect(f.owner).toBe(P.owner);
      expect(f.prosecdef).toBe(true);
      expect(f.cfg).toContain("search_path=public, pg_temp");
      for (const fn of ["audit_log_append_only()", "audit_log_stamp_created_at()", "audit_log_no_truncate()", "audit_log_is_table_owner()"]) {
        const g = (await c.query(`select array_to_string(proconfig, ';') cfg, pg_get_userbyid(proowner) owner from pg_proc where oid = $1::regprocedure`, [`public.${fn}`])).rows[0];
        expect(g.cfg, fn).toContain("search_path=public, pg_temp");
        expect(g.owner, fn).toBe(P.owner);
      }
      if (P.appRoleExists) {
        const priv = (await c.query(`select has_table_privilege('matflow_app', '"AuditLog"', 'UPDATE') u, has_table_privilege('matflow_app', '"AuditLog"', 'DELETE') d,
            has_table_privilege('matflow_app', '"AuditLog"', 'TRUNCATE') t, has_table_privilege('matflow_app', '"AuditLog"', 'INSERT') i,
            has_table_privilege('matflow_app', '"AuditLog"', 'SELECT') s, has_function_privilege('matflow_app', 'public.audit_log_purge(integer)', 'EXECUTE') x,
            pg_has_role('matflow_app', $1, 'MEMBER') m`, [P.owner])).rows[0];
        expect(priv).toEqual({ u: false, d: false, t: false, i: true, s: true, x: true, m: false });
      }
    });
  });

  it("INSERT works; createdAt is the database clock for every role except the owner", async () => {
    await tx(async (c) => {
      const ageSeconds = await insertAudit(c, { id: `${STAMP}-ins`, ageDays: 400 });
      if (P.isOwner) expect(Math.abs(ageSeconds - 400 * DAY / 1000)).toBeLessThan(5);
      else expect(Math.abs(ageSeconds)).toBeLessThan(5);
    });
  });

  it("UPDATE of any column is refused for every role (owner included); only a userId/operatorId change to NULL passes", async () => {
    await tx(async (c) => {
      await insertAudit(c, { id: `${STAMP}-upd`, metadata: { a: 1 } });
      for (const set of [`action = 'secF2.rewritten'`, `"createdAt" = now() - interval '400 days'`, `metadata = '{"a":2}'::jsonb`,
        `"tenantId" = 'secF2-other'`, `"ipAddress" = '0.0.0.0'`, `"userId" = 'secF2-someone'`]) {
        await refused(c, `update "AuditLog" set ${set} where id = $1`, [`${STAMP}-upd`]);
      }
      // Nulling the actor columns: the trigger allows it (that is the FK SET NULL path, which runs as the table
      // owner); the runtime role has no UPDATE privilege at all, so it is refused there before the trigger.
      if (P.isOwner) {
        expect((await c.query(`update "AuditLog" set "userId" = null, "operatorId" = null where id = $1`, [`${STAMP}-upd`])).rowCount).toBe(1);
      } else {
        await refused(c, `update "AuditLog" set "userId" = null where id = $1`, [`${STAMP}-upd`]);
      }
    });
  });

  it("DELETE is refused unless the connecting role is the table owner", async () => {
    await tx(async (c) => {
      await insertAudit(c, { id: `${STAMP}-del` });
      if (P.isOwner) {
        expect((await c.query(`delete from "AuditLog" where id = $1`, [`${STAMP}-del`])).rowCount).toBe(1);
      } else {
        await refused(c, `delete from "AuditLog" where id = $1`, [`${STAMP}-del`]);
        expect((await c.query(`select count(*)::int n from "AuditLog" where id = $1`, [`${STAMP}-del`])).rows[0].n).toBe(1);
      }
    });
  });

  it("TRUNCATE is refused for every role", async () => {
    await tx(async (c) => {
      await c.query("SET LOCAL lock_timeout = '3s'");
      await refused(c, `truncate "AuditLog"`);
    });
  });

  it("DDL: only the owner can disable, replace or drop the triggers (the owner CAN — the boundary's documented limit)", async () => {
    await tx(async (c) => {
      await c.query("SET LOCAL lock_timeout = '3s'");
      const ddl = [
        `alter table "AuditLog" disable trigger "AuditLog_append_only"`,
        `drop trigger "AuditLog_append_only" on "AuditLog"`,
        `create or replace function audit_log_append_only() returns trigger language plpgsql as $$ begin return new; end $$`,
        `alter function audit_log_purge(integer) security invoker`,
      ];
      if (P.isOwner) {
        await c.query(ddl[0]); // succeeds — recorded limit, rolled back
      } else {
        for (const s of ddl) await refused(c, s);
      }
    });
  });

  it("foreign-key SET NULL from a deleted User still works and leaves every other column intact", async () => {
    await tx(async (c) => {
      await c.query(`insert into "Tenant"(id, name, slug) values ($1, 'SecF2 synthetic', $2)`, [STAMP, STAMP.toLowerCase()]);
      await c.query(`insert into "User"(id, "tenantId", email, "passwordHash", name, "updatedAt") values ($1, $2, $3, 'x', 'SecF2 User', now())`,
        [`${STAMP}-u`, STAMP, `${STAMP.toLowerCase()}@test.local`]);
      await insertAudit(c, { id: `${STAMP}-fk`, userId: `${STAMP}-u`, action: "secF2.fk" });
      expect((await c.query(`delete from "User" where id = $1`, [`${STAMP}-u`])).rowCount).toBe(1);
      const row = (await c.query(`select "userId", action from "AuditLog" where id = $1`, [`${STAMP}-fk`])).rows[0];
      expect(row).toEqual({ userId: null, action: "secF2.fk" });
    });
  });

  it("audit_log_purge refuses an out-of-range batch (0, 5001, NULL)", async () => {
    await tx(async (c) => {
      for (const b of [0, 5001, null]) await refused(c, `select audit_log_purge($1)`, [b], "22023");
    });
  });

  it("audit_log_purge works for the calling role, never deletes a fresh row and does not leak the RLS bypass flag", async () => {
    await tx(async (c) => {
      await insertAudit(c, { id: `${STAMP}-fresh` });
      for (let i = 0; i < 50; i += 1) {
        const n = (await c.query(`select audit_log_purge(5000) n`)).rows[0].n as number;
        if (n < 5000) break;
      }
      expect((await c.query(`select count(*)::int n from "AuditLog" where id = $1`, [`${STAMP}-fresh`])).rows[0].n).toBe(1);
      expect((await c.query(`select coalesce(current_setting('app.bypass_rls', true), '') v`)).rows[0].v).not.toBe("on");
    });
  });

  it.runIf(P.isOwner)("purge minimums: 365 days ordinary; 2190 days for admin.*, member.dsar_erase* and actingAs rows", async () => {
    await tx(async (c) => {
      const rows: Array<[string, string, number, unknown, boolean]> = [
        ["ord-364", "secF2.ordinary", 364, null, true],
        ["ord-366", "secF2.ordinary", 366, null, false],
        ["admin-366", "admin.secF2", 366, null, true],
        ["dsar-366", "member.dsar_erase_secF2", 366, null, true],
        ["acting-366", "secF2.ordinary", 366, { actingAs: "secF2-op" }, true],
        ["acting-null-366", "secF2.ordinary", 366, { actingAs: null }, true],
        ["likewild-366", "member.dsarXerase", 366, null, false],
        ["admin-2191", "admin.secF2", 2191, null, false],
        ["acting-2191", "secF2.ordinary", 2191, { actingAs: "secF2-op" }, false],
      ];
      for (const [id, action, days, metadata] of rows) await insertAudit(c, { id: `${STAMP}-${id}`, action, ageDays: days, metadata: metadata ?? undefined });
      for (let i = 0; i < 50; i += 1) {
        const n = (await c.query(`select audit_log_purge(5000) n`)).rows[0].n as number;
        if (n < 5000) break;
      }
      const left = new Set((await c.query(`select id from "AuditLog" where id like $1`, [`${STAMP}-%`])).rows.map((r) => r.id as string));
      for (const [id, , , , keep] of rows) expect(left.has(`${STAMP}-${id}`), id).toBe(keep);
    });
  });
});

afterAll(async () => {
  if (client) {
    // Count-checked teardown: every cell rolled back, so nothing carrying this run's prefix may remain.
    await client.query("BEGIN");
    if (SET_ROLE) await client.query(`SET LOCAL ROLE ${ident(SET_ROLE)}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [STAMP]);
    const left = (await client.query(`select (select count(*)::int from "AuditLog" where id like $1) a, (select count(*)::int from "Tenant" where id = $2) t`, [`${STAMP}%`, STAMP])).rows[0];
    await client.query("ROLLBACK");
    await client.end();
    expect(left).toEqual({ a: 0, t: 0 });
  }
});
