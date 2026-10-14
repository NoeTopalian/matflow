// scripts/readiness/owner-login-change-check.mjs (admin hub lane E, 9 Oct 2026;
// ledger AH-06). The repaired replacement for the scratch sean-state.mjs, which
// printed PASS/FAIL lines and exited 0 whatever they said, compared counts
// instead of ids, matched audit rows by "%login_email%", scanned for "@" as its
// PII proof, and counted users holding the target across every club.
//
// Drives the real script with an injected fake pg client (no database): every
// named check's FAIL path, the exit codes, the read-only transaction, the
// refusals (host guard, private paths inside the repository, addresses on the
// command line) and that nothing secret reaches stdout/stderr or the baseline.
// The real-database proof run is in the lane E report (TEST branch only).

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import * as script from "../../scripts/readiness/owner-login-change-check.mjs";

const { main, endpointIdOf, REPO_ROOT } = script as unknown as {
  main: (argv: string[], deps: Record<string, unknown>) => Promise<number>;
  endpointIdOf: (u: string) => string | null;
  REPO_ROOT: string;
};

const EP = "ep-fixture-salad-abc123";
const URL_OK = `postgresql://fixture:fixture@${EP}-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require`;
const TENANT = { id: "tenant_fixture_lanee_1", slug: "lanee-fixture-club" };
const OWNER_ID = "user_fixture_lanee_owner";
const MEMBER_ID = "member_fixture_lanee_1";
const OPERATOR_ID = "operator_fixture_lanee";
const ADDR = {
  ownerOriginalEmail: "owner-old@fixture.invalid",
  ownerTargetEmail: "owner-target@fixture.invalid",
  memberOriginalEmail: "owner-target@fixture.invalid",
  memberTargetEmail: "member-new@fixture.invalid",
};
const SECRET = "s".repeat(16) + randomBytes(16).toString("hex");
const PASSWORD_HASH = "$2a$12$fixturefixturefixturefixtureHASH";
const TOTP_SECRET = "ABCDEFABCDEFABCDEFABCDEF";
// The audit digests the routes write are KEYED (lib/login-email.ts emailDigest,
// AH-E2): the fake env file carries the key, and the fixtures use the script's
// own construction (parity with the library is pinned in a separate case).
const DIGEST_KEY = "unit-test-auth-secret-0123456789";
const sha = (s: string) => script.routeEmailDigest(s, DIGEST_KEY);

const ALL_COLUMNS: Record<string, string[]> = {
  Tenant: ["id", "slug"],
  User: ["id", "tenantId", "role", "email", "passwordHash", "totpSecret", "totpEnabled", "totpRecoveryCodes", "mustChangePassword", "sessionVersion", "lockedUntil", "loginEmailProvisionalSince"],
  Member: ["id", "tenantId", "email", "status", "externalRef", "passwordHash", "totpSecret", "totpEnabled", "sessionVersion", "parentMemberId", "guardianConfirmedAt"],
  PasswordHistory: ["id", "userId"],
  ImportedMembership: ["id", "tenantId", "memberId", "importJobId", "sourceRow", "sourceFingerprint", "planLabel", "type", "status", "entitlement", "disposition"],
  AttendanceRecord: ["id", "tenantId", "memberId"],
  PasswordResetToken: ["id", "tenantId", "email", "used", "expiresAt"],
  MagicLinkToken: ["id", "tenantId", "email", "used", "expiresAt", "purpose"],
  AuditLog: ["id", "tenantId", "userId", "action", "entityType", "entityId", "metadata", "createdAt", "operatorId", "requestId"],
};

type AuditRow = {
  id: string; tenantId: string; action: string; entityType: string; entityId: string; userId: string | null;
  createdAt: Date; metadata: Record<string, unknown> | null; operatorId: string | null; requestId: string | null;
};

function freshState() {
  return {
    now: new Date("2026-10-09T10:00:00Z"),
    columns: JSON.parse(JSON.stringify(ALL_COLUMNS)) as Record<string, string[]>,
    tenant: { ...TENANT },
    user: {
      id: OWNER_ID, tenantId: TENANT.id, role: "owner", email: ADDR.ownerOriginalEmail, passwordHash: PASSWORD_HASH,
      totpSecret: TOTP_SECRET, totpEnabled: true, totpRecoveryCodes: ["h1", "h2", "h3"], mustChangePassword: false,
      sessionVersion: 4, lockedUntil: null as Date | null, loginEmailProvisionalSince: new Date("2026-10-07T09:00:00Z") as Date | null,
    } as Record<string, unknown> | null,
    history: [{ id: "ph_1" }, { id: "ph_2" }],
    member: {
      id: MEMBER_ID, tenantId: TENANT.id, email: ADDR.memberOriginalEmail, status: "active", externalRef: "teamup-12345",
      passwordHash: null, totpSecret: null, totpEnabled: false, sessionVersion: 0, parentMemberId: null, guardianConfirmedAt: null,
    } as Record<string, unknown> | null,
    memberships: [
      { id: "im_1", importJobId: "job_1", sourceRow: 3, sourceFingerprint: "fp3", planLabel: "Adult", type: "plan", status: "active", entitlement: "current", disposition: "member_history" },
    ] as Record<string, unknown>[],
    attendance: [{ id: "ar_1" }, { id: "ar_2" }],
    children: [{ id: "child_1" }],
    otherUsers: [] as { id: string; email: string; tenantId?: string }[],
    otherMembers: [] as { id: string; email: string; tenantId?: string }[],
    resets: 0,
    links: [] as { purpose: string; n: number }[],
    audit: [
      { id: "al_old_1", tenantId: TENANT.id, action: "admin.owner.login_email.marked_provisional", entityType: "User", entityId: OWNER_ID, userId: OWNER_ID, createdAt: new Date("2026-10-07T09:00:00Z"), metadata: { emailSha256: sha(ADDR.ownerOriginalEmail) }, operatorId: OPERATOR_ID, requestId: "req_old_1" },
    ] as AuditRow[],
    sql: [] as string[],
    failOn: null as RegExp | null,
  };
}
type State = ReturnType<typeof freshState>;

function fakeClient(s: State) {
  const colsOn = () => s.columns.AuditLog.includes("operatorId") && s.columns.AuditLog.includes("requestId");
  return {
    ended: false,
    async end() { this.ended = true; },
    async query(text: string, params: unknown[] = []) {
      s.sql.push(text);
      if (s.failOn && s.failOn.test(text)) throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      const t = text.replace(/\s+/g, " ");
      const rows = (r: unknown[]) => ({ rows: r });
      if (/^BEGIN|^ROLLBACK|^SET LOCAL/.test(t)) return rows([]);
      if (/as "now"/.test(t)) return rows([{ now: s.now.toISOString() }]);
      if (/information_schema\.columns/.test(t)) {
        return rows(Object.entries(s.columns).flatMap(([table_name, cs]) => cs.map((column_name) => ({ table_name, column_name }))));
      }
      if (/set_config/.test(t)) return rows([]);
      if (/from "Tenant"/.test(t)) return rows(s.tenant && s.tenant.slug === params[0] ? [s.tenant] : []);
      if (/from "User" where id = \$1/.test(t)) return rows(s.user && s.user.id === params[0] && s.user.tenantId === params[1] ? [{ ...s.user }] : []);
      if (/from "PasswordHistory"/.test(t)) return rows(s.history);
      if (/from "Member" where id = \$1/.test(t)) return rows(s.member && s.member.id === params[0] && s.member.tenantId === params[1] ? [{ ...s.member }] : []);
      if (/from "ImportedMembership"/.test(t)) return rows(s.memberships);
      if (/from "AttendanceRecord"/.test(t)) return rows(s.attendance);
      if (/from "Member" where "parentMemberId"/.test(t)) return rows(s.children);
      // Holder lookups honour the tenant filter only when the SQL carries it, so
      // an unscoped query (the old script's cross-club count) is caught.
      const scoped = /"tenantId" = \$1/.test(t);
      if (/from "User" where .*lower\(email\)/.test(t)) {
        const all = [...(s.user ? [{ id: s.user.id as string, email: s.user.email as string, tenantId: TENANT.id }] : []), ...s.otherUsers];
        return rows(all.filter((u) => u.email.toLowerCase() === params[1] && (!scoped || (u.tenantId ?? TENANT.id) === params[0])).map((u) => ({ id: u.id })));
      }
      if (/from "Member" where .*lower\(email\)/.test(t)) {
        const all = [...(s.member ? [{ id: s.member.id as string, email: s.member.email as string, tenantId: TENANT.id }] : []), ...s.otherMembers];
        return rows(all.filter((m) => m.email.toLowerCase() === params[1] && (!scoped || (m.tenantId ?? TENANT.id) === params[0])).map((m) => ({ id: m.id })));
      }
      if (/from "PasswordResetToken"/.test(t)) return rows([{ n: s.resets }]);
      if (/from "MagicLinkToken"/.test(t)) return rows(s.links);
      if (/from "AuditLog" where "tenantId" = \$1 and "entityId"/.test(t)) {
        const ids = params[1] as string[];
        return rows(
          s.audit
            .filter((r) => r.tenantId === params[0] && ids.includes(r.entityId))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .map((r) => {
              const base = { id: r.id, action: r.action, entityType: r.entityType, entityId: r.entityId, userId: r.userId, createdAt: r.createdAt, metadata: r.metadata };
              return /"requestId"/.test(t) ? { ...base, operatorId: r.operatorId, requestId: r.requestId } : base;
            }),
        );
      }
      if (/count\(\*\)::int as n from "AuditLog"/.test(t)) {
        const viaCol = /"requestId" = \$3/.test(t);
        if (viaCol && !colsOn()) throw new Error("column does not exist");
        const n = s.audit.filter((r) => r.tenantId === params[0] && r.action === params[1] &&
          (viaCol ? r.requestId === params[2] : (r.metadata as Record<string, unknown> | null)?.requestId === params[2])).length;
        return rows([{ n }]);
      }
      throw new Error(`fake client: unexpected SQL ${t.slice(0, 80)}`);
    },
  };
}

let tmp: string;
let privFile: string;
let state: State;
let outs: string[];
let errs: string[];
let connects: number;

function deps(extra: Record<string, unknown> = {}) {
  return {
    connect: async () => { connects++; return fakeClient(state); },
    readEnv: async () => ({ DATABASE_URL: URL_OK, AUTH_SECRET: DIGEST_KEY }),
    stdout: (s: string) => outs.push(s),
    stderr: (s: string) => errs.push(s),
    ...extra,
  };
}

function args(mode: "baseline" | "verify", extra: string[] = []) {
  return [
    mode, "--tenant", TENANT.slug, "--owner-id", OWNER_ID, "--member-id", MEMBER_ID,
    "--expect-email-file", privFile, "--expect-host", EP, "--baseline-dir", path.join(tmp, "baselines"), ...extra,
  ];
}
const verifyArgs = (extra: string[] = []) => args("verify", ["--path", "operator", "--operator-id", OPERATOR_ID, ...extra]);
const summary = () => JSON.parse(outs[outs.length - 1]);
const statusOf = (name: string) => summary().checks.find((c: { name: string }) => c.name === name)?.status;

/** The change exactly as the operator routes leave it: member contact step, then owner change. */
function applyGoodOperatorChange(s: State) {
  s.now = new Date("2026-10-09T11:00:00Z");
  s.member!.email = ADDR.memberTargetEmail;
  s.audit.push({
    id: "al_new_member", tenantId: TENANT.id, action: "admin.member.contact_email.changed", entityType: "Member", entityId: MEMBER_ID,
    userId: null, createdAt: new Date("2026-10-09T10:30:00Z"), metadata: { oldEmailDigest: "k1", newEmailDigest: "k2", requestId: "req_member_1", actingAs: OPERATOR_ID },
    operatorId: OPERATOR_ID, requestId: "req_member_1",
  });
  s.user!.email = ADDR.ownerTargetEmail;
  s.user!.loginEmailProvisionalSince = new Date("2026-10-09T10:40:00Z");
  s.user!.sessionVersion = (s.user!.sessionVersion as number) + 1;
  s.audit.push({
    id: "al_new_owner", tenantId: TENANT.id, action: "admin.owner.login_email.changed", entityType: "User", entityId: OWNER_ID,
    userId: OWNER_ID, createdAt: new Date("2026-10-09T10:40:00Z"),
    metadata: { reason: "verified by phone call-back @ 10:00 on the number on file", oldEmailSha256: sha(ADDR.ownerOriginalEmail), newEmailSha256: sha(ADDR.ownerTargetEmail), requestId: "req_owner_1", actingAs: OPERATOR_ID },
    operatorId: OPERATOR_ID, requestId: "req_owner_1",
  });
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lanee-olc-"));
  privFile = path.join(tmp, "private.json");
  fs.writeFileSync(privFile, JSON.stringify({ runSecret: SECRET, ...ADDR }));
  state = freshState();
  outs = [];
  errs = [];
  connects = 0;
});

async function baselineThenGoodChange() {
  expect(await main(args("baseline"), deps())).toBe(0);
  applyGoodOperatorChange(state);
  outs = [];
  errs = [];
}

describe("owner-login-change-check: happy path and discipline", () => {
  it("baseline writes a keyed, address-free record outside the repo; verify passes every check after a correct change", async () => {
    expect(await main(args("baseline"), deps())).toBe(0);
    const files = fs.readdirSync(path.join(tmp, "baselines"));
    expect(files).toHaveLength(1);
    const written = fs.readFileSync(path.join(tmp, "baselines", files[0]), "utf8");
    for (const v of [...Object.values(ADDR), SECRET, PASSWORD_HASH, TOTP_SECRET, "teamup-12345"]) expect(written).not.toContain(v);

    applyGoodOperatorChange(state);
    outs = [];
    errs = [];
    expect(await main(verifyArgs(), deps())).toBe(0);
    const s = summary();
    expect(s.result).toBe("PASS");
    expect(s.auditPath).toBe("columns");
    expect(s.checks.length).toBeGreaterThanOrEqual(35);
    expect(s.checks.every((c: { status: string }) => c.status === "PASS")).toBe(true);
    const printed = outs.join("\n") + errs.join("\n");
    for (const v of [...Object.values(ADDR), SECRET, PASSWORD_HASH, TOTP_SECRET]) expect(printed).not.toContain(v);
  });

  it("the same address held in ANOTHER club is legitimate and does not fail the tenant-scoped identity checks", async () => {
    await baselineThenGoodChange();
    state.otherUsers = [{ id: "user_elsewhere", email: ADDR.ownerTargetEmail, tenantId: "tenant_other_club" }];
    state.otherMembers = [{ id: "member_elsewhere", email: ADDR.ownerTargetEmail, tenantId: "tenant_other_club" }];
    expect(await main(verifyArgs(), deps())).toBe(0);
  });

  it("an \"@\" in audit metadata that is not one of the private addresses is not a PII failure (no \"@\" scan)", async () => {
    await baselineThenGoodChange();
    expect(await main(verifyArgs(), deps())).toBe(0);
    expect(statusOf("audit.metadata_has_no_raw_address")).toBe("PASS");
  });

  it("reads in ONE repeatable-read, read-only transaction with a statement timeout, writes nothing and rolls back", async () => {
    await baselineThenGoodChange();
    state.sql = [];
    await main(verifyArgs(), deps());
    expect(state.sql[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(state.sql[1]).toMatch(/SET LOCAL statement_timeout/);
    expect(state.sql[state.sql.length - 1]).toBe("ROLLBACK");
    expect(state.sql.filter((q) => /^\s*BEGIN/i.test(q))).toHaveLength(1);
    for (const q of state.sql) expect(q).not.toMatch(/\b(insert|update|delete|truncate|alter|drop)\b/i);
    for (const q of state.sql) expect(q).not.toMatch(/select \*|u\.\*/i);
  });

  it("every timestamp leaves the database as UTC text (Prisma TIMESTAMP(3) holds UTC; pg would parse it as local time)", async () => {
    await baselineThenGoodChange();
    state.sql = [];
    await main(verifyArgs(), deps());
    const all = state.sql.join(" ;; ");
    for (const col of ['"createdAt"', '"lockedUntil"', '"loginEmailProvisionalSince"', '"guardianConfirmedAt"', "(now() at time zone 'UTC')"]) {
      expect(all).toContain(`to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
    }
    expect(all).not.toMatch(/"expiresAt" > now\(\)/);
    expect(all).toMatch(/"expiresAt" > \(now\(\) at time zone 'UTC'\)/);
  });

  it("falls back to metadata.requestId / actingAs when the AuditLog columns are absent, and says so", async () => {
    state.columns.AuditLog = state.columns.AuditLog.filter((c) => c !== "operatorId" && c !== "requestId");
    await baselineThenGoodChange();
    expect(await main(verifyArgs(), deps())).toBe(0);
    expect(summary().auditPath).toBe("metadata-fallback");
  });

  it("self-service path: user.login_email.changed with no operator passes; an operator on it fails", async () => {
    expect(await main(args("baseline", ["--no-member"]).filter((a, i, arr) => !(a === "--member-id" || arr[i - 1] === "--member-id")), deps())).toBe(0);
    state.now = new Date("2026-10-09T11:00:00Z");
    state.user!.email = ADDR.ownerTargetEmail;
    state.member!.email = "someone-else@fixture.invalid";
    state.user!.loginEmailProvisionalSince = new Date("2026-10-09T10:40:00Z");
    state.user!.sessionVersion = 5;
    state.audit.push({
      id: "al_self", tenantId: TENANT.id, action: "user.login_email.changed", entityType: "User", entityId: OWNER_ID, userId: OWNER_ID,
      createdAt: new Date("2026-10-09T10:40:00Z"),
      metadata: { oldEmailSha256: sha(ADDR.ownerOriginalEmail), newEmailSha256: sha(ADDR.ownerTargetEmail), requestId: "uuid-1" },
      operatorId: null, requestId: "uuid-1",
    });
    const selfArgs = ["verify", "--tenant", TENANT.slug, "--owner-id", OWNER_ID, "--no-member", "--expect-email-file", privFile, "--expect-host", EP, "--baseline-dir", path.join(tmp, "baselines"), "--path", "self-service"];
    outs = [];
    expect(await main(selfArgs, deps())).toBe(0);
    expect(statusOf("owner.provisional_self-service")).toBe("PASS");
    state.audit[state.audit.length - 1].operatorId = OPERATOR_ID;
    outs = [];
    expect(await main(selfArgs, deps())).toBe(1);
    expect(statusOf("audit.owner_row_self_actor")).toBe("FAIL");
  });
});

// Each row: the named check, and the one mutation (applied AFTER a correct change) that must make it FAIL.
const FAIL_CASES: [string, (s: State) => void][] = [
  ["owner.same_id", (s) => { s.user = null; }],
  ["owner.role", (s) => { s.user!.role = "manager"; }],
  ["owner.email_is_target", (s) => { s.user!.email = "elsewhere@fixture.invalid"; }],
  ["owner.provisional_operator", (s) => { s.user!.loginEmailProvisionalSince = null; }],
  ["owner.provisional_operator", (s) => { s.user!.loginEmailProvisionalSince = new Date("2026-10-07T09:00:00Z"); }],
  ["owner.password_unchanged", (s) => { s.user!.passwordHash = "$2a$12$different"; }],
  ["owner.totp_enabled_unchanged", (s) => { s.user!.totpEnabled = false; }],
  ["owner.totp_secret_unchanged", (s) => { s.user!.totpSecret = "OTHERSECRET"; }],
  ["owner.recovery_codes_unchanged", (s) => { s.user!.totpRecoveryCodes = ["h1", "h2"]; }],
  ["owner.must_change_password_unchanged", (s) => { s.user!.mustChangePassword = true; }],
  ["owner.password_history_ids_unchanged", (s) => { s.history = [{ id: "ph_1" }, { id: "ph_X" }]; }],
  ["owner.session_version_plus_one", (s) => { s.user!.sessionVersion = 6; }],
  ["owner.session_version_plus_one", (s) => { s.user!.sessionVersion = 4; }],
  ["owner.not_locked", (s) => { s.user!.lockedUntil = new Date("2026-10-09T12:00:00Z"); }],
  ["member.same_id", (s) => { s.member = null; }],
  ["member.status_unchanged", (s) => { s.member!.status = "inactive"; }],
  ["member.external_ref_unchanged", (s) => { s.member!.externalRef = "teamup-99999"; }],
  ["member.credentials_unchanged", (s) => { s.member!.passwordHash = "$2a$12$set"; }],
  ["member.memberships_unchanged", (s) => { s.memberships = [{ ...s.memberships[0], entitlement: "history" }]; }],
  ["member.memberships_unchanged", (s) => { s.memberships = []; }],
  ["member.attendance_ids_unchanged", (s) => { s.attendance = [{ id: "ar_1" }, { id: "ar_3" }]; }],
  ["member.guardian_links_unchanged", (s) => { s.children = []; }],
  ["member.guardian_links_unchanged", (s) => { s.member!.parentMemberId = "parent_x"; }],
  ["member.email_is_expected_contact", (s) => { s.member!.email = "wrong@fixture.invalid"; }],
  ["identity.one_user_in_tenant_holds_target", (s) => { s.otherUsers = [{ id: "user_dupe", email: ADDR.ownerTargetEmail }]; }],
  ["identity.no_member_in_tenant_holds_target", (s) => { s.otherMembers = [{ id: "member_dupe", email: ADDR.ownerTargetEmail.toUpperCase() }]; }],
  ["tokens.none_live_for_original_addresses", (s) => { s.resets = 1; }],
  ["tokens.none_live_for_original_addresses", (s) => { s.links = [{ purpose: "first_time_signup", n: 1 }]; }],
  ["audit.owner_change_row_exactly_one", (s) => { s.audit = s.audit.filter((r) => r.id !== "al_new_owner"); }],
  ["audit.owner_change_row_exactly_one", (s) => { s.audit.push({ ...s.audit.find((r) => r.id === "al_new_owner")!, id: "al_new_owner_2", requestId: "req_owner_2" }); }],
  // A different login-email action is not the change (the old "%login_email%" match counted it).
  ["audit.owner_change_row_exactly_one", (s) => { const r = s.audit.find((x) => x.id === "al_new_owner")!; r.action = "admin.owner.login_email.marked_provisional"; }],
  ["audit.no_other_login_change_rows", (s) => { s.audit.push({ ...s.audit.find((r) => r.id === "al_new_owner")!, id: "al_x", action: "user.login_email.changed", requestId: "r9" }); }],
  ["audit.owner_row_subject", (s) => { s.audit.find((r) => r.id === "al_new_owner")!.userId = "someone"; }],
  ["audit.owner_row_operator", (s) => { s.audit.find((r) => r.id === "al_new_owner")!.operatorId = "operator_other"; }],
  ["audit.owner_row_operator", (s) => { s.audit.find((r) => r.id === "al_new_owner")!.operatorId = null; }],
  ["audit.owner_row_request_id", (s) => { s.audit.find((r) => r.id === "al_new_owner")!.requestId = null; }],
  ["audit.owner_row_request_id", (s) => { s.audit.push({ ...s.audit.find((r) => r.id === "al_new_owner")!, id: "al_dup_req", entityId: "user_unrelated", createdAt: new Date("2026-10-08T00:00:00Z") }); }],
  ["audit.owner_row_before_after", (s) => { (s.audit.find((r) => r.id === "al_new_owner")!.metadata as Record<string, unknown>).oldEmailSha256 = sha("x@y.z"); }],
  ["audit.member_contact_row_exactly_one", (s) => { s.audit = s.audit.filter((r) => r.id !== "al_new_member"); }],
  ["audit.member_row_operator", (s) => { s.audit.find((r) => r.id === "al_new_member")!.operatorId = "operator_other"; }],
  ["audit.member_row_request_id", (s) => { s.audit.find((r) => r.id === "al_new_member")!.requestId = null; }],
  ["audit.distinct_request_ids", (s) => { s.audit.find((r) => r.id === "al_new_member")!.requestId = "req_shared"; s.audit.find((r) => r.id === "al_new_owner")!.requestId = "req_shared"; }],
  ["audit.metadata_has_no_raw_address", (s) => { (s.audit.find((r) => r.id === "al_new_member")!.metadata as Record<string, unknown>).note = `was ${ADDR.memberOriginalEmail.toUpperCase()}`; }],
  ["schema.required_columns", (s) => { s.columns.User = s.columns.User.filter((c) => c !== "loginEmailProvisionalSince"); }],
  ["tenant.same", (s) => { s.tenant = { id: "tenant_other", slug: TENANT.slug }; }],
];

describe("owner-login-change-check: every check's FAIL path exits 1", () => {
  it.each(FAIL_CASES.map(([name, fn], i) => [`${i}:${name}`, name, fn] as const))("%s", async (_label, name, mutate) => {
    await baselineThenGoodChange();
    mutate(state);
    const code = await main(verifyArgs(), deps());
    expect(code).toBe(1);
    expect(summary().result).toBe("FAIL");
    expect(statusOf(name)).toBe("FAIL");
    expect(errs.join("\n")).toMatch(new RegExp(`FAIL\\s+${name.replace(/\./g, "\\.")}`));
  });

  it("names the observed sessionVersion delta", async () => {
    await baselineThenGoodChange();
    state.user!.sessionVersion = 7;
    await main(verifyArgs(), deps());
    expect(summary().checks.find((c: { name: string }) => c.name === "owner.session_version_plus_one").detail).toBe("observed delta 3");
  });

  it("a different runSecret at verify time fails (digests are not comparable)", async () => {
    await baselineThenGoodChange();
    fs.writeFileSync(privFile, JSON.stringify({ runSecret: "z".repeat(40), ...ADDR }));
    expect(await main(verifyArgs(), deps())).toBe(1);
    expect(statusOf("baseline.secret_matches")).toBe("FAIL");
  });

  it("a query timeout is an ERROR with exit 1, and the connection is closed", async () => {
    await baselineThenGoodChange();
    state.failOn = /from "MagicLinkToken"/;
    const client = fakeClient(state);
    expect(await main(verifyArgs(), deps({ connect: async () => client }))).toBe(1);
    expect(summary().result).toBe("ERROR");
    expect(client.ended).toBe(true);
  });

  it("a missing or malformed baseline fails with exit 1", async () => {
    expect(await main(verifyArgs(), deps())).toBe(1);
    expect(summary().result).toBe("FAIL");
    await baselineThenGoodChange();
    const dir = path.join(tmp, "baselines");
    const f = path.join(dir, fs.readdirSync(dir)[0]);
    const b = JSON.parse(fs.readFileSync(f, "utf8"));
    delete b.owner.sessionVersion;
    fs.writeFileSync(f, JSON.stringify(b));
    expect(await main(verifyArgs(), deps())).toBe(1);
    expect(summary().reason).toMatch(/malformed/);
  });

  it("baseline refuses to record rows that are not the ones the private file describes (exit 1, nothing written)", async () => {
    state.user!.email = "not-the-original@fixture.invalid";
    expect(await main(args("baseline"), deps())).toBe(1);
    expect(statusOf("owner.email_is_original")).toBe("FAIL");
    expect(fs.existsSync(path.join(tmp, "baselines"))).toBe(false);
  });
});

describe("owner-login-change-check: refusals (exit 2, before any connection)", () => {
  it("host guard: the endpoint id must equal --expect-host exactly (no substring guess)", async () => {
    expect(endpointIdOf(URL_OK)).toBe(EP);
    for (const host of ["ep-fixture-salad", "ep-bold-wave-abt39t7x", "fixture-salad-abc123"]) {
      expect(await main(args("baseline").map((a) => (a === EP ? host : a)), deps())).toBe(2);
      expect(summary().result).toBe("REFUSED");
    }
    const noHost = args("baseline");
    noHost.splice(noHost.indexOf("--expect-host"), 2);
    expect(await main(noHost, deps())).toBe(2);
    expect(connects).toBe(0);
  });

  it("refuses to write the baseline inside the repository", async () => {
    const inRepo = path.join(REPO_ROOT, "docs", "readiness", `lanee-should-not-exist-${randomBytes(4).toString("hex")}`);
    const a = args("baseline");
    a[a.indexOf("--baseline-dir") + 1] = inRepo;
    try {
      expect(await main(a, deps())).toBe(2);
      expect(summary().reason).toMatch(/outside the repository/);
      expect(fs.existsSync(inRepo)).toBe(false);
      expect(connects).toBe(0);
    } finally {
      // If the guard ever regresses, do not leave the written file in the tree.
      fs.rmSync(inRepo, { recursive: true, force: true });
    }
  });

  it("refuses a private address file inside the repository", async () => {
    const a = args("baseline");
    a[a.indexOf("--expect-email-file") + 1] = path.join(REPO_ROOT, "package.json");
    expect(await main(a, deps())).toBe(2);
    expect(connects).toBe(0);
  });

  it("refuses an address on the command line, a missing member decision, and operator path without an operator id", async () => {
    expect(await main([...args("baseline").slice(0, 1), ADDR.ownerTargetEmail, ...args("baseline").slice(1)], deps())).toBe(2);
    expect(outs.join("") + errs.join("")).not.toContain(ADDR.ownerTargetEmail);
    const noMember = args("baseline").filter((a, i, arr) => !(a === "--member-id" || arr[i - 1] === "--member-id"));
    expect(await main(noMember, deps())).toBe(2);
    expect(await main(args("verify", ["--path", "operator"]), deps())).toBe(2);
    expect(connects).toBe(0);
  });

  it("refuses to overwrite an existing baseline unless told to", async () => {
    expect(await main(args("baseline"), deps())).toBe(0);
    expect(await main(args("baseline"), deps())).toBe(2);
    expect(await main(args("baseline", ["--overwrite"]), deps())).toBe(0);
  });

  it("refuses a malformed private file", async () => {
    fs.writeFileSync(privFile, JSON.stringify({ runSecret: "short", ...ADDR }));
    expect(await main(args("baseline"), deps())).toBe(2);
    fs.writeFileSync(privFile, JSON.stringify({ runSecret: SECRET, ...ADDR, ownerTargetEmail: ADDR.ownerOriginalEmail }));
    expect(await main(args("baseline"), deps())).toBe(2);
    expect(connects).toBe(0);
  });
});
