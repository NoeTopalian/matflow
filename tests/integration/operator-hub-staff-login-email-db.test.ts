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

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

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
vi.mock("@/auth", async () => {
  const { hubState: s } = await import("./helpers/operator-hub-state");
  return { auth: vi.fn(async () => s.session), signIn: vi.fn(), signOut: vi.fn(), handlers: {} };
});

import { withRlsBypass } from "@/lib/prisma-tenant";
import { emailDigest } from "@/lib/login-email";
import { NO_LOGIN_EMAIL_DOMAIN } from "@/lib/synthesise-kid-email";
import {
  OP_ID,
  bumpSessionVersion,
  checkAddress,
  cleanup,
  isUsed,
  issueGrant,
  makeMember,
  makeOwner,
  makeStaff,
  makeTenant,
  mint,
  operatorRequest,
  seedDuplicate,
} from "./helpers/operator-hub";
import { POST as moveStaff } from "@/app/api/admin/customers/[id]/staff/[userId]/login-email/route";

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
});
