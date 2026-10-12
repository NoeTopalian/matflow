// Admin hub conflict workflow against a REAL database — the Neon TEST branch
// only (admin hub lane F, 9 Oct 2026; ledger AH-04, story I3; token
// retirement AH-08). Synthetic club: the owner should sign in with an address
// an IMPORTED, passwordless member already holds (with a live invite to it).
//
// Drives the real routes in sequence, as the operator console does:
//   check (held by the member) → the club-facing 409 stays opaque →
//   member contact change (step-up) → lost-response re-send (alreadyApplied) →
//   re-check (free) → owner login change (separate step-up) →
//   the old links cannot set a password for the address's next holder →
//   another club's identical address untouched;
// and two concurrent submissions of one grant on two connections → ONE
// change, ONE sessionVersion bump, ONE outcome row.
//
// Token retirement is the same set of assertions as
// tests/integration/token-scoping-db.test.ts (lane D), driven through the hub
// route instead of the owner PATCH: reset + login + first_time_signup retired
// for the old AND new address in this club (a mixed-case insert included),
// waiver_open kept, the other club untouched, passwordless stays passwordless,
// the hash untouched.
//
// Runs only via the guarded runners (scratchpad att/run-engine.sh and
// q78/run-restricted.sh refuse any host but the test branch). Synthetic ids
// with a unique stamp; everything deleted in afterAll. The fixtures (operator
// session, grants, clubs, people, tokens, cleanup) are shared with the other
// hub suites: tests/integration/helpers/operator-hub.ts.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";

vi.hoisted(() => {
  process.env.AUTH_SECRET ??= "operator-hub-conflict-db-test-secret-0123456789abcdef";
});

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

import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { STEP_UP_HEADER } from "@/lib/operator-step-up";
import { emailDigest } from "@/lib/login-email";
import { POST as contactRoute } from "@/app/api/admin/customers/[id]/members/[memberId]/contact-email/route";
import { POST as ownerRoute } from "@/app/api/admin/customers/[id]/login-email/route";
import { POST as staffCreate } from "@/app/api/staff/route";
import { POST as acceptInvite } from "@/app/api/members/accept-invite/route";
import { POST as resetPassword } from "@/app/api/auth/reset-password/route";
import { hubState } from "./helpers/operator-hub-state";
import {
  OP_ID,
  STAMP,
  checkResponse,
  cleanup,
  isUsed,
  issueGrant,
  jsonRequest as req,
  makeMember,
  makeOwner,
  makeTenant,
  mint,
  read,
  stampedEmail as E,
  tenantSlug,
  type Minted,
} from "./helpers/operator-hub";

const HAS_DB = !!process.env.DATABASE_URL;
const TARGET = E("owner-real"); // the owner's intended login address, held by Pat today
const PAT_NEW = E("pat-personal");
const SYNTHETIC_PASSWORD = `Synthetic-${STAMP}-Aa1`;
const REASON = "verified with the club by call-back to the number on file; synthetic ticket";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const nonceOf = (grant: string) =>
  (JSON.parse(Buffer.from(grant.split(".")[0], "base64url").toString("utf8")) as { n: string }).n;

describe.skipIf(!HAS_DB)("hub conflict workflow on the database (AH-04)", () => {
  const ids = { a: "", aSlug: "", b: "", owner: "", pat: "", patB: "", quin: "" };
  const tA: Record<string, Minted> = {};
  const tB: Record<string, Minted> = {};
  let patBefore: Record<string, unknown> = {};
  let memberGrant = "";
  let checkVersion = "";

  const member = (id: string) =>
    withRlsBypass((tx) =>
      tx.member.findUniqueOrThrow({
        where: { id },
        select: { email: true, passwordHash: true, externalRef: true, status: true, sessionVersion: true, totpEnabled: true, name: true, tenantId: true },
      }),
    );
  const owner = () =>
    withRlsBypass((tx) =>
      tx.user.findUniqueOrThrow({ where: { id: ids.owner }, select: { email: true, passwordHash: true, sessionVersion: true, loginEmailProvisionalSince: true, role: true, totpSecret: true, totpRecoveryCodes: true } }),
    );
  const rows = (action: string) =>
    withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId: ids.a, action }, select: { requestId: true, operatorId: true, entityId: true, metadata: true } }));
  const nonceHash = async () => (await prisma.operator.findUnique({ where: { id: OP_ID }, select: { stepUpNonceHash: true } }))?.stepUpNonceHash ?? null;

  const check = async (email: string) => read(await checkResponse(ids.a, email));
  const contact = async (memberId: string, body: unknown, grant: string) =>
    read(
      await contactRoute(req(`/api/admin/customers/${ids.a}/members/${memberId}/contact-email`, body, { [STEP_UP_HEADER]: grant }), {
        params: Promise.resolve({ id: ids.a, memberId }),
      }),
    );

  beforeAll(async () => {
    ids.a = await makeTenant("A");
    ids.aSlug = tenantSlug(ids.a);
    ids.b = await makeTenant("B");
    ids.owner = await makeOwner(ids.a, E("owner-placeholder"), {
      totpEnabled: true,
      totpSecret: "synthetic",
      totpRecoveryCodes: ["synthetic-code-hash-1", "synthetic-code-hash-2"],
    });
    // Imported, passwordless, holds the owner's intended address.
    ids.pat = await makeMember(ids.a, { name: "Pat Imported", email: TARGET, externalRef: `teamup:${STAMP}:pat` });
    // Same address in another club: another person.
    ids.patB = await makeMember(ids.b, { name: "Pat Imported", email: TARGET, externalRef: `teamup:${STAMP}:pat` });
    // A member who can sign in (for the concurrency case).
    ids.quin = await makeMember(ids.a, { name: "Quin Active", email: E("quin"), passwordHash: "quin-hash-unchanged" });
    for (const p of ["reset", "login", "first_time_signup", "waiver_open"] as const) {
      tA[p] = await mint(ids.a, TARGET, p);
      tB[p] = await mint(ids.b, TARGET, p);
    }
    tA.mixed = await mint(ids.a, TARGET.toUpperCase(), "login");
    tA.staleNew = await mint(ids.a, PAT_NEW, "first_time_signup");
    patBefore = await member(ids.pat);
  }, 120_000);

  afterAll(cleanup, 120_000);

  it("1. check: the member holds the address and can ACTIVATE (live invite); the check row has columns and a keyed digest only", async () => {
    const r = await check(` ${TARGET.toUpperCase()} `);
    expect(r.status).toBe(200);
    expect(r.cache).toBe("private, no-store");
    expect(r.body).toMatchObject({
      free: false,
      tenant: { id: ids.a },
      owner: { id: ids.owner, name: "Synthetic Owner" },
      holder: { kind: "member", id: ids.pat, name: "Pat Imported", status: "active", canSignIn: true, access: "activation_pending", link: `/dashboard/members/${ids.pat}` },
    });
    checkVersion = String((r.body.holder as { version: string }).version);
    expect(checkVersion).toMatch(/^[a-f0-9]{64}$/);
    const checked = await rows("admin.login_email.checked");
    expect(checked).toHaveLength(1);
    expect(checked[0].operatorId).toBe(OP_ID);
    expect(checked[0].requestId).toBeTruthy();
    expect(checked[0].metadata).toMatchObject({ emailDigest: emailDigest(TARGET), result: "member", holderId: ids.pat });
    expect(JSON.stringify(checked[0].metadata)).not.toContain("@");
  });

  it("2. the club-facing refusal stays opaque: a staff create on that address is 409 with no holder detail", async () => {
    hubState.session = { user: { id: ids.owner, tenantId: ids.a, role: "owner", totpEnabled: true, sessionVersion: 0 } };
    const r = await read(await staffCreate(req("/api/staff", { name: "New Coach", email: TARGET, role: "coach", password: SYNTHETIC_PASSWORD })));
    hubState.session = null;
    expect(r.status).toBe(409);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(ids.pat);
    expect(text).not.toMatch(/Pat|member|holder|activation|canSignIn/i);
    expect(r.body).toEqual({ error: "That email address is already in use at this club." });
  });

  it("3. a stale version is refused BEFORE the spend (409), nothing written, the grant still outstanding", async () => {
    memberGrant = await issueGrant("member.contact_email", `${ids.a}/${ids.pat}/change`, { newEmail: PAT_NEW });
    const r = await contact(ids.pat, { newEmail: PAT_NEW, reason: REASON, version: "0".repeat(64) }, memberGrant);
    expect(r.status).toBe(409);
    expect(r.body.result).toBe("stale");
    expect(await nonceHash()).toBe(sha256(nonceOf(memberGrant)));
    expect((await member(ids.pat)).email).toBe(TARGET);
  });

  it("4. member contact change: the address moves; nothing else on the member; this club's sign-in tokens for old AND new retired; waiver kept; club B untouched", async () => {
    const r = await contact(ids.pat, { newEmail: PAT_NEW, reason: REASON, version: checkVersion }, memberGrant);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.cache).toBe("private, no-store");
    expect(r.body).toMatchObject({ ok: true, memberId: ids.pat, canSignIn: false });
    const after = await member(ids.pat);
    expect(after.email).toBe(PAT_NEW);
    expect(Buffer.compare(Buffer.from(String(after.externalRef)), Buffer.from(String(patBefore.externalRef)))).toBe(0);
    for (const k of ["passwordHash", "status", "sessionVersion", "totpEnabled", "name", "tenantId"] as const) expect(after[k], k).toEqual(patBefore[k]);
    for (const t of [tA.reset, tA.login, tA.first_time_signup, tA.mixed, tA.staleNew]) expect(await isUsed(t), t.purpose).toBe(true);
    expect(await isUsed(tA.waiver_open)).toBe(false);
    for (const t of Object.values(tB)) expect(await isUsed(t), `club B ${t.purpose}`).toBe(false);
    expect((await member(ids.patB)).email).toBe(TARGET);
    const out = await rows("admin.member.contact_email.changed");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ operatorId: OP_ID, requestId: sha256(nonceOf(memberGrant)), entityId: ids.pat });
    expect(out[0].metadata).toMatchObject({ oldEmailDigest: emailDigest(TARGET), newEmailDigest: emailDigest(PAT_NEW), canSignIn: false, unverified: false });
    expect(JSON.stringify(out[0].metadata)).not.toContain("@");
    expect(await nonceHash()).toBeNull();
  });

  it("5. lost response: the same grant re-sent is answered from the record; nothing changes", async () => {
    const r = await contact(ids.pat, { newEmail: PAT_NEW, reason: REASON, version: checkVersion }, memberGrant);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, alreadyApplied: true, memberId: ids.pat, recordedAction: "admin.member.contact_email.changed" });
    expect((await member(ids.pat)).email).toBe(PAT_NEW);
    expect(await rows("admin.member.contact_email.changed")).toHaveLength(1);
  });

  it("6. re-check: the address is now free in this club", async () => {
    const r = await check(TARGET);
    expect(r.body).toMatchObject({ free: true, sameAsOwner: false });
  });

  let ownerGrant = "";
  it("7. owner login change with a SEPARATE grant: owner takes the address, provisional, signed out; members untouched", async () => {
    const before = await owner();
    ownerGrant = await issueGrant("owner.login_email", `${ids.a}/${ids.owner}/change`, { newEmail: TARGET });
    const grant = ownerGrant;
    const r = await read(
      await ownerRoute(req(`/api/admin/customers/${ids.a}/login-email`, { action: "change", reason: REASON, newEmail: TARGET }, { [STEP_UP_HEADER]: grant }), {
        params: Promise.resolve({ id: ids.a }),
      }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await owner();
    expect(after).toMatchObject({ email: TARGET, role: "owner", passwordHash: "owner-hash-unchanged", sessionVersion: before.sessionVersion + 1 });
    expect(after.loginEmailProvisionalSince).not.toBeNull();
    // Authenticator and recovery codes byte-identical on the database (review D4).
    expect(after.totpSecret).toBe(before.totpSecret);
    expect(after.totpRecoveryCodes).toEqual(before.totpRecoveryCodes);
    expect(after.totpRecoveryCodes).toHaveLength(2); // the comparison is over real codes, not two empty lists
    expect((await member(ids.pat)).email).toBe(PAT_NEW);
    expect((await check(TARGET)).body).toMatchObject({ free: true, sameAsOwner: true });
  });

  it("7b. lost response on the OWNER step: the same grant re-sent is answered from the record; nothing changes (AH-G1)", async () => {
    const before = await owner();
    const r = await read(
      await ownerRoute(req(`/api/admin/customers/${ids.a}/login-email`, { action: "change", reason: REASON, newEmail: TARGET }, { [STEP_UP_HEADER]: ownerGrant }), {
        params: Promise.resolve({ id: ids.a }),
      }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, alreadyApplied: true, recordedAction: "admin.owner.login_email.changed" });
    expect(await owner()).toEqual(before); // same address, same sessionVersion, same credentials
    expect(await rows("admin.owner.login_email.changed")).toHaveLength(1);
    // Without a grant for this change the same request is still refused.
    const bare = await read(
      await ownerRoute(req(`/api/admin/customers/${ids.a}/login-email`, { action: "change", reason: REASON, newEmail: TARGET }), {
        params: Promise.resolve({ id: ids.a }),
      }),
    );
    expect(bare.status).toBe(400);
  });

  it("8. a link or code sent to the address before the change cannot set a password for its next holder", async () => {
    const inv = await acceptInvite(req("/api/members/accept-invite", { token: tA.first_time_signup.raw, password: SYNTHETIC_PASSWORD }));
    expect(inv.status).toBe(410);
    const rs = await resetPassword(req("/api/auth/reset-password", { token: tA.reset.raw, email: TARGET, tenantSlug: ids.aSlug, password: SYNTHETIC_PASSWORD }));
    expect(rs.status).toBe(400);
    expect((await owner()).passwordHash).toBe("owner-hash-unchanged");
    expect((await member(ids.pat)).passwordHash).toBeNull();
  });

  it("9. control: club B's untouched invite still works for club B's member (the refusals above are retirement)", async () => {
    const inv = await acceptInvite(req("/api/members/accept-invite", { token: tB.first_time_signup.raw, password: SYNTHETIC_PASSWORD }));
    expect(inv.status).toBe(200);
    expect((await member(ids.patB)).passwordHash).not.toBeNull();
  });

  it("10. two concurrent submissions of one grant (two connections): ONE change, ONE sessionVersion bump, ONE outcome row", async () => {
    const before = await member(ids.quin);
    const newEmail = E("quin-new");
    const v = (await check(E("quin"))).body.holder as { version: string };
    const grant = await issueGrant("member.contact_email", `${ids.a}/${ids.quin}/change`, { newEmail });
    const body = { newEmail, reason: REASON, version: v.version };
    const results = await Promise.all([contact(ids.quin, body, grant), contact(ids.quin, body, grant)]);
    const applied = results.filter((r) => r.status === 200 && r.body.alreadyApplied !== true);
    const echoed = results.filter((r) => r.status === 200 && r.body.alreadyApplied === true);
    const used = results.filter((r) => r.status === 403 && r.body.refusal === "used");
    expect(applied, JSON.stringify(results)).toHaveLength(1);
    expect(echoed.length + used.length).toBe(1);
    const after = await member(ids.quin);
    expect(after).toMatchObject({ email: newEmail, sessionVersion: before.sessionVersion + 1, passwordHash: "quin-hash-unchanged" });
    const out = (await rows("admin.member.contact_email.changed")).filter((r) => r.requestId === sha256(nonceOf(grant)));
    expect(out).toHaveLength(1);
    expect(out[0].metadata).toMatchObject({ canSignIn: true, unverified: true, sessionVersionAfter: before.sessionVersion + 1 });
  });
});
