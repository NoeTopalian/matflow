import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareFingerprints, refuseConnectionEnv } from "../../scripts/readiness/restore-verify.mjs";

/**
 * Lane F2 (iteration 2, SF-64). The iteration-1 comparison missed tampers that keep row counts and only PRINTED a
 * rewound security state. Each cell plants one difference into a synthetic fingerprint; the identical pair is the
 * positive control. The same tampers were applied for real to an isolated restore (evidence/F2/
 * restore-tamper-controls.mjs, 10/10 as expected).
 */
function base() {
  return {
    pgMajor: 17,
    role: "neondb_owner",
    migrations: ["m1", "m2"],
    migrationChecksums: { m1: "a", m2: "b" },
    tables: {
      AuditLog: { rows: 3, rls: true, force: true, owner: "neondb_owner", acl: "{matflow_app=arwd/neondb_owner}", policies: "tenant_isolation|ALL|PERMISSIVE|{public}|USING(x)|CHECK()", triggers: "", contentMd5: "c1" },
      User: { rows: 2, rls: true, force: true, owner: "neondb_owner", acl: "{matflow_app=arwd/neondb_owner}", policies: "p", triggers: "User_email_lowercase|enabled=O|def", contentMd5: "c2" },
      Member: { rows: 1, rls: true, force: true, owner: "neondb_owner", acl: "", policies: "p", triggers: "", contentMd5: "c3" },
      Operator: { rows: 1, rls: true, force: true, owner: "neondb_owner", acl: "", policies: "p", triggers: "", contentMd5: "c4" },
      MagicLinkToken: { rows: 0, rls: true, force: true, owner: "neondb_owner", acl: "", policies: "p", triggers: "", contentMd5: "c5" },
      PasswordResetToken: { rows: 0, rls: true, force: true, owner: "neondb_owner", acl: "", policies: "p", triggers: "", contentMd5: "c6" },
    },
    functions: { "matflow_lowercase_email()": { owner: "neondb_owner", secdef: false, config: "", lang: "plpgsql", acl: "", srcMd5: "f1" } },
    roles: { matflow_app: { rolsuper: false, rolbypassrls: false }, neondb_owner: { rolsuper: false, rolbypassrls: true } },
    schemaPublic: { owner: "pg_database_owner", acl: "x" },
    extensions: ["plpgsql@1.0"],
    eventTriggers: [] as string[],
    foreignKeys: { fk1: { child: "User", parent: "Tenant", validated: true, orphans: 0 } },
    securityState: { magicLinkOutstanding: 0, passwordResetOutstanding: 0, userSessionVersionSum: 10, memberSessionVersionSum: 5, operatorSessionVersionSum: 1, operators: 1, latestAuditAt: "2026-10-09T10:00:00.000Z" },
  };
}
type FP = ReturnType<typeof base>;
const tamper = (fn: (f: FP) => void) => { const f = base(); fn(f); return f; };
const verdict = (b: FP, opts = {}) => compareFingerprints(base(), b, opts) as { verdict: string; fails: string[] };

describe("compareFingerprints (SF-64)", () => {
  it("positive control: identical fingerprints pass", () => {
    expect(verdict(base())).toMatchObject({ verdict: "PASS", fails: [] });
  });
  it.each([
    ["policy expression changed under the same name", (f: FP) => { f.tables.AuditLog.policies = "tenant_isolation|ALL|PERMISSIVE|{public}|USING(true)|CHECK()"; }, /policies changed on AuditLog/],
    ["trigger disabled", (f: FP) => { f.tables.User.triggers = "User_email_lowercase|enabled=D|def"; }, /triggers changed on User/],
    ["function body replaced under the same name", (f: FP) => { f.functions["matflow_lowercase_email()"].srcMd5 = "f2"; }, /function changed/],
    ["BYPASSRLS granted to the app role", (f: FP) => { f.roles.matflow_app.rolbypassrls = true; }, /role changed: matflow_app/],
    ["extra table grant", (f: FP) => { f.tables.AuditLog.acl = "{matflow_app=arwdD/neondb_owner}"; }, /grants changed on AuditLog/],
    ["owner changed", (f: FP) => { f.tables.User.owner = "someone"; }, /owner changed on User/],
    ["row content rewritten with the count kept", (f: FP) => { f.tables.AuditLog.contentMd5 = "zz"; }, /content of AuditLog differs/],
    ["migration checksum differs", (f: FP) => { f.migrationChecksums.m2 = "x"; }, /migration checksum differs: m2/],
    ["security state rewound", (f: FP) => { f.securityState.userSessionVersionSum = 9; }, /security state differs: userSessionVersionSum/],
    ["outstanding link re-opened", (f: FP) => { f.securityState.magicLinkOutstanding = 1; }, /security state differs: magicLinkOutstanding/],
    ["event trigger planted", (f: FP) => { f.eventTriggers = ["evil|ddl_command_end|O"]; }, /event triggers differ/],
  ])("FAILS: %s", (_n, fn, re) => {
    const r = verdict(tamper(fn));
    expect(r.verdict).toBe("FAIL");
    expect(r.fails.join("\n")).toMatch(re);
  });
  it("--expect-revoked passes only when every session was bumped and nothing is outstanding", () => {
    const revoked = tamper((f) => {
      f.securityState.userSessionVersionSum = 12; f.securityState.memberSessionVersionSum = 6; f.securityState.operatorSessionVersionSum = 2;
      f.tables.User.contentMd5 = "n1"; f.tables.AuditLog.rows = 4; f.tables.AuditLog.contentMd5 = "n2";
    });
    expect(verdict(revoked, { expectRevoked: true }).verdict).toBe("PASS");
    const partial = tamper((f) => { f.securityState.userSessionVersionSum = 11; f.securityState.memberSessionVersionSum = 6; f.securityState.operatorSessionVersionSum = 2; });
    expect(verdict(partial, { expectRevoked: true }).fails.join()).toMatch(/userSessionVersionSum 11 < baseline 10 \+ 2 rows/);
    const open = tamper((f) => { f.securityState.userSessionVersionSum = 12; f.securityState.memberSessionVersionSum = 6; f.securityState.operatorSessionVersionSum = 2; f.securityState.passwordResetOutstanding = 1; });
    expect(verdict(open, { expectRevoked: true }).fails.join()).toMatch(/reset codes still outstanding/);
    // A table outside the revocation's own set may not change even in that mode.
    const other = tamper((f) => { f.securityState.userSessionVersionSum = 12; f.securityState.memberSessionVersionSum = 6; f.securityState.operatorSessionVersionSum = 2; f.functions["matflow_lowercase_email()"].srcMd5 = "q"; });
    expect(verdict(other, { expectRevoked: true }).verdict).toBe("FAIL");
  });
});

describe("connection guards of the F2 scripts (refused before any connection)", () => {
  it("PGOPTIONS / PGHOST / PGHOSTADDR in the environment are refused (pg would apply PGOPTIONS to a TEST URL)", () => {
    expect(() => refuseConnectionEnv({ PGOPTIONS: "endpoint=ep-bold-wave-abt39t7x" })).toThrow(/PGOPTIONS/);
    expect(() => refuseConnectionEnv({ PGHOST: "x" })).toThrow(/PGHOST/);
    expect(() => refuseConnectionEnv({})).not.toThrow();
  });
  const run = (script: string, args: string[], env: Record<string, string> = {}) => {
    try {
      return { code: 0, out: execFileSync("node", [script, ...args], { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      return { code: err.status ?? 1, out: String(err.stderr ?? "") };
    }
  };
  const envFile = (url: string) => { const d = mkdtempSync(join(tmpdir(), "f2-guard-")); const p = join(d, ".env.x"); writeFileSync(p, `X_URL=${url}\n`); return { p, d }; };
  const PROD = "postgresql://u:p@ep-bold-wave-abt39t7x-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";
  const TEST = "postgresql://u:p@ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";
  it("backup-export refuses production with no override, and an output directory inside the repository", () => {
    const { p, d } = envFile(PROD);
    expect(run("scripts/readiness/backup-export.mjs", [p, "ep-", "X_URL", join(d, "out")])).toMatchObject({ code: 2, out: expect.stringMatching(/production/) });
    const t = envFile(TEST);
    expect(run("scripts/readiness/backup-export.mjs", [t.p, "ep-hidden-salad", "X_URL", "docs/should-not-exist"])).toMatchObject({ code: 2, out: expect.stringMatching(/inside the repository/) });
    expect(run("scripts/readiness/backup-export.mjs", [t.p, "ep-hidden-salad", "X_URL", join(t.d, "out")], { PGOPTIONS: "endpoint=ep-bold-wave-abt39t7x" })).toMatchObject({ code: 2, out: expect.stringMatching(/PGOPTIONS/) });
  });
  it("backup-post-restore refuses production and the shared TEST branch", () => {
    const prod = envFile(PROD);
    expect(run("scripts/readiness/backup-post-restore.mjs", [prod.p, "ep-", "X_URL", "inventory"]).code).toBe(2);
    const test = envFile(TEST);
    expect(run("scripts/readiness/backup-post-restore.mjs", [test.p, "ep-hidden-salad", "X_URL", "revoke", "--i-confirm-this-is-a-restored-copy"])).toMatchObject({ code: 2, out: expect.stringMatching(/shared TEST branch/) });
  });
});
