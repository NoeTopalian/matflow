// Operator moves a NON-OWNER staff account's login address, against a REAL
// database — the Neon TEST branch only (hub conflicts, 12 Oct 2026). Pattern,
// helpers and role switching copied from
// tests/integration/operator-hub-conflict-db.test.ts (same fixture builders:
// makeTenant, makeOwner, makeStaff, operatorRequest, issueGrant).
//
// "Both roles" = this file is run twice by the guarded runner: once with
// TEST_DATABASE_URL = the test branch's owner URL, once with its restricted
// (RLS-subject) URL. One describe; makeTenant(label) only names the club.
// Synthetic, run-stamped clubs; everything deleted by cleanup().
//
// R14 (13 Oct 2026, the nested describe at the end): what a moved staff
// account can still do, through the REAL doors — the Credentials authorize()
// from auth.ts (captured by mocking the next-auth wrapper, as
// tests/integration/account-editing-db.test.ts does), POST forgot-password,
// POST magic-link/request — and the recovery, PATCH /api/staff/[id] as the
// club owner. Mail stays dark (sendEmail mocked; EMAIL_DELIVERY untouched), so
// "no token" alone would prove nothing: each refusal is pinned by its own
// audit row as well. Sign-in notifications are stubbed (no LoginEvent rows).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";

const authState = vi.hoisted(() => ({
  authorize: undefined as undefined | ((c: Record<string, unknown>, r: Request) => Promise<Record<string, unknown> | null>),
}));

vi.mock("next/headers", async () => {
  const { hubState: s } = await import("./helpers/operator-hub-state");
  return {
    cookies: async () => ({
      get: (n: string) => (s.jar.has(n) ? { name: n, value: s.jar.get(n)! } : undefined),
      getAll: () => [...s.jar.entries()].map(([name, value]) => ({ name, value })),
      has: (n: string) => s.jar.has(n),
      set: () => {},
      delete: () => {},
    }),
    headers: async () => new Headers(),
  };
});
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
// The REAL auth.ts behind a stubbed next-auth wrapper: its Credentials
// authorize() is captured for the sign-in checks, and auth() hands the routes
// the session in hubState (null unless a test sets one).
vi.mock("next-auth", async () => {
  const { hubState: s } = await import("./helpers/operator-hub-state");
  return {
    default: (config: { providers: { authorize?: (c: Record<string, unknown>, r: Request) => Promise<Record<string, unknown> | null> }[] }) => {
      for (const p of config.providers) if (p?.authorize) authState.authorize = p.authorize;
      return { handlers: {}, auth: async () => s.session, signIn: async () => {}, signOut: async () => {} };
    },
    CredentialsSignin: class extends Error { code = "credentials"; },
  };
});
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/providers/google", () => ({ default: (c: unknown) => c }));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: async () => {} }));

import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { hubState } from "./helpers/operator-hub-state";
import { lockoutKeys, requestClientIp } from "@/lib/auth-lockout";
import { TEMP_PASSWORD_TTL_MS } from "@/lib/temp-password";
import { emailDigest } from "@/lib/login-email";
import { NO_LOGIN_EMAIL_DOMAIN } from "@/lib/synthesise-kid-email";
import {
  OP_ID,
  ORIGIN,
  bumpSessionVersion,
  checkAddress,
  cleanup,
  isUsed,
  issueGrant,
  jsonRequest,
  makeMember,
  makeOwner,
  makeStaff,
  makeTenant,
  mint,
  operatorRequest,
  seedDuplicate,
  stampedEmail,
  tenantSlug,
} from "./helpers/operator-hub";
import { POST as moveStaff } from "@/app/api/admin/customers/[id]/staff/[userId]/login-email/route";
import { POST as forgotPassword } from "@/app/api/auth/forgot-password/route";
import { POST as requestMagicLink } from "@/app/api/magic-link/request/route";
import { PATCH as ownerEditStaff } from "@/app/api/staff/[id]/route";

const HAS_DB = !!process.env.DATABASE_URL;
const OUTCOME = "admin.staff.login_email.changed";

describe.skipIf(!HAS_DB)("staff login email (operator hub, TEST branch)", () => {
  let t: { tenantId: string; ownerId: string; staffId: string };
  const user = (id: string) =>
    withRlsBypass((tx) =>
      tx.user.findUniqueOrThrow({
        where: { id },
        select: {
          email: true, role: true, tenantId: true, passwordHash: true, sessionVersion: true, loginEmailProvisionalSince: true,
          totpEnabled: true, totpSecret: true, totpRecoveryCodes: true,
        },
      }),
    );
  const outcomes = (entityId: string) =>
    withRlsBypass((tx) =>
      tx.auditLog.findMany({ where: { tenantId: t.tenantId, action: OUTCOME, entityId }, select: { operatorId: true, userId: true, metadata: true } }),
    );

  beforeAll(async () => {
    const tenantId = await makeTenant("staff-login-email");
    const ownerId = await makeOwner(tenantId, "owner@club.test");
    const staffId = await makeStaff(tenantId, { email: "shared@club.test", role: "manager" });
    t = { tenantId, ownerId, staffId };
  }, 120_000);
  afterAll(cleanup, 120_000);

  it("check returns the staff holder with a version", async () => {
    const r = await checkAddress(t.tenantId, "shared@club.test");
    expect(r.holder).toMatchObject({ kind: "user", id: t.staffId, status: "manager" });
    expect(r.holder.version).toMatch(/^[a-f0-9]{64}$/);
  });

  it("moves the staff address, ends their sessions, retires tokens, audits; the address is then free", async () => {
    const before = await user(t.staffId);
    const oldReset = await mint(t.tenantId, "shared@club.test", "reset");
    const oldLink = await mint(t.tenantId, "shared@club.test", "login");
    const newLink = await mint(t.tenantId, "pat.manager@club.test", "first_time_signup");
    const waiver = await mint(t.tenantId, "shared@club.test", "waiver_open");

    const { holder } = await checkAddress(t.tenantId, "shared@club.test");
    const body = { newEmail: "pat.manager@club.test", reason: "Club confirmed by call-back", version: holder.version };
    const grant = await issueGrant("staff.login_email", `${t.tenantId}/${t.staffId}/change`, { newEmail: body.newEmail });
    const res = await moveStaff(operatorRequest(body, grant), { params: Promise.resolve({ id: t.tenantId, userId: t.staffId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toMatchObject({ ok: true, userId: t.staffId, sessionsRevoked: true });
    const after = await checkAddress(t.tenantId, "shared@club.test");
    expect(after.free).toBe(true);

    // The address, a session bump and the unverified stamp — nothing else.
    const now = await user(t.staffId);
    expect(now).toMatchObject({
      email: "pat.manager@club.test",
      role: "manager",
      tenantId: t.tenantId,
      passwordHash: before.passwordHash,
      sessionVersion: before.sessionVersion + 1,
      totpEnabled: before.totpEnabled,
      totpSecret: before.totpSecret,
    });
    expect(now.totpRecoveryCodes).toEqual(before.totpRecoveryCodes);
    expect(now.loginEmailProvisionalSince).not.toBeNull();
    expect((await user(t.ownerId)).email).toBe("owner@club.test");

    // Sign-in tokens for the old AND new address retired; the waiver link kept.
    for (const tok of [oldReset, oldLink, newLink]) expect(await isUsed(tok), tok.purpose).toBe(true);
    expect(await isUsed(waiver)).toBe(false);

    // One outcome row: digests only, never an address.
    const rows = await outcomes(t.staffId);
    expect(rows).toHaveLength(1);
    expect(rows[0].operatorId).toBe(OP_ID);
    expect(rows[0].metadata).toMatchObject({
      reason: "Club confirmed by call-back",
      role: "manager",
      oldEmailDigest: emailDigest("shared@club.test"),
      newEmailDigest: emailDigest("pat.manager@club.test"),
      sessionsRevoked: true,
      unverified: true,
      sessionVersionAfter: before.sessionVersion + 1,
      version: holder.version,
      retired: { resetCodes: 1, signInLinks: 2 },
    });
    expect(JSON.stringify(rows[0].metadata)).not.toContain("@");
  });

  it("re-sending the same grant answers alreadyApplied and changes nothing twice", async () => {
    const staff4 = await makeStaff(t.tenantId, { email: "four@club.test", role: "coach" });
    const { holder } = await checkAddress(t.tenantId, "four@club.test");
    const body = { newEmail: "coach4@club.test", reason: "Club confirmed by call-back", version: holder.version };
    const grant = await issueGrant("staff.login_email", `${t.tenantId}/${staff4}/change`, { newEmail: body.newEmail });
    const first = await moveStaff(operatorRequest(body, grant), { params: Promise.resolve({ id: t.tenantId, userId: staff4 }) });
    expect(first.status).toBe(200);
    const once = await user(staff4);
    const again = await moveStaff(operatorRequest(body, grant), { params: Promise.resolve({ id: t.tenantId, userId: staff4 }) });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, alreadyApplied: true });
    expect(await user(staff4)).toEqual(once);
    expect(await outcomes(staff4)).toHaveLength(1);
  });

  it("refuses the owner with result owner (409) and writes nothing", async () => {
    // A staff.login_email grant cannot even be issued for the owner (the
    // version is null), and the preflight answers before the step-up is read.
    const before = await user(t.ownerId);
    const res = await moveStaff(
      operatorRequest({ newEmail: "x@club.test", reason: "should be refused", version: "0".repeat(64) }),
      { params: Promise.resolve({ id: t.tenantId, userId: t.ownerId }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).result).toBe("owner");
    expect(await user(t.ownerId)).toEqual(before);
    expect(before.email).toBe("owner@club.test");
    expect(await outcomes(t.ownerId)).toHaveLength(0);
  });

  it("refuses a stale version (record changed since the check) with 409 stale", async () => {
    const staff2 = await makeStaff(t.tenantId, { email: "two@club.test", role: "coach" });
    const { holder } = await checkAddress(t.tenantId, "two@club.test");
    await bumpSessionVersion(staff2); // helper: users.sessionVersion += 1
    const grant = await issueGrant("staff.login_email", `${t.tenantId}/${staff2}/change`, { newEmail: "coach2@club.test" });
    const res = await moveStaff(
      operatorRequest({ newEmail: "coach2@club.test", reason: "Club confirmed by call-back", version: holder.version }, grant),
      { params: Promise.resolve({ id: t.tenantId, userId: staff2 }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).result).toBe("stale");
    expect((await user(staff2)).email).toBe("two@club.test");
  });

  it("refuses a target address already held (by a member) with 409 taken", async () => {
    await makeMember(t.tenantId, { email: "held@club.test" });
    const staff3 = await makeStaff(t.tenantId, { email: "three@club.test", role: "coach" });
    const { holder } = await checkAddress(t.tenantId, "three@club.test");
    const grant = await issueGrant("staff.login_email", `${t.tenantId}/${staff3}/change`, { newEmail: "held@club.test" });
    const res = await moveStaff(
      operatorRequest({ newEmail: "held@club.test", reason: "Club confirmed by call-back", version: holder.version }, grant),
      { params: Promise.resolve({ id: t.tenantId, userId: staff3 }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).result).toBe("taken");
    expect((await user(staff3)).email).toBe("three@club.test");
  });

  it("refuses a system-managed (no-login placeholder) target with 400 managed; nothing written", async () => {
    const staff5 = await makeStaff(t.tenantId, { email: "five@club.test", role: "coach" });
    const before = await user(staff5);
    const placeholder = `kid-placeholder@${NO_LOGIN_EMAIL_DOMAIN}`;
    const { holder } = await checkAddress(t.tenantId, "five@club.test");
    const grant = await issueGrant("staff.login_email", `${t.tenantId}/${staff5}/change`, { newEmail: placeholder });
    const res = await moveStaff(
      operatorRequest({ newEmail: placeholder, reason: "Club confirmed by call-back", version: holder.version }, grant),
      { params: Promise.resolve({ id: t.tenantId, userId: staff5 }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).result).toBe("managed");
    expect(await user(staff5)).toEqual(before);
    expect(await outcomes(staff5)).toHaveLength(0);
  });

  it("check lists every holder of a legacy duplicate", async () => {
    await seedDuplicate(t.tenantId, "dup@club.test"); // helper: raw insert of a member + staff on the same canonical address
    const r = await checkAddress(t.tenantId, "dup@club.test");
    expect(r.holder.kind).toBe("many");
    expect(r.holder.holders).toHaveLength(2);
    expect(r.holder.holders!.every((h: { version?: string }) => /^[a-f0-9]{64}$/.test(h.version ?? ""))).toBe(true);
  });

  // ── R14: what a moved staff account can still do, and the recovery ──────────
  describe("R14: staff access after the move, and the club owner's recovery", () => {
    const PW_OWN = `Synthetic-${Date.now()}-Own1`; // synthetic, test-only
    const PW_TEMP_OLD = `Expired-${Date.now()}-Tmp1`;
    const PW_TEMP_NEW = `Recovery-${Date.now()}-Tmp2`;
    const PW_OLD = stampedEmail("r14-pw-old");
    const PW_NEW = stampedEmail("r14-pw-new");
    const EX_OLD = stampedEmail("r14-ex-old");
    const EX_NEW = stampedEmail("r14-ex-new");
    const r = { tenantId: "", slug: "", ownerId: "", pwStaff: "", exStaff: "" };

    const row = (id: string) =>
      withRlsBypass((tx) =>
        tx.user.findUniqueOrThrow({
          where: { id },
          select: {
            email: true, passwordHash: true, sessionVersion: true, mustChangePassword: true,
            tempPasswordExpiresAt: true, loginEmailProvisionalSince: true,
          },
        }),
      );
    // The real Credentials authorize() from auth.ts (resolves the user, or null; throws a coded refusal).
    const signIn = (email: string, password: string) =>
      authState.authorize!({ email, password, tenantSlug: r.slug }, new Request(`${ORIGIN}/api/auth/callback/credentials`));
    const tokensFor = (email: string) =>
      withRlsBypass(async (tx) => ({
        resets: await tx.passwordResetToken.count({ where: { tenantId: r.tenantId, email } }),
        links: await tx.magicLinkToken.count({ where: { tenantId: r.tenantId, email } }),
      }));
    // Refusal rows on these doors are best-effort writes: wait for them.
    const auditCount = (action: string, entityId: string) =>
      withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: r.tenantId, action, entityId } }));
    const expectAuditRow = (action: string, entityId: string) =>
      vi.waitFor(async () => expect(await auditCount(action, entityId)).toBe(1), { timeout: 15_000, interval: 300 });
    const moveTo = async (userId: string, from: string, to: string) => {
      const { holder } = await checkAddress(r.tenantId, from);
      const grant = await issueGrant("staff.login_email", `${r.tenantId}/${userId}/change`, { newEmail: to });
      return moveStaff(
        operatorRequest({ newEmail: to, reason: "Club confirmed by call-back", version: holder.version }, grant),
        { params: Promise.resolve({ id: r.tenantId, userId }) },
      );
    };
    const askReset = (email: string) => forgotPassword(jsonRequest("/api/auth/forgot-password", { email, tenantSlug: r.slug }));
    const askLink = (email: string) => requestMagicLink(jsonRequest("/api/magic-link/request", { email, tenantSlug: r.slug }));

    beforeAll(async () => {
      r.tenantId = await makeTenant("staff-access");
      r.slug = tenantSlug(r.tenantId);
      r.ownerId = await makeOwner(r.tenantId, stampedEmail("r14-owner"), { totpEnabled: true });
      const [own, temp] = await Promise.all([bcrypt.hash(PW_OWN, 4), bcrypt.hash(PW_TEMP_OLD, 4)]);
      const created = await withRlsBypass(async (tx) => ({
        pw: await tx.user.create({
          data: { tenantId: r.tenantId, email: PW_OLD, name: "R14 Password Coach", role: "coach", passwordHash: own },
          select: { id: true },
        }),
        ex: await tx.user.create({
          data: {
            tenantId: r.tenantId, email: EX_OLD, name: "R14 Expired Coach", role: "coach", passwordHash: temp,
            mustChangePassword: true, tempPasswordExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
          },
          select: { id: true },
        }),
      }));
      r.pwStaff = created.pw.id;
      r.exStaff = created.ex.id;
    }, 120_000);

    afterAll(async () => {
      hubState.session = null;
      // Sign-in lockout buckets the successful and refused sign-ins touched
      // (keyed HMACs of club + address [+ client IP]); removed with the run.
      const ip = requestClientIp(new Headers());
      const buckets = [PW_OLD, PW_NEW, EX_OLD, EX_NEW].flatMap((e) => Object.values(lockoutKeys(r.slug, e, ip)));
      await prisma.rateLimitHit.deleteMany({ where: { bucket: { in: buckets } } });
      expect(await prisma.rateLimitHit.count({ where: { bucket: { in: buckets } } })).toBe(0);
    }, 60_000);

    it("a: password-bearing staff — sign-in with the same password at the new address; no reset code, no sign-in link; marked provisional", async () => {
      expect((await checkAddress(r.tenantId, PW_OLD)).holder).toMatchObject({ kind: "user", id: r.pwStaff, access: "password", canSignIn: true });
      const before = await row(r.pwStaff);
      expect(await signIn(PW_OLD, PW_OWN)).toMatchObject({ id: r.pwStaff }); // control: works before the move

      expect((await moveTo(r.pwStaff, PW_OLD, PW_NEW)).status).toBe(200);
      const after = await row(r.pwStaff);
      expect(after.email).toBe(PW_NEW);
      expect(after.loginEmailProvisionalSince).not.toBeNull();
      expect(after).toMatchObject({ passwordHash: before.passwordHash, mustChangePassword: false, tempPasswordExpiresAt: null });

      // The same Credentials authorize() auth.ts runs for a password sign-in.
      expect(await signIn(PW_NEW, PW_OWN)).toMatchObject({ id: r.pwStaff, email: PW_NEW, mustChangePassword: false });

      expect((await askReset(PW_NEW)).status).toBe(200);
      expect((await askLink(PW_NEW)).status).toBe(200);
      expect(await tokensFor(PW_NEW)).toEqual({ resets: 0, links: 0 });
      // Refused by the provisional-address guard (not merely by mail being off).
      await expectAuditRow("auth.password_reset.refused_provisional", r.pwStaff);
      await expectAuditRow("auth.magic_link.refused_provisional", r.pwStaff);
    });

    it("b: expired temporary password — check says no access before the move; after it reset and link are refused and sign-in answers temp_password_expired", async () => {
      expect((await checkAddress(r.tenantId, EX_OLD)).holder).toMatchObject({ kind: "user", id: r.exStaff, access: "none", canSignIn: false });
      await expect(signIn(EX_OLD, PW_TEMP_OLD)).rejects.toMatchObject({ code: "temp_password_expired" }); // already, before the move
      const before = await row(r.exStaff);

      expect((await moveTo(r.exStaff, EX_OLD, EX_NEW)).status).toBe(200);
      const after = await row(r.exStaff);
      expect(after.email).toBe(EX_NEW);
      expect(after.loginEmailProvisionalSince).not.toBeNull();
      expect(after).toMatchObject({
        passwordHash: before.passwordHash,
        mustChangePassword: true,
        tempPasswordExpiresAt: before.tempPasswordExpiresAt,
      });
      expect(after.tempPasswordExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
      await expect(signIn(EX_NEW, PW_TEMP_OLD)).rejects.toMatchObject({ code: "temp_password_expired" });

      expect((await askReset(EX_NEW)).status).toBe(200);
      expect((await askLink(EX_NEW)).status).toBe(200);
      expect(await tokensFor(EX_NEW)).toEqual({ resets: 0, links: 0 });
      // The temporary-password guard answers first on both doors (forgot-password
      // writes no row for it; magic-link records the bootstrap refusal).
      await expectAuditRow("auth.magic_link.refused_bootstrap", r.exStaff);
    });

    it("c: recovery — the club owner (MFA passed) sets a temporary password; the address stays provisional; sign-in works again", async () => {
      const before = await row(r.exStaff);
      expect(before.loginEmailProvisionalSince).not.toBeNull();
      const owner = await withRlsBypass((tx) => tx.user.findUniqueOrThrow({ where: { id: r.ownerId }, select: { sessionVersion: true } }));
      hubState.session = {
        user: {
          id: r.ownerId, tenantId: r.tenantId, role: "owner", sessionVersion: owner.sessionVersion,
          totpEnabled: true, totpPending: false, requireTotpSetup: false, mustChangePassword: false,
        },
      };
      const t0 = Date.now();
      const res = await ownerEditStaff(
        new Request(`${ORIGIN}/api/staff/${r.exStaff}`, {
          method: "PATCH",
          headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json" },
          body: JSON.stringify({ newPassword: PW_TEMP_NEW }),
        }),
        { params: Promise.resolve({ id: r.exStaff }) },
      );
      const t1 = Date.now();
      hubState.session = null;
      expect(res.status).toBe(200);

      const after = await row(r.exStaff);
      expect(after.mustChangePassword).toBe(true);
      expect(after.tempPasswordExpiresAt!.getTime()).toBeGreaterThanOrEqual(t0 + TEMP_PASSWORD_TTL_MS);
      expect(after.tempPasswordExpiresAt!.getTime()).toBeLessThanOrEqual(t1 + TEMP_PASSWORD_TTL_MS);
      expect(after.sessionVersion).toBe(before.sessionVersion + 1);
      expect(after.passwordHash).not.toBe(before.passwordHash);
      expect(after.email).toBe(EX_NEW);
      // Never cleared to make sign-in work.
      expect(after.loginEmailProvisionalSince).toEqual(before.loginEmailProvisionalSince);

      const audit = await withRlsBypass((tx) =>
        tx.auditLog.findMany({ where: { tenantId: r.tenantId, action: "staff.update", entityId: r.exStaff }, select: { userId: true, operatorId: true } }),
      );
      expect(audit).toEqual([{ userId: r.ownerId, operatorId: null }]);

      // The new temporary password signs in (forced change next), the address still provisional.
      expect(await signIn(EX_NEW, PW_TEMP_NEW)).toMatchObject({ id: r.exStaff, mustChangePassword: true });
      expect((await row(r.exStaff)).loginEmailProvisionalSince).toEqual(before.loginEmailProvisionalSince);
    });
  });
});
