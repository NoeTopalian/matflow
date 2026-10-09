// READ-ONLY, machine-enforced verification of an owner login-email change
// (admin hub lane E, 9 Oct 2026; ledger AH-06). Replaces the defective
// one-off scratch script (sean-state.mjs) used on 9 Oct 2026.
//
//   node scripts/readiness/owner-login-change-check.mjs baseline \
//     --tenant <slug> --owner-id <User.id> (--member-id <Member.id> | --no-member) \
//     --expect-email-file <private json OUTSIDE the repo> --expect-host <neon endpoint id> [--env .env.test]
//   node scripts/readiness/owner-login-change-check.mjs verify  ...same... \
//     --path self-service|operator [--operator-id <Operator.id>]
//
// Exit codes: 0 every check PASSES; 1 any check FAILS / is missing / errors
// (including a timeout or a malformed row); 2 refused before connecting (usage,
// host guard, a path inside the repository, a malformed private file).
// stdout = ONE JSON summary; stderr = human lines. Pipe-safe: run under
// `set -o pipefail` (or read $? / $LASTEXITCODE directly) — the exit code is the verdict.
//
// What it never does: print or store an address, a password hash, a TOTP
// secret, a recovery code or a token. Addresses come only from the private
// file (never argv); every stored value is an HMAC keyed with the private
// file's runSecret, so a baseline file on its own proves nothing to a reader.
//
// Private file (JSON, outside the repository):
//   { "runSecret": "<≥32 random chars>",
//     "ownerOriginalEmail": "...", "ownerTargetEmail": "...",
//     "memberOriginalEmail": "...", "memberTargetEmail": "..." }   // member pair only with --member-id
//
// Database discipline: one transaction, BEGIN ISOLATION LEVEL REPEATABLE READ
// READ ONLY (one consistent snapshot for every query; Postgres refuses writes),
// SET LOCAL statement_timeout, only the columns each check needs, ROLLBACK.
// The tenant is resolved by slug with app.bypass_rls set LOCAL for that one
// SELECT, then RLS context is the tenant (app.current_tenant_id) for every
// other query, so the restricted role works (--db-var RESTRICTED_DATABASE_URL).
//
// Provisional-state expectation per path (read from both routes, 9 Oct 2026):
//   self-service  app/api/account/login-email/route.ts — sets
//                 loginEmailProvisionalSince = new Date() in the change tx.
//   operator      app/api/admin/customers/[id]/login-email/route.ts action
//                 "change" — sets loginEmailProvisionalSince = now in the tx.
//   Both: provisional AFTER the change, stamped fresh (non-null and later than
//   the baseline's stamp, if any). Encoded in PROVISIONAL_EXPECTATION.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const ACTIONS = {
  "self-service": "user.login_email.changed",
  operator: "admin.owner.login_email.changed",
};
export const DEFAULT_MEMBER_CONTACT_ACTION = "admin.member.contact_email.changed";

export const PROVISIONAL_EXPECTATION = {
  "self-service": { provisional: true, fresh: true, source: "app/api/account/login-email/route.ts" },
  operator: { provisional: true, fresh: true, source: "app/api/admin/customers/[id]/login-email/route.ts" },
};

// Sign-in purposes whose live tokens must be gone for both original addresses.
// waiver_open is deliberately ignored (a supervised waiver link is not a sign-in).
export const SIGN_IN_LINK_PURPOSES = ["login", "first_time_signup"];

const REQUIRED_COLUMNS = {
  Tenant: ["id", "slug"],
  User: [
    "id", "tenantId", "role", "email", "passwordHash", "totpSecret", "totpEnabled", "totpRecoveryCodes",
    "mustChangePassword", "sessionVersion", "lockedUntil", "loginEmailProvisionalSince",
  ],
  Member: [
    "id", "tenantId", "email", "status", "externalRef", "passwordHash", "totpSecret", "totpEnabled",
    "sessionVersion", "parentMemberId", "guardianConfirmedAt",
  ],
  PasswordHistory: ["id", "userId"],
  ImportedMembership: [
    "id", "tenantId", "memberId", "importJobId", "sourceRow", "sourceFingerprint", "planLabel", "type", "status",
    "entitlement", "disposition",
  ],
  AttendanceRecord: ["id", "tenantId", "memberId"],
  PasswordResetToken: ["id", "tenantId", "email", "used", "expiresAt"],
  MagicLinkToken: ["id", "tenantId", "email", "used", "expiresAt", "purpose"],
  AuditLog: ["id", "tenantId", "userId", "action", "entityType", "entityId", "metadata", "createdAt"],
};
const AUDIT_CORRELATION_COLUMNS = ["operatorId", "requestId"];

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SLUG_RE = /^[a-z0-9-]{1,60}$/;

export class Refusal extends Error {}
class MissingEvidence extends Error {}

// ── pure helpers ────────────────────────────────────────────────────────────

export function normaliseEmail(v) {
  return String(v).trim().toLowerCase();
}

export function keyed(secret, value) {
  if (value === null || value === undefined) return null;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return createHmac("sha256", secret).update(s).digest("hex");
}

/** Plain SHA-256 as the routes write it (lib/login-email.ts emailDigest). */
export function routeEmailDigest(email) {
  return createHash("sha256").update(normaliseEmail(email)).digest("hex");
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { out[key] = true; continue; }
    out[key] = next;
    i++;
  }
  return out;
}

/** Neon endpoint id from a connection string: first host label without "-pooler". */
export function endpointIdOf(connectionString) {
  let host;
  try { host = new URL(connectionString).hostname; } catch { return null; }
  const label = host.split(".")[0] ?? "";
  const id = label.replace(/-pooler$/, "");
  return /^ep-[a-z0-9-]+$/.test(id) ? id : null;
}

export function hostGuard(connectionString, expectHost) {
  if (!expectHost || expectHost === true) throw new Refusal("--expect-host <neon endpoint id> is required");
  const expected = String(expectHost).replace(/-pooler$/, "");
  const actual = endpointIdOf(connectionString);
  if (!actual) throw new Refusal("the database URL has no recognisable Neon endpoint id");
  if (actual !== expected) throw new Refusal(`database endpoint ${actual} is not the expected ${expected}`);
  return actual;
}

function realOrResolved(p) {
  // Resolve symlinks on the nearest existing ancestor, so a link inside the
  // repo that points out (or the reverse) is judged by where it really lands.
  let cur = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  let real = cur;
  try { real = fs.realpathSync.native(cur); } catch { /* keep resolved */ }
  return path.join(real, ...rest);
}

export function isInside(child, parent) {
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const c = norm(realOrResolved(child));
  const r = norm(realOrResolved(parent));
  const rel = path.relative(r, c);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function assertOutsideRepo(p, what, repoRoot = REPO_ROOT) {
  if (isInside(p, repoRoot)) throw new Refusal(`${what} must be outside the repository (refusing ${path.basename(p)})`);
}

export function defaultBaselineDir(env = process.env) {
  return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "matflow-readiness") : path.join(os.homedir(), ".matflow-readiness");
}

export function readPrivateFile(file, { needMember }) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Refusal("the private file is missing or is not JSON"); }
  const need = ["ownerOriginalEmail", "ownerTargetEmail", ...(needMember ? ["memberOriginalEmail", "memberTargetEmail"] : [])];
  if (typeof raw.runSecret !== "string" || raw.runSecret.length < 32) throw new Refusal("private file: runSecret must be at least 32 characters");
  const out = { runSecret: raw.runSecret };
  for (const k of need) {
    const v = raw[k];
    if (typeof v !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim()) || v.length > 254) {
      throw new Refusal(`private file: ${k} is missing or not an address`);
    }
    out[k] = normaliseEmail(v);
  }
  if (out.ownerOriginalEmail === out.ownerTargetEmail) throw new Refusal("private file: the owner's original and target addresses are the same");
  if (needMember && out.memberOriginalEmail === out.memberTargetEmail) throw new Refusal("private file: the member's original and target addresses are the same");
  return out;
}

// ── the read-only snapshot ──────────────────────────────────────────────────

const q = async (client, text, params) => (await client.query(text, params)).rows;

// Prisma stores DateTime as TIMESTAMP(3) WITHOUT TIME ZONE holding UTC. The pg
// driver parses such a value as LOCAL time, so on a machine outside UTC every
// row would shift by the local offset against now() (found on the TEST-branch
// proof run, 9 Oct 2026: BST put every fresh audit row an hour before the
// baseline). Every timestamp therefore leaves the database as UTC ISO text.
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const ts = (col, alias) => `to_char(${col}, ${ISO}) as "${alias}"`;
const NOW_UTC = `(now() at time zone 'UTC')`;
const iso = (v) => (v === null || v === undefined ? null : new Date(v).toISOString());

export async function captureSnapshot(client, { slug, ownerId, memberId, secret, addresses, memberContactAction, ownerAction }) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout = '15s'");
    const [{ now }] = await q(client, `select ${ts(NOW_UTC, "now")}`);

    const colRows = await q(
      client,
      `select table_name, column_name from information_schema.columns where table_schema = current_schema() and table_name = any($1)`,
      [Object.keys(REQUIRED_COLUMNS)],
    );
    const cols = {};
    for (const r of colRows) (cols[r.table_name] ??= new Set()).add(r.column_name);
    const missing = [];
    for (const [t, list] of Object.entries(REQUIRED_COLUMNS)) for (const c of list) if (!cols[t]?.has(c)) missing.push(`${t}.${c}`);
    const auditPath = AUDIT_CORRELATION_COLUMNS.every((c) => cols.AuditLog?.has(c)) ? "columns" : "metadata-fallback";
    if (missing.length) return { at: iso(now), schemaMissing: missing, auditPath };

    await q(client, "select set_config('app.bypass_rls', 'on', true)");
    const tenants = await q(client, `select id, slug from "Tenant" where slug = $1`, [slug]);
    await q(client, "select set_config('app.bypass_rls', 'off', true)");
    if (tenants.length !== 1) return { at: iso(now), auditPath, tenant: null };
    const tenantId = tenants[0].id;
    await q(client, "select set_config('app.current_tenant_id', $1, true)", [tenantId]);

    const users = await q(
      client,
      `select id, "tenantId", role, email, "passwordHash", "totpSecret", "totpEnabled", "totpRecoveryCodes",
              "mustChangePassword", "sessionVersion", ${ts(`"lockedUntil"`, "lockedUntil")},
              ${ts(`"loginEmailProvisionalSince"`, "loginEmailProvisionalSince")}
         from "User" where id = $1 and "tenantId" = $2`,
      [ownerId, tenantId],
    );
    const u = users[0] ?? null;
    const owner = u && {
      id: u.id,
      tenantId: u.tenantId,
      role: u.role,
      emailKey: keyed(secret, normaliseEmail(u.email)),
      provisionalSince: iso(u.loginEmailProvisionalSince),
      passwordHashFp: keyed(secret, u.passwordHash),
      totpSecretFp: keyed(secret, u.totpSecret),
      totpEnabled: u.totpEnabled,
      recoveryCodesFp: keyed(secret, u.totpRecoveryCodes),
      recoveryCodeCount: Array.isArray(u.totpRecoveryCodes) ? u.totpRecoveryCodes.length : null,
      mustChangePassword: u.mustChangePassword,
      sessionVersion: u.sessionVersion,
      lockedUntil: iso(u.lockedUntil),
      passwordHistoryIds: u ? (await q(client, `select id from "PasswordHistory" where "userId" = $1 order by id`, [u.id])).map((r) => r.id) : [],
    };

    let member = null;
    if (memberId) {
      const ms = await q(
        client,
        `select id, "tenantId", email, status, "externalRef", "passwordHash", "totpSecret", "totpEnabled",
                "sessionVersion", "parentMemberId", ${ts(`"guardianConfirmedAt"`, "guardianConfirmedAt")}
           from "Member" where id = $1 and "tenantId" = $2`,
        [memberId, tenantId],
      );
      const m = ms[0] ?? null;
      if (m) {
        const memberships = await q(
          client,
          `select id, "importJobId", "sourceRow", "sourceFingerprint", "planLabel", type, status, entitlement, disposition
             from "ImportedMembership" where "memberId" = $1 and "tenantId" = $2 order by id`,
          [m.id, tenantId],
        );
        const attendance = await q(client, `select id from "AttendanceRecord" where "memberId" = $1 and "tenantId" = $2 order by id`, [m.id, tenantId]);
        const children = await q(client, `select id from "Member" where "parentMemberId" = $1 and "tenantId" = $2 order by id`, [m.id, tenantId]);
        member = {
          id: m.id,
          tenantId: m.tenantId,
          emailKey: keyed(secret, normaliseEmail(m.email)),
          status: m.status,
          externalRefFp: keyed(secret, m.externalRef),
          credentialsFp: keyed(secret, [m.passwordHash, m.totpSecret, m.totpEnabled]),
          canSignIn: m.passwordHash !== null,
          sessionVersion: m.sessionVersion,
          membershipIds: memberships.map((r) => r.id),
          membershipsFp: keyed(secret, memberships),
          attendanceIds: attendance.map((r) => r.id),
          guardian: {
            parentMemberId: m.parentMemberId,
            guardianConfirmedAt: iso(m.guardianConfirmedAt),
            childIds: children.map((r) => r.id),
          },
        };
      }
    }

    const target = addresses.ownerTargetEmail;
    const userHolders = (await q(client, `select id from "User" where "tenantId" = $1 and lower(email) = $2 order by id`, [tenantId, target])).map((r) => r.id);
    const memberHolders = (await q(client, `select id from "Member" where "tenantId" = $1 and lower(email) = $2 order by id`, [tenantId, target])).map((r) => r.id);

    const originals = [addresses.ownerOriginalEmail, ...(addresses.memberOriginalEmail ? [addresses.memberOriginalEmail] : [])];
    const [{ n: liveResets }] = await q(
      client,
      `select count(*)::int as n from "PasswordResetToken" where "tenantId" = $1 and lower(email) = any($2) and used = false and "expiresAt" > ${NOW_UTC}`,
      [tenantId, originals],
    );
    const linkRows = await q(
      client,
      `select purpose, count(*)::int as n from "MagicLinkToken"
        where "tenantId" = $1 and lower(email) = any($2) and used = false and "expiresAt" > ${NOW_UTC} and purpose = any($3)
        group by purpose order by purpose`,
      [tenantId, originals, SIGN_IN_LINK_PURPOSES],
    );
    const liveLinks = Object.fromEntries(linkRows.map((r) => [r.purpose, r.n]));

    const subjects = [ownerId, ...(memberId ? [memberId] : [])];
    const corr = auditPath === "columns" ? `, "operatorId", "requestId"` : "";
    const auditRows = await q(
      client,
      `select id, action, "entityType", "entityId", "userId", ${ts(`"createdAt"`, "createdAt")}, metadata${corr}
         from "AuditLog" where "tenantId" = $1 and "entityId" = any($2)
        order by "AuditLog"."createdAt" desc, id desc limit 200`,
      [tenantId, subjects],
    );
    const audit = auditRows.map((r) => {
      const md = r.metadata && typeof r.metadata === "object" ? r.metadata : {};
      return {
        id: r.id,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        userId: r.userId,
        createdAt: iso(r.createdAt),
        operatorId: auditPath === "columns" ? r.operatorId ?? null : typeof md.actingAs === "string" ? md.actingAs : null,
        requestId: auditPath === "columns" ? r.requestId ?? null : typeof md.requestId === "string" ? md.requestId : null,
        metadataText: JSON.stringify(r.metadata ?? null).toLowerCase(),
        oldEmailSha256: typeof md.oldEmailSha256 === "string" ? md.oldEmailSha256 : null,
        newEmailSha256: typeof md.newEmailSha256 === "string" ? md.newEmailSha256 : null,
      };
    });

    // Correlation: how many rows in this tenant carry each fresh row's requestId
    // under the same action (a double application would show 2).
    const reqCounts = {};
    for (const r of audit) {
      if (!r.requestId || ![ownerAction, memberContactAction].includes(r.action)) continue;
      const sql = auditPath === "columns"
        ? `select count(*)::int as n from "AuditLog" where "tenantId" = $1 and action = $2 and "requestId" = $3`
        : `select count(*)::int as n from "AuditLog" where "tenantId" = $1 and action = $2 and metadata->>'requestId' = $3`;
      reqCounts[r.id] = (await q(client, sql, [tenantId, r.action, r.requestId]))[0].n;
    }

    return {
      at: iso(now),
      auditPath,
      tenant: { id: tenantId, slug: tenants[0].slug },
      owner,
      member,
      memberIdRequested: memberId ?? null,
      holders: { userIds: userHolders, memberIds: memberHolders },
      tokens: { liveResets, liveLinks },
      audit,
      reqCounts,
    };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
  }
}

// ── checks ──────────────────────────────────────────────────────────────────

function collector() {
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, status: ok ? "PASS" : "FAIL", ...(detail ? { detail: String(detail) } : {}) });
  return { checks, add };
}

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

/** Identity validation at baseline time: the rows are the ones the private file describes. */
export function evaluateBaseline(snap, { secret, addresses, memberId }) {
  const { checks, add } = collector();
  add("schema.required_columns", !snap.schemaMissing, snap.schemaMissing ? `missing ${snap.schemaMissing.join(", ")}` : "");
  if (snap.schemaMissing) return checks;
  add("tenant.found", !!snap.tenant);
  if (!snap.tenant) return checks;
  add("owner.found_in_tenant", !!snap.owner);
  if (snap.owner) {
    add("owner.role", snap.owner.role === "owner", snap.owner.role);
    add("owner.email_is_original", snap.owner.emailKey === keyed(secret, addresses.ownerOriginalEmail));
    add("owner.not_locked", !snap.owner.lockedUntil || new Date(snap.owner.lockedUntil) <= new Date(snap.at));
  }
  if (memberId) {
    add("member.found_in_tenant", !!snap.member);
    if (snap.member) add("member.email_is_original", snap.member.emailKey === keyed(secret, addresses.memberOriginalEmail));
  }
  return checks;
}

export function evaluateVerify(base, cur, { secret, addresses, memberId, path: changePath, operatorId, memberContactAction }) {
  const { checks, add } = collector();
  add("baseline.secret_matches", base.secretCheck === keyed(secret, "matflow-readiness/v1"), "the private file's runSecret is not the one the baseline was taken with");
  add("schema.required_columns", !cur.schemaMissing, cur.schemaMissing ? `missing ${cur.schemaMissing.join(", ")}` : "");
  if (cur.schemaMissing) return checks;
  add("tenant.same", !!cur.tenant && cur.tenant.id === base.tenant.id);
  if (!cur.tenant) return checks;

  const o = cur.owner;
  const bo = base.owner;
  add("owner.same_id", !!o && o.id === bo.id && o.tenantId === bo.tenantId);
  if (o) {
    const exp = PROVISIONAL_EXPECTATION[changePath];
    add("owner.role", o.role === "owner", o.role);
    add("owner.email_is_target", o.emailKey === keyed(secret, addresses.ownerTargetEmail));
    const fresh = o.provisionalSince !== null && (bo.provisionalSince === null || new Date(o.provisionalSince) > new Date(bo.provisionalSince));
    add(`owner.provisional_${changePath}`, exp.provisional ? fresh : o.provisionalSince === null,
      o.provisionalSince === null ? "not provisional" : fresh ? "" : "provisional stamp not refreshed by the change");
    add("owner.password_unchanged", o.passwordHashFp === bo.passwordHashFp);
    add("owner.totp_enabled_unchanged", o.totpEnabled === bo.totpEnabled);
    add("owner.totp_secret_unchanged", o.totpSecretFp === bo.totpSecretFp);
    add("owner.recovery_codes_unchanged", o.recoveryCodesFp === bo.recoveryCodesFp, `${o.recoveryCodeCount ?? 0} codes`);
    add("owner.must_change_password_unchanged", o.mustChangePassword === bo.mustChangePassword);
    add("owner.password_history_ids_unchanged", sameList(o.passwordHistoryIds, bo.passwordHistoryIds));
    const delta = o.sessionVersion - bo.sessionVersion;
    add("owner.session_version_plus_one", delta === 1, delta === 1 ? "" : `observed delta ${delta}`);
    add("owner.not_locked", !o.lockedUntil || new Date(o.lockedUntil) <= new Date(cur.at));
  }

  if (memberId) {
    const m = cur.member;
    const bm = base.member;
    add("member.same_id", !!m && !!bm && m.id === bm.id && m.tenantId === bm.tenantId);
    if (m && bm) {
      add("member.status_unchanged", m.status === bm.status, m.status);
      add("member.external_ref_unchanged", m.externalRefFp === bm.externalRefFp);
      add("member.credentials_unchanged", m.credentialsFp === bm.credentialsFp);
      add("member.memberships_unchanged", sameList(m.membershipIds, bm.membershipIds) && m.membershipsFp === bm.membershipsFp, `${m.membershipIds.length} rows`);
      add("member.attendance_ids_unchanged", sameList(m.attendanceIds, bm.attendanceIds), `${m.attendanceIds.length} rows`);
      add("member.guardian_links_unchanged",
        m.guardian.parentMemberId === bm.guardian.parentMemberId &&
        m.guardian.guardianConfirmedAt === bm.guardian.guardianConfirmedAt &&
        sameList(m.guardian.childIds, bm.guardian.childIds));
      add("member.email_is_expected_contact", m.emailKey === keyed(secret, addresses.memberTargetEmail));
    }
  }

  add("identity.one_user_in_tenant_holds_target",
    cur.holders.userIds.length === 1 && cur.holders.userIds[0] === base.owner.id, `${cur.holders.userIds.length} user(s)`);
  add("identity.no_member_in_tenant_holds_target", cur.holders.memberIds.length === 0, `${cur.holders.memberIds.length} member(s)`);

  const links = Object.values(cur.tokens.liveLinks).reduce((a, b) => a + b, 0);
  add("tokens.none_live_for_original_addresses", cur.tokens.liveResets === 0 && links === 0,
    `reset ${cur.tokens.liveResets}, ${SIGN_IN_LINK_PURPOSES.map((p) => `${p} ${cur.tokens.liveLinks[p] ?? 0}`).join(", ")}`);

  // Audit: rows written after the baseline for the two subjects.
  const seen = new Set(base.audit.latestIds);
  const fresh = cur.audit.filter((r) => !seen.has(r.id) && new Date(r.createdAt) >= new Date(base.audit.floor));
  const ownerAction = ACTIONS[changePath];
  const ownerRows = fresh.filter((r) => r.action === ownerAction && r.entityId === base.owner.id);
  add("audit.owner_change_row_exactly_one", ownerRows.length === 1, `${ownerRows.length} × ${ownerAction}`);
  const wrongPath = fresh.filter((r) => Object.values(ACTIONS).includes(r.action) && r.action !== ownerAction);
  add("audit.no_other_login_change_rows", wrongPath.length === 0, wrongPath.map((r) => r.action).join(", "));
  if (ownerRows.length === 1) {
    const r = ownerRows[0];
    add("audit.owner_row_subject", r.entityType === "User" && r.userId === base.owner.id);
    if (changePath === "operator") {
      add("audit.owner_row_operator", !!operatorId && r.operatorId === operatorId, r.operatorId ? "operator differs" : "no operator recorded");
    } else {
      add("audit.owner_row_self_actor", r.operatorId === null, r.operatorId ? "an operator is recorded on a self-service change" : "");
    }
    add("audit.owner_row_request_id", !!r.requestId && cur.reqCounts[r.id] === 1,
      !r.requestId ? "no request id" : `${cur.reqCounts[r.id]} row(s) share it`);
    add("audit.owner_row_before_after",
      r.oldEmailSha256 === routeEmailDigest(addresses.ownerOriginalEmail) && r.newEmailSha256 === routeEmailDigest(addresses.ownerTargetEmail),
      "old/new digests do not match the private addresses");
  }
  if (memberId) {
    const mRows = fresh.filter((r) => r.action === memberContactAction && r.entityId === memberId);
    add("audit.member_contact_row_exactly_one", mRows.length === 1, `${mRows.length} × ${memberContactAction}`);
    if (mRows.length === 1) {
      const r = mRows[0];
      add("audit.member_row_subject", r.entityType === "Member");
      add("audit.member_row_operator", operatorId ? r.operatorId === operatorId : r.operatorId !== null, r.operatorId ? "" : "no operator recorded");
      add("audit.member_row_request_id", !!r.requestId && cur.reqCounts[r.id] === 1, !r.requestId ? "no request id" : `${cur.reqCounts[r.id]} row(s) share it`);
      if (ownerRows.length === 1) add("audit.distinct_request_ids", mRows[0].requestId !== ownerRows[0].requestId);
    }
  }
  const raw = [addresses.ownerOriginalEmail, addresses.ownerTargetEmail, addresses.memberOriginalEmail, addresses.memberTargetEmail].filter(Boolean);
  const leaking = fresh.filter((r) => raw.some((a) => r.metadataText.includes(a)));
  add("audit.metadata_has_no_raw_address", leaking.length === 0, leaking.length ? `${leaking.length} row(s): ${leaking.map((r) => r.action).join(", ")}` : "");
  return checks;
}

// ── main ────────────────────────────────────────────────────────────────────

async function defaultConnect(connectionString) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString, statement_timeout: 15000, query_timeout: 20000, connectionTimeoutMillis: 15000 });
  await client.connect();
  return client;
}

async function defaultReadEnv(file) {
  const { default: dotenv } = await import("dotenv");
  return dotenv.parse(fs.readFileSync(file, "utf8"));
}

export async function main(argv, deps = {}) {
  const out = deps.stdout ?? ((s) => process.stdout.write(s + "\n"));
  const err = deps.stderr ?? ((s) => process.stderr.write(s + "\n"));
  const connect = deps.connect ?? defaultConnect;
  const readEnv = deps.readEnv ?? defaultReadEnv;
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const summary = { script: "owner-login-change-check", mode: null, result: "ERROR", checks: [] };
  const finish = (code) => {
    out(JSON.stringify(summary));
    for (const c of summary.checks) err(`${c.status.padEnd(5)} ${c.name}${c.detail && c.status !== "PASS" ? `  (${c.detail})` : ""}`);
    err(`${summary.result}${summary.reason ? `: ${summary.reason}` : ""}`);
    return code;
  };

  let client;
  try {
    const a = parseArgs(argv);
    const mode = a._[0];
    summary.mode = mode ?? null;
    if (!["baseline", "verify"].includes(mode)) throw new Refusal("usage: baseline|verify --tenant <slug> --owner-id <id> (--member-id <id> | --no-member) --expect-email-file <private> --expect-host <endpoint> [--env .env.test] [--path self-service|operator] [--operator-id <id>]");
    if (a._.length > 1) throw new Refusal("unexpected positional argument (addresses are never accepted on the command line)");
    if (typeof a.tenant !== "string" || !SLUG_RE.test(a.tenant)) throw new Refusal("--tenant <slug> is required");
    if (typeof a["owner-id"] !== "string" || !ID_RE.test(a["owner-id"])) throw new Refusal("--owner-id <id> is required");
    const memberId = typeof a["member-id"] === "string" ? a["member-id"] : null;
    if (memberId && !ID_RE.test(memberId)) throw new Refusal("--member-id is malformed");
    if (!memberId && a["no-member"] !== true) throw new Refusal("pass --member-id <id> or --no-member explicitly");
    if (typeof a["expect-email-file"] !== "string") throw new Refusal("--expect-email-file <private path> is required");
    const changePath = a.path;
    if (mode === "verify" && !["self-service", "operator"].includes(changePath)) throw new Refusal("verify needs --path self-service|operator");
    const operatorId = typeof a["operator-id"] === "string" ? a["operator-id"] : null;
    if (operatorId && !ID_RE.test(operatorId)) throw new Refusal("--operator-id is malformed");
    if (mode === "verify" && changePath === "operator" && !operatorId) throw new Refusal("--path operator needs --operator-id <Operator.id>");
    const memberContactAction = typeof a["member-contact-action"] === "string" ? a["member-contact-action"] : DEFAULT_MEMBER_CONTACT_ACTION;

    const privateFile = path.resolve(a["expect-email-file"]);
    assertOutsideRepo(privateFile, "the private address file", repoRoot);
    const priv = readPrivateFile(privateFile, { needMember: !!memberId });
    const addresses = priv;
    const secret = priv.runSecret;

    const baselineDir = path.resolve(typeof a["baseline-dir"] === "string" ? a["baseline-dir"] : defaultBaselineDir(deps.env ?? process.env));
    assertOutsideRepo(baselineDir, "the baseline directory", repoRoot);
    const baselineFile = path.join(baselineDir, `owner-login-change-${a.tenant}-${a["owner-id"]}.json`);

    const envFile = path.resolve(typeof a.env === "string" ? a.env : ".env.test");
    const dbVar = typeof a["db-var"] === "string" ? a["db-var"] : "DATABASE_URL";
    const env = await readEnv(envFile);
    const url = env[dbVar];
    if (!url) throw new Refusal(`${dbVar} is not set in the env file`);
    summary.endpoint = hostGuard(url, a["expect-host"]);

    let base = null;
    if (mode === "verify") {
      // Missing or malformed evidence is a FAIL (exit 1), not a refusal.
      try { base = JSON.parse(fs.readFileSync(baselineFile, "utf8")); } catch { throw new MissingEvidence("no readable baseline for this tenant and owner: run baseline first"); }
      const shapeOk = base && base.kind === "owner-login-change-baseline" && base.version === 1 && typeof base.secretCheck === "string" &&
        base.tenant?.slug === a.tenant && base.owner?.id === a["owner-id"] && (base.memberId ?? null) === memberId &&
        Array.isArray(base.owner?.passwordHistoryIds) && Number.isInteger(base.owner?.sessionVersion) &&
        Array.isArray(base.audit?.latestIds) && typeof base.audit?.floor === "string" && (!memberId || base.member?.id === memberId);
      if (!shapeOk) throw new MissingEvidence("the baseline is malformed or does not match these arguments");
    } else if (fs.existsSync(baselineFile) && a.overwrite !== true) {
      throw new Refusal("a baseline already exists for this tenant and owner (a baseline taken after the change would prove nothing); pass --overwrite only if no change has been made since");
    }

    client = await connect(url);
    const snap = await captureSnapshot(client, {
      slug: a.tenant,
      ownerId: a["owner-id"],
      memberId,
      secret,
      addresses,
      memberContactAction,
      ownerAction: ACTIONS[changePath] ?? ACTIONS.operator,
    });
    summary.auditPath = snap.auditPath;

    if (mode === "baseline") {
      summary.checks = evaluateBaseline(snap, { secret, addresses, memberId });
      const failed = summary.checks.filter((c) => c.status !== "PASS");
      if (failed.length) {
        summary.result = "FAIL";
        summary.reason = "identity validation failed; no baseline written";
        return finish(1);
      }
      const record = {
        kind: "owner-login-change-baseline",
        version: 1,
        takenAt: snap.at,
        endpoint: summary.endpoint,
        auditPath: snap.auditPath,
        secretCheck: keyed(secret, "matflow-readiness/v1"),
        tenant: snap.tenant,
        owner: snap.owner,
        memberId,
        member: snap.member,
        tokens: snap.tokens,
        audit: { floor: snap.at, latestIds: snap.audit.map((r) => r.id) },
      };
      fs.mkdirSync(baselineDir, { recursive: true });
      fs.writeFileSync(baselineFile, JSON.stringify(record, null, 2), { mode: 0o600 });
      summary.result = "PASS";
      summary.baselineFile = path.basename(baselineFile);
      return finish(0);
    }

    summary.checks = evaluateVerify(base, snap, { secret, addresses, memberId, path: changePath, operatorId, memberContactAction });
    const failed = summary.checks.filter((c) => c.status !== "PASS");
    summary.result = failed.length ? "FAIL" : "PASS";
    summary.failed = failed.length;
    return finish(failed.length ? 1 : 0);
  } catch (e) {
    if (e instanceof Refusal) {
      summary.result = "REFUSED";
      summary.reason = e.message;
      return finish(2);
    }
    if (e instanceof MissingEvidence) {
      summary.result = "FAIL";
      summary.reason = e.message;
      return finish(1);
    }
    summary.result = "ERROR";
    // The message only: a driver error can carry a query text, never a value we print.
    summary.reason = (e && e.code ? `${e.code} ` : "") + String(e?.message ?? e).slice(0, 200);
    return finish(1);
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
