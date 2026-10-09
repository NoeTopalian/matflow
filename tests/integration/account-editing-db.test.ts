// Account editing against REAL rows (8 Oct 2026, account-editing lane R).
//
// Disposable clubs on the Neon TEST branch (tests/setup-test-db.ts refuses the
// production endpoint). Runs the real /api/account/profile, /api/account/password
// and operator /api/admin/customers/[id]/owner-profile routes, the real
// Credentials authorize() from auth.ts, the real staff TOTP verify route, the
// real audit writer and the real session-revocation check. Stubbed: NextAuth's
// wrapper (to capture authorize and hand the routes a session), the JWT codec,
// rate limits, CSRF, operator auth/step-up (pinned in unit tests), sign-in
// notifications and mail. Date is faked (Date only) so a second code can use the
// NEXT authenticator time-step without waiting 30 s. Skips without a DB.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";
import bcrypt from "bcryptjs";
import { generateSecret, generateSync } from "otplib";

type Authorize = (c: Record<string, unknown>, r: Request) => Promise<Record<string, unknown> | null>;
const state = vi.hoisted(() => ({
  authorize: undefined as undefined | ((c: Record<string, unknown>, r: Request) => Promise<Record<string, unknown> | null>),
  session: null as null | { user: Record<string, unknown> },
  jwt: null as null | Record<string, unknown>,
  sends: 0,
}));

vi.mock("next-auth", () => ({
  default: (config: { providers: { authorize?: Authorize }[] }) => {
    for (const p of config.providers) if (p?.authorize) state.authorize = p.authorize;
    return { handlers: {}, auth: async () => state.session, signIn: async () => {}, signOut: async () => {} };
  },
  CredentialsSignin: class extends Error { code = "credentials"; },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/providers/google", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/jwt", () => ({ getToken: async () => state.jwt, encode: async () => "jwt" }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: async () => true }));
vi.mock("@/lib/operator-context", () => ({ getOperatorContext: async () => ({ operatorId: "op-int-test", named: true }) }));
vi.mock("@/lib/operator-step-up", () => ({
  // Lane C (9 Oct 2026): requireStepUp returns the verified grant and
  // consumeStepUpGrant spends it inside the route's transaction (both pinned
  // in tests/unit/operator-step-up.test.ts and, on Postgres, in
  // tests/integration/operator-step-up-db.test.ts).
  requireStepUp: async () => ({ operatorId: "op-int-test", sessionVersion: 0, action: "x", targetId: "t", tenantId: "t", versionDigest: "v", requestId: `rq-${Date.now()}-${Math.random()}` }),
  consumeStepUpGrant: async () => ({ kind: "spent" }),
  refuseStepUp: () => new Response(null, { status: 403 }),
  StepUpRefusedError: class StepUpRefusedError extends Error {},
  stepUpTarget: (...parts: (string | undefined)[]) => parts.filter(Boolean).join("/"),
}));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: async () => {} }));
vi.mock("@/lib/testing-mode", () => ({ isTestingMode: () => false }));
vi.mock("@/lib/email", () => ({ sendEmail: async () => { state.sends++; return { ok: true }; } }));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { checkSessionVersion } from "@/lib/session-revocation";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const SLUG_A = `ace-${STAMP}`;
const SLUG_B = `acf-${STAMP}`;
const OWNER = `owner-${STAMP}@ace.test`;
const COACH = `coach-${STAMP}@ace.test`;
const B_OWNER = `owner-${STAMP}@acf.test`;
const PW = `Synthetic-${STAMP}-Pw1`; // synthetic, test-only
const PW2 = `Changed-${STAMP}-Pw2`;
const PW3 = `Another-${STAMP}-Pw3`;
const SECRET = generateSecret();
const FAR = new Date(Date.now() + 24 * 3600 * 1000);

const req = (method: string, url: string, body: unknown) =>
  new Request(url, {
    method,
    headers: { "Content-Type": "application/json", origin: "http://localhost", host: "localhost" },
    body: JSON.stringify(body),
  });

describe.skipIf(!HAS_DB)("account editing on real rows", () => {
  const ids = { a: "", b: "", owner: "", coach: "", bOwner: "" };
  let recoveryCodes: unknown = null;

  const userRow = (id: string) =>
    withRlsBypass((tx) =>
      tx.user.findUnique({
        where: { id },
        select: {
          id: true, tenantId: true, role: true, name: true, email: true, passwordHash: true, sessionVersion: true,
          totpEnabled: true, totpSecret: true, totpRecoveryCodes: true, mustChangePassword: true, loginEmailProvisionalSince: true,
        },
      }),
    );
  const signIn = (email: string, password: string) =>
    state.authorize!({ email, password, tenantSlug: SLUG_A }, new Request("http://localhost/api/auth/callback/credentials"));
  const staffSession = (id: string, role: string, version: number, tenantId = ids.a) => ({
    user: { id, tenantId, role, sessionVersion: version, totpPending: false, mustChangePassword: false, requireTotpSetup: false },
  });
  const nextStep = () => vi.setSystemTime(new Date(Date.now() + 30_000));
  const patchProfile = (body: unknown) =>
    import("@/app/api/account/profile/route").then(({ PATCH }) => PATCH(req("PATCH", "http://localhost/api/account/profile", body)));
  const getProfile = () => import("@/app/api/account/profile/route").then(({ GET }) => GET());
  const changePassword = (body: unknown) =>
    import("@/app/api/account/password/route").then(({ POST }) => POST(req("POST", "http://localhost/api/account/password", body)));
  const liveResets = (email: string) =>
    withRlsBypass((tx) => tx.passwordResetToken.count({ where: { tenantId: ids.a, email, used: false } }));

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    await import("@/auth"); // registers the Credentials provider with the mock
    const hash = await bcrypt.hash(PW, 4);
    await withRlsBypass(async (tx) => {
      ids.a = (await tx.tenant.create({ data: { name: `ACE ${STAMP}`, slug: SLUG_A } })).id;
      ids.b = (await tx.tenant.create({ data: { name: `ACF ${STAMP}`, slug: SLUG_B } })).id;
      const owner = await tx.user.create({
        data: {
          tenantId: ids.a, email: OWNER, name: "Placeholder Owner", role: "owner", passwordHash: hash,
          totpEnabled: true, totpSecret: SECRET, totpRecoveryCodes: ["h1", "h2"], sessionVersion: 4,
        },
      });
      ids.owner = owner.id;
      recoveryCodes = owner.totpRecoveryCodes;
      ids.coach = (await tx.user.create({ data: { tenantId: ids.a, email: COACH, name: "Coach", role: "coach", passwordHash: hash } })).id;
      ids.bOwner = (await tx.user.create({ data: { tenantId: ids.b, email: B_OWNER, name: "Other Club Owner", role: "owner", passwordHash: hash } })).id;
      // An outstanding reset code for the owner, as if requested before the change.
      await tx.passwordResetToken.create({ data: { tenantId: ids.a, email: OWNER, tokenHash: `prt-acc-${STAMP}`, expiresAt: FAR } });
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    await withRlsBypass(async (tx) => {
      const tenants = [ids.a, ids.b].filter(Boolean);
      await tx.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.passwordResetToken.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.magicLinkToken.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.passwordHistory.deleteMany({ where: { userId: { in: [ids.owner, ids.coach, ids.bOwner].filter(Boolean) } } });
      await tx.member.deleteMany({ where: { tenantId: { in: tenants } } }); // lane S-staff's collision member
      await tx.user.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.tenant.deleteMany({ where: { id: { in: tenants } } });
    });
  });

  // ── C1: own profile ──────────────────────────────────────────────────────
  it("profile: the owner's own name is saved, persists on re-read, audited before/after; nothing else moves", async () => {
    const before = (await userRow(ids.owner))!;
    state.session = staffSession(ids.owner, "owner", before.sessionVersion);
    state.jwt = { id: ids.owner, name: before.name, sessionVersion: before.sessionVersion };
    const res = await patchProfile({ name: "  Corrected Owner  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "Corrected Owner", sessionRefreshed: true });
    const after = (await userRow(ids.owner))!;
    expect(after.name).toBe("Corrected Owner");
    expect({ ...after, name: before.name }).toEqual(before); // only the name changed
    const reread = await (await getProfile()).json();
    expect(reread.name).toBe("Corrected Owner");
    const audit = await withRlsBypass((tx) =>
      tx.auditLog.findFirst({ where: { tenantId: ids.a, action: "user.profile.updated", entityId: ids.owner } }),
    );
    expect(audit?.userId).toBe(ids.owner);
    expect(audit?.metadata).toMatchObject({ changed: ["name"], before: { name: "Placeholder Owner" }, after: { name: "Corrected Owner" } });
  });

  it("profile: extra keys (role, tenantId, email, totpEnabled) are refused with nothing written", async () => {
    const before = (await userRow(ids.owner))!;
    for (const extra of [{ role: "coach" }, { tenantId: ids.b }, { email: "x@ace.test" }, { totpEnabled: false }]) {
      const res = await patchProfile({ name: "Hijacked", ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await userRow(ids.owner)).toEqual(before);
  });

  it("profile: a session whose id is not in its tenant (cross-tenant forgery) changes nothing", async () => {
    // Club A's owner id presented with club B's tenant: no row matches id+tenant.
    state.session = staffSession(ids.owner, "owner", 0, ids.b);
    const res = await patchProfile({ name: "Cross Tenant" });
    expect(res.status).toBe(401);
    expect((await userRow(ids.owner))!.name).toBe("Corrected Owner");
    expect((await userRow(ids.bOwner))!.name).toBe("Other Club Owner");
  });

  // ── C2: own password ─────────────────────────────────────────────────────
  it("password: a wrong current password is refused and does not spend the code", async () => {
    const before = (await userRow(ids.owner))!;
    state.session = staffSession(ids.owner, "owner", before.sessionVersion);
    const code = generateSync({ secret: SECRET });
    const res = await changePassword({ currentPassword: "Wrong-Password-1", newPassword: PW2, totpCode: code });
    expect(res.status).toBe(400);
    expect((await userRow(ids.owner))!.passwordHash).toBe(before.passwordHash);
    // Same code still good for a correct attempt? Not tried here: the next test uses the next step.
  });

  it("password: a wrong code is refused, nothing changed", async () => {
    const before = (await userRow(ids.owner))!;
    const code = generateSync({ secret: SECRET });
    const res = await changePassword({ currentPassword: PW, newPassword: PW2, totpCode: code === "000000" ? "111111" : "000000" });
    expect(res.status).toBe(400);
    expect((await userRow(ids.owner))!.passwordHash).toBe(before.passwordHash);
  });

  it("password: change — same id/email/role/tenant/factor/codes; history row; version+1; reset code retired; audited", async () => {
    nextStep();
    const before = (await userRow(ids.owner))!;
    state.session = staffSession(ids.owner, "owner", before.sessionVersion);
    const historyBefore = await withRlsBypass((tx) => tx.passwordHistory.count({ where: { userId: ids.owner } }));
    expect(await liveResets(OWNER)).toBe(1);
    const res = await changePassword({ currentPassword: PW, newPassword: PW2, totpCode: generateSync({ secret: SECRET }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, signInAgain: true });
    const r = (await userRow(ids.owner))!;
    expect(await bcrypt.compare(PW2, r.passwordHash)).toBe(true);
    expect(r.id).toBe(ids.owner);
    expect(r.email).toBe(OWNER);
    expect(r.role).toBe("owner");
    expect(r.tenantId).toBe(ids.a);
    expect(r.totpEnabled).toBe(true);
    expect(r.totpSecret).toBe(before.totpSecret);
    expect(r.totpRecoveryCodes).toEqual(recoveryCodes);
    expect(r.sessionVersion).toBe(before.sessionVersion + 1);
    const history = await withRlsBypass((tx) =>
      tx.passwordHistory.findMany({ where: { userId: ids.owner }, orderBy: { createdAt: "desc" } }),
    );
    expect(history.length).toBe(historyBefore + 1);
    expect(await bcrypt.compare(PW, history[0].passwordHash)).toBe(true);
    expect(await liveResets(OWNER)).toBe(0);
    expect(await checkSessionVersion({ userId: ids.owner, tokenVersion: before.sessionVersion })).toBe("revoked");
    const audit = await withRlsBypass((tx) =>
      tx.auditLog.findFirst({ where: { tenantId: ids.a, action: "user.password.changed", entityId: ids.owner } }),
    );
    expect(audit).not.toBeNull();
    const meta = JSON.stringify(audit!.metadata);
    expect(meta).not.toContain(PW);
    expect(meta).not.toContain(PW2);
    expect(meta).not.toContain("$2");
  });

  it("password: after — the old password fails; the new one signs in and the authenticator is still owed", async () => {
    expect(await signIn(OWNER, PW)).toBeNull();
    const u = await signIn(OWNER, PW2);
    expect(u?.id).toBe(ids.owner);
    expect(u?.totpPending).toBe(true);
    const { POST } = await import("@/app/api/auth/totp/verify/route");
    // SF-37 (lane A2): the verify route checks revocation; a real token carries the live version.
    state.jwt = { id: ids.owner, tenantId: ids.a, totpPending: true, sessionVersion: (await withRlsBypass((tx) => tx.user.findUniqueOrThrow({ where: { id: ids.owner }, select: { sessionVersion: true } }))).sessionVersion };
    nextStep(); // the change spent the previous step's code
    const ok = await POST(req("POST", "http://localhost/api/auth/totp/verify", { code: generateSync({ secret: SECRET }) }) as never);
    expect(ok.status).toBe(200);
  });

  it("password: a replayed code is refused (single use, shared with sign-in verify)", async () => {
    // The verify above spent this step's code.
    const v = (await userRow(ids.owner))!.sessionVersion;
    state.session = staffSession(ids.owner, "owner", v);
    const res = await changePassword({ currentPassword: PW2, newPassword: PW3, totpCode: generateSync({ secret: SECRET }) });
    expect(res.status).toBe(400);
    expect(await bcrypt.compare(PW2, (await userRow(ids.owner))!.passwordHash)).toBe(true);
  });

  it("password: the previous password cannot be reused", async () => {
    nextStep();
    const res = await changePassword({ currentPassword: PW2, newPassword: PW, totpCode: generateSync({ secret: SECRET }) });
    expect(res.status).toBe(400);
    expect(await bcrypt.compare(PW2, (await userRow(ids.owner))!.passwordHash)).toBe(true);
  });

  it("password: a temporary-password row is refused (that is /set-password's job)", async () => {
    await withRlsBypass((tx) => tx.user.update({ where: { id: ids.coach }, data: { mustChangePassword: true } }));
    state.session = staffSession(ids.coach, "coach", 0);
    const res = await changePassword({ currentPassword: PW, newPassword: PW2 });
    expect(res.status).toBe(403);
    await withRlsBypass((tx) => tx.user.update({ where: { id: ids.coach }, data: { mustChangePassword: false } }));
  });

  it("password: a coach without an authenticator changes it with the current password alone", async () => {
    const before = (await userRow(ids.coach))!;
    state.session = staffSession(ids.coach, "coach", before.sessionVersion);
    const res = await changePassword({ currentPassword: PW, newPassword: PW3 });
    expect(res.status).toBe(200);
    const r = (await userRow(ids.coach))!;
    expect(await bcrypt.compare(PW3, r.passwordHash)).toBe(true);
    expect(r.sessionVersion).toBe(before.sessionVersion + 1);
    expect(await signIn(COACH, PW)).toBeNull();
    expect((await signIn(COACH, PW3))?.id).toBe(ids.coach);
  });

  // ── C4: operator owner-name correction ──────────────────────────────────
  it("operator: corrects the owner's name; audited with before/after and the operator as actor; sessions untouched", async () => {
    const { POST } = await import("@/app/api/admin/customers/[id]/owner-profile/route");
    const before = (await userRow(ids.owner))!;
    const ctx = { params: Promise.resolve({ id: ids.a }) };
    const refused = await POST(req("POST", "http://localhost/x", { name: "Op Name", reason: "integration test", password: "x" }), ctx);
    expect(refused.status).toBe(400);
    const res = await POST(req("POST", "http://localhost/x", { name: "Operator Corrected", reason: "integration test correction" }), ctx);
    expect(res.status).toBe(200);
    const r = (await userRow(ids.owner))!;
    expect(r.name).toBe("Operator Corrected");
    expect({ ...r, name: before.name }).toEqual(before);
    const audit = await withRlsBypass((tx) =>
      tx.auditLog.findFirst({ where: { tenantId: ids.a, action: "admin.owner.profile.updated", entityId: ids.owner } }),
    );
    expect(audit?.metadata).toMatchObject({
      before: { name: "Corrected Owner" }, after: { name: "Operator Corrected" }, actingAs: "op-int-test",
    });
    // Club B's owner untouched.
    expect((await userRow(ids.bOwner))!.name).toBe("Other Club Owner");
    expect(state.sends).toBe(0);
  });

  // ── S: owner edits a staff member (PATCH /api/staff/[id]), lane S-staff ──
  it("owner edits staff email: member collision refused opaquely; change saved provisional, tokens retired, signed out, digests only", async () => {
    const { PATCH } = await import("@/app/api/staff/[id]/route");
    const { emailDigest } = await import("@/lib/login-email");
    const MEMBER = `member-${STAMP}@ace.test`;
    const NEW = `coach-new-${STAMP}@ace.test`;
    await withRlsBypass(async (tx) => {
      await tx.member.create({ data: { tenantId: ids.a, name: "Club Member", email: MEMBER } });
      await tx.passwordResetToken.create({ data: { tenantId: ids.a, email: COACH, tokenHash: `prt-staff-old-${STAMP}`, expiresAt: FAR } });
      await tx.passwordResetToken.create({ data: { tenantId: ids.a, email: NEW, tokenHash: `prt-staff-new-${STAMP}`, expiresAt: FAR } });
      await tx.magicLinkToken.create({ data: { tenantId: ids.a, email: COACH, tokenHash: `mlt-staff-old-${STAMP}`, purpose: "login", expiresAt: FAR } });
    });
    state.session = staffSession(ids.owner, "owner", (await userRow(ids.owner))!.sessionVersion);
    const ctx = { params: Promise.resolve({ id: ids.coach }) };
    const patchStaff = (body: unknown) => PATCH(req("PATCH", `http://localhost/api/staff/${ids.coach}`, body), ctx);
    const before = (await userRow(ids.coach))!;

    const clash = await patchStaff({ email: MEMBER });
    expect(clash.status).toBe(409);
    expect(JSON.stringify(await clash.json())).not.toMatch(/member|staff/i);
    expect(await userRow(ids.coach)).toEqual(before);
    expect(await liveResets(COACH)).toBe(1);

    const res = await patchStaff({ email: NEW });
    expect(res.status).toBe(200);
    const r = (await userRow(ids.coach))!;
    expect(r.email).toBe(NEW);
    expect(r.loginEmailProvisionalSince).not.toBeNull();
    expect(r.sessionVersion).toBe(before.sessionVersion + 1);
    // id, club, role, name, password and factor untouched.
    expect({ ...r, email: before.email, loginEmailProvisionalSince: null, sessionVersion: before.sessionVersion }).toEqual(before);
    expect(await liveResets(COACH)).toBe(0);
    expect(await liveResets(NEW)).toBe(0);
    expect(await withRlsBypass((tx) => tx.magicLinkToken.count({ where: { tenantId: ids.a, email: COACH, used: false } }))).toBe(0);
    expect(await checkSessionVersion({ userId: ids.coach, tokenVersion: before.sessionVersion })).toBe("revoked");
    expect(await signIn(COACH, PW3)).toBeNull(); // the old address no longer signs in
    expect((await signIn(NEW, PW3))?.id).toBe(ids.coach);

    const audit = await withRlsBypass((tx) =>
      tx.auditLog.findFirst({ where: { tenantId: ids.a, action: "staff.update", entityId: ids.coach }, orderBy: { createdAt: "desc" } }),
    );
    expect(audit?.userId).toBe(ids.owner);
    const meta = JSON.stringify(audit!.metadata);
    expect(meta).not.toContain(COACH);
    expect(meta).not.toContain(NEW);
    expect(audit!.metadata).toMatchObject({ oldEmailSha256: emailDigest(COACH), newEmailSha256: emailDigest(NEW), provisional: true });
    expect(state.sends).toBe(0);
  });

  it("owner edits staff: weak temporary password refused; strong one is temporary; another club's owner gets 404", async () => {
    const { PATCH } = await import("@/app/api/staff/[id]/route");
    const ctx = { params: Promise.resolve({ id: ids.coach }) };
    const before = (await userRow(ids.coach))!;
    state.session = staffSession(ids.bOwner, "owner", 0, ids.b);
    const cross = await PATCH(req("PATCH", "http://localhost/x", { name: "Hijacked", newPassword: "TempPass1234X" }), ctx);
    expect(cross.status).toBe(404);
    expect(await userRow(ids.coach)).toEqual(before);

    state.session = staffSession(ids.owner, "owner", (await userRow(ids.owner))!.sessionVersion);
    const weak = await PATCH(req("PATCH", "http://localhost/x", { newPassword: "weakpass1" }), ctx);
    expect(weak.status).toBe(400);
    expect(await userRow(ids.coach)).toEqual(before);

    const ok = await PATCH(req("PATCH", "http://localhost/x", { newPassword: "TempPass1234X" }), ctx);
    expect(ok.status).toBe(200);
    const r = (await userRow(ids.coach))!;
    expect(await bcrypt.compare("TempPass1234X", r.passwordHash)).toBe(true);
    expect(r.mustChangePassword).toBe(true);
    expect(r.sessionVersion).toBe(before.sessionVersion + 1);
    const audit = await withRlsBypass((tx) =>
      tx.auditLog.findFirst({ where: { tenantId: ids.a, action: "staff.update", entityId: ids.coach }, orderBy: { createdAt: "desc" } }),
    );
    expect(JSON.stringify(audit!.metadata)).not.toContain("TempPass1234X");
  });
});
