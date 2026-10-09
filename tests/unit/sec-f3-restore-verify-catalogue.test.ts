import { describe, it, expect } from "vitest";
import { compareFingerprints, CATALOGUE_SECTIONS } from "../../scripts/readiness/restore-verify.mjs";

/**
 * Lane F3 (iteration 2, SF-96 / review R3-5). Review R3 planted seven tamper classes into an isolated restore that
 * the SF-64 fingerprint passed. Each cell below plants one of them into a synthetic fingerprint carrying the F3
 * catalogue sections (shaped as takeFingerprint writes them); the identical pair is the positive control. The same
 * tampers were re-run for real against an isolated PGlite restore (docs/security/evidence/F3/tamper-*.log).
 */
function base() {
  return {
    pgMajor: 17,
    role: "neondb_owner",
    migrations: ["m1"],
    migrationChecksums: { m1: "a" },
    tables: {
      AuditLog: { rows: 3, rls: true, force: true, owner: "neondb_owner", acl: "{matflow_app=arwd/neondb_owner}", policies: "p", triggers: "", contentMd5: "c1" },
      User: { rows: 2, rls: true, force: true, owner: "neondb_owner", acl: "{matflow_app=arwd/neondb_owner}", policies: "p", triggers: "", contentMd5: "c2" },
    },
    functions: { "matflow_lowercase_email()": { owner: "neondb_owner", secdef: false, config: "", lang: "plpgsql", acl: "", srcMd5: "f1" } } as Record<string, unknown>,
    roles: { matflow_app: { rolsuper: false, rolbypassrls: false }, neondb_owner: { rolsuper: false, rolbypassrls: true } },
    schemaPublic: { owner: "pg_database_owner", acl: "x" },
    extensions: ["plpgsql@1.0"],
    eventTriggers: [] as string[],
    foreignKeys: {},
    securityState: { magicLinkOutstanding: 0, passwordResetOutstanding: 0, userSessionVersionSum: 1, memberSessionVersionSum: 1, operatorSessionVersionSum: 1, operators: 1, latestAuditAt: "2026-10-09T10:00:00.000Z" },
    // F3 sections
    roleSettings: {} as Record<string, string[]>,
    database: { owner: "neondb_owner", acl: "PUBLIC=CONNECT/neondb_owner,PUBLIC=TEMPORARY/neondb_owner,neondb_owner=CONNECT/neondb_owner" },
    schemas: { public: { owner: "pg_database_owner", acl: "x" } } as Record<string, { owner: string; acl: string }>,
    relations: { "public.v_ok": { kind: "v", owner: "neondb_owner", acl: "", options: "", rls: false, force: false, defMd5: "v1" } } as Record<string, Record<string, unknown>>,
    rules: {} as Record<string, string>,
    columnPrivileges: {} as Record<string, string>,
    defaultPrivileges: { "neondb_owner|public|r": "matflow_app=DELETE/neondb_owner,matflow_app=INSERT/neondb_owner" } as Record<string, string>,
  };
}
type FP = ReturnType<typeof base>;
const tamper = (fn: (f: FP) => void) => { const f = base(); fn(f); return f; };
const run = (b: unknown) => compareFingerprints(base(), b) as { verdict: string; fails: string[] };

describe("restore-verify catalogue sections (SF-96)", () => {
  it("positive control: identical fingerprints with every section pass", () => {
    expect(run(base())).toMatchObject({ verdict: "PASS", fails: [] });
  });

  it("names the seven sections it compares", () => {
    expect(Object.keys(CATALOGUE_SECTIONS).sort()).toEqual(
      ["columnPrivileges", "database", "defaultPrivileges", "relations", "roleSettings", "rules", "schemas"],
    );
  });

  it.each([
    ["ALTER ROLE matflow_app SET app.bypass_rls = on", (f: FP) => { f.roleSettings["matflow_app @ ALL DATABASES"] = ["app.bypass_rls=4a5b2c"]; }, /unexpected role\/database setting in restored copy: matflow_app @ ALL DATABASES/],
    ["ALTER DATABASE … SET app.bypass_rls = on", (f: FP) => { f.roleSettings["<ALL ROLES> @ THIS DATABASE"] = ["app.bypass_rls=4a5b2c"]; }, /role\/database setting in restored copy: <ALL ROLES> @ THIS DATABASE/],
    ["a role setting's VALUE changed (row_security on -> off)", (f: FP) => { f.roleSettings = { "matflow_app @ ALL DATABASES": ["row_security=aaaa"] }; }, /role\/database setting/],
    ["rewrite rule on AuditLog (DO INSTEAD NOTHING)", (f: FP) => { f.rules["public.AuditLog.zz_drop"] = "enabled=O|d1"; }, /unexpected rewrite rule in restored copy: public.AuditLog.zz_drop/],
    ["column grant UPDATE (action) on AuditLog", (f: FP) => { f.columnPrivileges["public.AuditLog.action"] = "matflow_app=UPDATE/neondb_owner"; }, /unexpected column grant in restored copy: public.AuditLog.action/],
    ["ALTER DEFAULT PRIVILEGES widened", (f: FP) => { f.defaultPrivileges["neondb_owner|public|r"] += ",matflow_app=TRUNCATE/neondb_owner"; }, /default privileges changed: neondb_owner\|public\|r/],
    ["ALTER DEFAULT PRIVILEGES removed", (f: FP) => { f.defaultPrivileges = {}; }, /default privileges missing in restored copy/],
    ["owner-created view over User granted to the runtime role", (f: FP) => { f.relations["public.zz_view"] = { kind: "v", owner: "neondb_owner", acl: "matflow_app=SELECT/neondb_owner", options: "", rls: false, force: false, defMd5: "v1" }; }, /unexpected relation in restored copy: public.zz_view/],
    ["view definition changed under the same name", (f: FP) => { f.relations["public.v_ok"].defMd5 = "v2"; }, /relation changed: public.v_ok/],
    ["sequence ACL", (f: FP) => { f.relations["public.s"] = { kind: "S", owner: "neondb_owner", acl: "matflow_app=USAGE/neondb_owner", options: "", rls: false, force: false, defMd5: "" }; }, /unexpected relation in restored copy: public.s/],
    ["new schema", (f: FP) => { f.schemas.zz = { owner: "neondb_owner", acl: "" }; }, /unexpected schema in restored copy: zz/],
    ["function in another schema", (f: FP) => { f.functions["zz.btrim(text)"] = { owner: "neondb_owner", secdef: false, config: "", lang: "sql", acl: "", srcMd5: "z" }; }, /unexpected function in restored copy: zz.btrim\(text\)/],
    ["role search_path pointed at the shadow schema", (f: FP) => { f.roleSettings["matflow_app @ ALL DATABASES"] = ["search_path=0b1c"]; }, /role\/database setting/],
    ["database ACL widened (CREATE to the runtime role)", (f: FP) => { f.database.acl += ",matflow_app=CREATE/neondb_owner"; }, /database changed: acl/],
  ])("FAILS: %s", (_name, fn, pattern) => {
    const r = run(tamper(fn));
    expect(r.verdict).toBe("FAIL");
    expect(r.fails.join("\n")).toMatch(pattern);
  });

  it("FAILS when the baseline has the sections and the restored fingerprint does not (or the reverse)", () => {
    for (const k of Object.keys(CATALOGUE_SECTIONS)) {
      const b = base() as Record<string, unknown>;
      delete b[k];
      const r = run(b);
      expect(r.verdict).toBe("FAIL");
      expect(r.fails.join("\n")).toContain(`${k} recorded on one side only`);
      const r2 = compareFingerprints(b, base()) as { verdict: string };
      expect(r2.verdict).toBe("FAIL");
    }
  });
});
