// Login-email change and rollback against REAL rows (7 Oct 2026, US-001/US-002).
//
// Disposable clubs on the Neon TEST branch (tests/setup-test-db.ts refuses the
// production endpoint). Runs the real self-service route, the real operator
// route, the real Credentials authorize() from auth.ts, the real staff TOTP
// verify route, the real forgot-password and magic-link request doors, the
// real audit writer and the real session-revocation check. Stubbed: NextAuth's
// wrapper (to capture authorize and hand the route a session), the JWT codec,
// rate limits, CSRF, operator auth/step-up (pinned in unit tests), sign-in
// notifications and mail. Date is faked (Date only) so a second change can use
// the NEXT authenticator time-step without waiting 30 s. Skips without a DB.

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
const SLUG_A = `pla-${STAMP}`;
const SLUG_B = `plb-${STAMP}`;
const OLD = `owner-${STAMP}@pla.test`;
const NEW = `real-${STAMP}@plb.test`; // ALSO a login in club B: allowed (login is per club)
const COACH = `coach-${STAMP}@pla.test`;
const MEMBER = `member-${STAMP}@pla.test`;
const PW = `Synthetic-${STAMP}-Pw1`; // synthetic, test-only
const SECRET = generateSecret();
const FAR = new Date(Date.now() + 24 * 3600 * 1000);

const post = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost", host: "localhost" },
    body: JSON.stringify(body),
  });

describe.skipIf(!HAS_DB)("login-email change + rollback on real rows", () => {
  const ids = { a: "", b: "", owner: "", coach: "", bUser: "", member: "" };
  let recoveryCodes: unknown = null;
  let historyCount = 0;

  const ownerRow = () =>
    withRlsBypass((tx) =>
      tx.user.findUnique({
        where: { id: ids.owner },
        select: {
          id: true, tenantId: true, role: true, email: true, passwordHash: true, sessionVersion: true,
          totpEnabled: true, totpSecret: true, totpRecoveryCodes: true, loginEmailProvisionalSince: true,
        },
      }),
    );
  const liveTokens = (email: string) =>
    withRlsBypass(async (tx) => ({
      resets: await tx.passwordResetToken.count({ where: { tenantId: ids.a, email, used: false } }),
      links: await tx.magicLinkToken.count({
        where: { tenantId: ids.a, email, used: false, purpose: { in: ["login", "first_time_signup"] } },
      }),
    }));
  const signIn = (email: string) =>
    state.authorize!({ email, password: PW, tenantSlug: SLUG_A }, new Request("http://localhost/api/auth/callback/credentials"));
  const changeOwn = (newEmail: string, code = generateSync({ secret: SECRET })) =>
    import("@/app/api/account/login-email/route").then(({ POST }) =>
      POST(post("http://localhost/api/account/login-email", { newEmail, currentPassword: PW, totpCode: code })),
    );
  const ownerSession = (version: number) => ({
    user: { id: ids.owner, tenantId: ids.a, role: "owner", sessionVersion: version, totpPending: false, mustChangePassword: false, requireTotpSetup: false },
  });
  const nextStep = () => vi.setSystemTime(new Date(Date.now() + 30_000));

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    await import("@/auth"); // registers the Credentials provider with the mock
    const hash = await bcrypt.hash(PW, 4);
    await withRlsBypass(async (tx) => {
      ids.a = (await tx.tenant.create({ data: { name: `PLA ${STAMP}`, slug: SLUG_A } })).id;
      ids.b = (await tx.tenant.create({ data: { name: `PLB ${STAMP}`, slug: SLUG_B } })).id;
      const owner = await tx.user.create({
        data: {
          tenantId: ids.a, email: OLD, name: "Owner", role: "owner", passwordHash: hash,
          totpEnabled: true, totpSecret: SECRET, totpRecoveryCodes: ["h1", "h2"], sessionVersion: 2,
          loginEmailProvisionalSince: new Date(),
        },
      });
      ids.owner = owner.id;
      recoveryCodes = owner.totpRecoveryCodes;
      await tx.passwordHistory.create({ data: { userId: owner.id, passwordHash: "$2a$04$historicalhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" } });
      ids.coach = (await tx.user.create({ data: { tenantId: ids.a, email: COACH, name: "Coach", role: "coach", passwordHash: hash } })).id;
      ids.member = (await tx.member.create({ data: { tenantId: ids.a, name: "Member", email: MEMBER } })).id;
      ids.bUser = (await tx.user.create({ data: { tenantId: ids.b, email: NEW, name: "Other club owner", role: "owner", passwordHash: hash } })).id;
      // Outstanding tokens for BOTH addresses, as if requested before the change.
      for (const email of [OLD, NEW]) {
        await tx.passwordResetToken.create({ data: { tenantId: ids.a, email, tokenHash: `prt-${email}-${STAMP}`, expiresAt: FAR } });
        await tx.magicLinkToken.create({ data: { tenantId: ids.a, email, tokenHash: `mlt-${email}-${STAMP}`, purpose: "login", expiresAt: FAR } });
      }
    });
    historyCount = await withRlsBypass((tx) => tx.passwordHistory.count({ where: { userId: ids.owner } }));
    state.session = ownerSession(2);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await withRlsBypass(async (tx) => {
      const tenants = [ids.a, ids.b].filter(Boolean);
      await tx.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.passwordResetToken.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.magicLinkToken.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.passwordHistory.deleteMany({ where: { userId: { in: [ids.owner, ids.coach, ids.bUser].filter(Boolean) } } });
      await tx.member.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.user.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.tenant.deleteMany({ where: { id: { in: tenants } } });
    });
  });

  it("before: the old address signs in (password, then TOTP owed)", async () => {
    const u = await signIn(OLD);
    expect(u?.id).toBe(ids.owner);
    expect(u?.totpPending).toBe(true);
  });

  it("a collision with another staff user of the club is refused (409), nothing changes", async () => {
    const res = await changeOwn(COACH);
    expect(res.status).toBe(409);
    expect((await ownerRow())!.email).toBe(OLD);
    nextStep(); // the refused attempt spent that step's code
  });

  it("a collision with a member of the club is refused (409)", async () => {
    const res = await changeOwn(MEMBER);
    expect(res.status).toBe(409);
    expect((await ownerRow())!.email).toBe(OLD);
    nextStep();
  });

  it("change: same id/role/tenant/factor/codes/password, provisional, version+1, tokens retired, audited", async () => {
    const before = (await ownerRow())!;
    const res = await changeOwn(NEW);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, signInAgain: true, provisional: true });
    const r = (await ownerRow())!;
    expect(r.email).toBe(NEW);
    expect(r.id).toBe(ids.owner);
    expect(r.role).toBe("owner");
    expect(r.tenantId).toBe(ids.a);
    expect(r.totpEnabled).toBe(true);
    expect(r.totpSecret).toBe(before.totpSecret);
    expect(r.totpRecoveryCodes).toEqual(recoveryCodes);
    expect(r.passwordHash).toBe(before.passwordHash);
    expect(r.loginEmailProvisionalSince).not.toBeNull();
    expect(r.sessionVersion).toBe(before.sessionVersion + 1);
    expect(await withRlsBypass((tx) => tx.passwordHistory.count({ where: { userId: ids.owner } }))).toBe(historyCount);
    expect(await liveTokens(OLD)).toEqual({ resets: 0, links: 0 });
    expect(await liveTokens(NEW)).toEqual({ resets: 0, links: 0 });
    expect(await checkSessionVersion({ userId: ids.owner, tokenVersion: before.sessionVersion })).toBe("revoked");
    const audit = await withRlsBypass((tx) =>
      tx.auditLog.findFirst({ where: { tenantId: ids.a, action: "user.login_email.changed", entityId: ids.owner }, orderBy: { createdAt: "desc" } }),
    );
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit!.metadata)).not.toContain("@");
    // Club B's user with the same address is untouched.
    const bUser = await withRlsBypass((tx) => tx.user.findUnique({ where: { id: ids.bUser }, select: { email: true, tenantId: true } }));
    expect(bUser).toEqual({ email: NEW, tenantId: ids.b });
  });

  it("after: the old address cannot sign in; the new one can, same user id, TOTP still owed", async () => {
    expect(await signIn(OLD)).toBeNull();
    const u = await signIn(NEW);
    expect(u?.id).toBe(ids.owner);
    expect(u?.tenantId).toBe(ids.a);
    expect(u?.totpPending).toBe(true);
  });

  it("after: the same authenticator completes the sign-in for the new address", async () => {
    const { POST } = await import("@/app/api/auth/totp/verify/route");
    state.jwt = { id: ids.owner, tenantId: ids.a, totpPending: true };
    // The change above spent this time-step's code (single use, shared with
    // /api/auth/totp/verify via totpLastUsedStep): the person waits for the
    // authenticator's NEXT code, exactly as the signed-out panel tells them.
    nextStep();
    const bad = await POST(post("http://localhost/api/auth/totp/verify", { code: "000000" === generateSync({ secret: SECRET }) ? "111111" : "000000" }) as never);
    expect(bad.status).toBe(400);
    const ok = await POST(post("http://localhost/api/auth/totp/verify", { code: generateSync({ secret: SECRET }) }) as never);
    expect(ok.status).toBe(200);
  });

  it("after: the provisional new address gets no reset code and no sign-in link (opaque 200)", async () => {
    const sendsBefore = state.sends;
    const { POST: forgot } = await import("@/app/api/auth/forgot-password/route");
    const f = await forgot(post("http://localhost/api/auth/forgot-password", { email: NEW, tenantSlug: SLUG_A }));
    expect(f.status).toBe(200);
    expect(await f.json()).toEqual({ ok: true });
    const { POST: link } = await import("@/app/api/magic-link/request/route");
    const l = await link(post("http://localhost/api/magic-link/request", { email: NEW, tenantSlug: SLUG_A }));
    expect(l.status).toBe(200);
    expect(await liveTokens(NEW)).toEqual({ resets: 0, links: 0 });
    expect(state.sends).toBe(sendsBefore);
  });

  it("rollback: change back with a fresh code — old works, new fails, same guarantees", async () => {
    nextStep();
    const before = (await ownerRow())!;
    state.session = ownerSession(before.sessionVersion);
    const res = await changeOwn(OLD);
    expect(res.status).toBe(200);
    const r = (await ownerRow())!;
    expect(r.email).toBe(OLD);
    expect(r.id).toBe(ids.owner);
    expect(r.totpSecret).toBe(before.totpSecret);
    expect(r.totpRecoveryCodes).toEqual(recoveryCodes);
    expect(r.sessionVersion).toBe(before.sessionVersion + 1);
    expect(r.loginEmailProvisionalSince).not.toBeNull();
    expect(await signIn(NEW)).toBeNull();
    expect((await signIn(OLD))?.id).toBe(ids.owner);
    expect((await signIn(OLD))?.totpPending).toBe(true);
    expect(await checkSessionVersion({ userId: ids.owner, tokenVersion: before.sessionVersion })).toBe("revoked");
  });

  it("the same code cannot be replayed for another change", async () => {
    nextStep();
    const code = generateSync({ secret: SECRET });
    const v = (await ownerRow())!.sessionVersion;
    state.session = ownerSession(v);
    expect((await changeOwn(NEW, code)).status).toBe(200);
    state.session = ownerSession(v + 1);
    expect((await changeOwn(OLD, code)).status).toBe(400);
    expect((await ownerRow())!.email).toBe(NEW);
    // Put it back for the operator checks.
    nextStep();
    state.session = ownerSession(v + 1);
    expect((await changeOwn(OLD)).status).toBe(200);
  });

  it("operator: confirm (attestation) clears the mark and is audited; mark sets it again", async () => {
    const { POST } = await import("@/app/api/admin/customers/[id]/login-email/route");
    const ctx = { params: Promise.resolve({ id: ids.a }) };
    const clear = await POST(post("http://localhost/x", { action: "clear_provisional", reason: "integration test attestation", attestMailboxVerified: true }), ctx);
    expect(clear.status).toBe(200);
    expect((await ownerRow())!.loginEmailProvisionalSince).toBeNull();
    const mark = await POST(post("http://localhost/x", { action: "mark_provisional", reason: "integration test re-mark" }), ctx);
    expect(mark.status).toBe(200);
    expect((await ownerRow())!.loginEmailProvisionalSince).not.toBeNull();
    const rows = await withRlsBypass((tx) =>
      tx.auditLog.findMany({ where: { tenantId: ids.a, action: { startsWith: "admin.owner.login_email." } }, select: { action: true } }),
    );
    expect(rows.map((r) => r.action).sort()).toEqual([
      "admin.owner.login_email.cleared_provisional",
      "admin.owner.login_email.marked_provisional",
    ]);
  });

  it("operator: change refuses a member's address in the club (409) and allows another club's (200), then rolls back", async () => {
    const { POST } = await import("@/app/api/admin/customers/[id]/login-email/route");
    const ctx = { params: Promise.resolve({ id: ids.a }) };
    expect((await POST(post("http://localhost/x", { action: "change", reason: "integration test change", newEmail: MEMBER }), ctx)).status).toBe(409);
    expect((await POST(post("http://localhost/x", { action: "change", reason: "integration test change", newEmail: NEW }), ctx)).status).toBe(200);
    expect((await ownerRow())!.email).toBe(NEW);
    expect((await POST(post("http://localhost/x", { action: "change", reason: "integration test rollback", newEmail: OLD }), ctx)).status).toBe(200);
    expect((await ownerRow())!.email).toBe(OLD);
    expect((await signIn(OLD))?.id).toBe(ids.owner);
  });
});
