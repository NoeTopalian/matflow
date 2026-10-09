// Login-identity claims on REAL rows (admin hub AH-01, 9 Oct 2026).
//
// The helper (lib/login-email.ts claimLoginIdentity / claimLoginIdentities /
// retireEmailBoundTokens) and the real club writers, one request at a time:
// free / occupied / same-record / mixed-case / legacy duplicate / shared
// family, member-vs-staff in both directions, token retirement scoped to
// club and purpose, and the read-only legacy-duplicates report. The
// concurrent cells are in login-identity-race-db.test.ts.
//
// Synthetic clubs only (unique slugs, example.test addresses), removed in
// afterAll through the tenant purge path. Run with BOTH TEST-branch runners
// (owner role and restricted matflow_app role); skips without a DB.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
  },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...mod, checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, retryAfterSeconds: 0 })) };
});
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
const gate = { tenantId: "", userId: "" };
vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: vi.fn(async () => ({ ok: true, tenantId: gate.tenantId, userId: gate.userId, session: { user: { id: gate.userId, tenantId: gate.tenantId, role: "owner" } } })),
  requireApiOwner: vi.fn(async () => ({ ok: true, tenantId: gate.tenantId, userId: gate.userId, session: { user: { id: gate.userId, tenantId: gate.tenantId, role: "owner" } } })),
}));
vi.mock("@vercel/blob", () => ({ del: vi.fn(async () => undefined), get: vi.fn(async () => null) }));
vi.mock("@/lib/stripe/subscriptions", () => ({
  cancelSubscriptionAtPeriodEnd: vi.fn(async () => ({ ok: false, status: 500, error: "no Stripe in tests" })),
}));

import { auth } from "@/auth";
import { logAudit } from "@/lib/audit-log";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { purgeTenantById } from "@/lib/tenant-purge";
import { claimLoginIdentity, claimLoginIdentities, retireEmailBoundTokens } from "@/lib/login-email";
import { isSynthesisedEmail } from "@/lib/synthesise-kid-email";
import { POST as createMember } from "@/app/api/members/route";
import { PATCH as patchMember } from "@/app/api/members/[id]/route";
import { PATCH as patchSelf } from "@/app/api/member/me/route";
import { POST as guardian } from "@/app/api/members/[id]/guardian/route";
import { POST as createStaff } from "@/app/api/staff/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `lic${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const STRONG = "Claim-Temp-Pass-42";
const created: string[] = [];
let seq = 0;
const addr = (label: string) => `${STAMP}-${label}-${++seq}@example.test`;

type Club = { tenantId: string; slug: string; ownerId: string; coachId: string; coachEmail: string; memberId: string; memberEmail: string };

async function mkClub(label: string): Promise<Club> {
  return withRlsBypass(async (tx) => {
    const slug = `${STAMP}-${label}`;
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug, onboardingCompleted: true } });
    created.push(t.id);
    const owner = await tx.user.create({ data: { tenantId: t.id, email: addr("owner"), name: "Owner Synthetic", role: "owner", passwordHash: "x" } });
    const coachEmail = addr("coach");
    const coach = await tx.user.create({ data: { tenantId: t.id, email: coachEmail, name: "Coach Synthetic", role: "coach", passwordHash: "x" } });
    const memberEmail = addr("member");
    const member = await tx.member.create({ data: { tenantId: t.id, name: "Member Synthetic", email: memberEmail, passwordHash: "x" } });
    return { tenantId: t.id, slug, ownerId: owner.id, coachId: coach.id, coachEmail, memberId: member.id, memberEmail };
  });
}

function asOwner(c: Club) {
  mockAuth.mockResolvedValue({ user: { id: c.ownerId, tenantId: c.tenantId, role: "owner", email: "owner" } } as never);
  gate.tenantId = c.tenantId;
  gate.userId = c.ownerId;
}
function asMember(c: Club, memberId: string) {
  mockAuth.mockResolvedValue({ user: { id: memberId, memberId, tenantId: c.tenantId, role: "member", email: "member" } } as never);
}

function req(method: string, body: unknown): Request {
  return new Request("https://test.local/api/x", {
    method,
    headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
    body: JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
type Res = { status: number; json: () => Promise<unknown> };

async function holders(tenantId: string, email: string) {
  return withRlsBypass(async (tx) => {
    const [u, m] = await Promise.all([
      tx.user.findMany({ where: { tenantId, email: { equals: email, mode: "insensitive" } }, select: { id: true } }),
      tx.member.findMany({ where: { tenantId, email: { equals: email, mode: "insensitive" } }, select: { id: true } }),
    ]);
    return u.length + m.length;
  });
}

describe.skipIf(!HAS_DB)("login identity claims on real rows", () => {
  let a: Club;
  let b: Club;

  beforeAll(async () => {
    a = await mkClub("a");
    b = await mkClub("b");
  });

  afterAll(async () => {
    const purgeNow = new Date(Date.now() + 365 * DAY_MS);
    for (const id of created) {
      await withRlsBypass((tx) => tx.tenant.updateMany({ where: { id }, data: { deletedAt: new Date(Date.now() - 40 * DAY_MS) } }));
      const out = await purgeTenantById(id, purgeNow, () => false);
      if (out.kind !== "purged" && out.kind !== "gone-during-purge") console.error(`[login-identity-claims cleanup] ${id}: ${out.kind}`);
    }
    await withRlsBypass((tx) => tx.auditLog.deleteMany({ where: { action: "admin.tenant.hard_deleted", entityId: { in: created } } }));
  }, 120_000);

  // ── The helper ────────────────────────────────────────────────────────────
  it("free address → none; occupied → the one holder, with its id, name and capability", async () => {
    const claim = (email: string, exclude?: { userId?: string; memberId?: string }) =>
      withTenantContext(a.tenantId, (tx) => claimLoginIdentity(tx, { tenantId: a.tenantId, email, exclude }));
    expect(await claim(addr("free"))).toEqual({ kind: "none" });
    expect(await claim(a.coachEmail)).toEqual({ kind: "user", id: a.coachId, name: "Coach Synthetic", role: "coach", canSignIn: true });
    expect(await claim(a.memberEmail)).toEqual({
      kind: "member", id: a.memberId, name: "Member Synthetic", status: "active", hasPassword: true, canSignIn: true,
    });
  });

  it("mixed-case and padded input is canonicalised before the lookup → still a collision", async () => {
    const shouted = `  ${a.memberEmail.toUpperCase()} `;
    const c = await withTenantContext(a.tenantId, (tx) => claimLoginIdentity(tx, { tenantId: a.tenantId, email: shouted }));
    expect(c).toMatchObject({ kind: "member", id: a.memberId });
    // ...and through a real writer: a staff create typed in capitals is refused.
    asOwner(a);
    const r = (await createStaff(req("POST", { name: "Shout", email: a.memberEmail.toUpperCase(), role: "coach", password: STRONG }) as never)) as Res;
    expect(r.status).toBe(409);
  });

  it("same-record exclusion: re-saving your own address is not a collision (user and member)", async () => {
    const u = await withTenantContext(a.tenantId, (tx) => claimLoginIdentity(tx, { tenantId: a.tenantId, email: a.coachEmail, exclude: { userId: a.coachId } }));
    const m = await withTenantContext(a.tenantId, (tx) => claimLoginIdentity(tx, { tenantId: a.tenantId, email: a.memberEmail, exclude: { memberId: a.memberId } }));
    expect(u).toEqual({ kind: "none" });
    expect(m).toEqual({ kind: "none" });
    // Excluding a DIFFERENT record does not hide the holder.
    const other = await withTenantContext(a.tenantId, (tx) => claimLoginIdentity(tx, { tenantId: a.tenantId, email: a.memberEmail, exclude: { userId: a.coachId } }));
    expect(other).toMatchObject({ kind: "member", id: a.memberId });
    // Real writer: a member PATCH that re-sends its own address succeeds.
    asOwner(a);
    const r = (await patchMember(req("PATCH", { email: a.memberEmail }) as never, params(a.memberId))) as Res;
    expect(r.status).toBe(200);
  });

  it("another club's identical address is not a holder here (login is per club)", async () => {
    const c = await withTenantContext(b.tenantId, (tx) => claimLoginIdentity(tx, { tenantId: b.tenantId, email: a.coachEmail }));
    expect(c).toEqual({ kind: "none" });
    asOwner(b);
    const r = (await createStaff(req("POST", { name: "Reuse", email: a.coachEmail, role: "coach", password: STRONG }) as never)) as Res;
    expect(r.status).toBe(201);
  });

  // ── Member vs staff, both directions, every club writer ──────────────────
  it("member create on a STAFF address is refused (gap #11), opaquely", async () => {
    asOwner(a);
    const r = (await createMember(req("POST", { name: "Clash", email: a.coachEmail }) as never)) as Res;
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).not.toMatch(/staff|coach|member/i);
    expect(await holders(a.tenantId, a.coachEmail)).toBe(1);
  });

  it("staff create on a MEMBER address is refused (it would have taken the member's sign-in over)", async () => {
    asOwner(a);
    const r = (await createStaff(req("POST", { name: "Clash", email: a.memberEmail, role: "coach", password: STRONG }) as never)) as Res;
    expect(r.status).toBe(409);
    expect(await holders(a.tenantId, a.memberEmail)).toBe(1);
  });

  it("member PATCH and member self-service change onto a staff address are refused; nothing changes", async () => {
    asOwner(a);
    const r1 = (await patchMember(req("PATCH", { email: a.coachEmail }) as never, params(a.memberId))) as Res;
    expect(r1.status).toBe(409);
    asMember(a, a.memberId);
    const r2 = (await patchSelf(req("PATCH", { email: a.coachEmail }) as never)) as Res;
    expect(r2.status).toBe(409);
    const row = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: a.memberId }, select: { email: true } }));
    expect(row?.email).toBe(a.memberEmail);
  });

  it("member email change retires reset codes and sign-in links for BOTH addresses in this club only", async () => {
    const c = await mkClub("tok");
    const oldEmail = c.memberEmail;
    const fresh = addr("moved");
    const exp = new Date(Date.now() + DAY_MS);
    const tok = () => `${STAMP}-${Math.random().toString(36).slice(2)}-${++seq}`;
    await withRlsBypass(async (tx) => {
      await tx.passwordResetToken.create({ data: { tenantId: c.tenantId, email: oldEmail, tokenHash: tok(), expiresAt: exp } });
      await tx.magicLinkToken.create({ data: { tenantId: c.tenantId, email: oldEmail, tokenHash: tok(), purpose: "login", expiresAt: exp } });
      await tx.magicLinkToken.create({ data: { tenantId: c.tenantId, email: oldEmail, tokenHash: tok(), purpose: "waiver_open", expiresAt: exp } });
      // Another club, same address: must be untouched.
      await tx.passwordResetToken.create({ data: { tenantId: b.tenantId, email: oldEmail, tokenHash: tok(), expiresAt: exp } });
    });
    asOwner(c);
    const r = (await patchMember(req("PATCH", { email: fresh }) as never, params(c.memberId))) as Res;
    expect(r.status).toBe(200);
    const after = await withRlsBypass(async (tx) => ({
      reset: await tx.passwordResetToken.count({ where: { tenantId: c.tenantId, email: oldEmail, used: false } }),
      login: await tx.magicLinkToken.count({ where: { tenantId: c.tenantId, email: oldEmail, used: false, purpose: "login" } }),
      waiver: await tx.magicLinkToken.count({ where: { tenantId: c.tenantId, email: oldEmail, used: false, purpose: "waiver_open" } }),
      otherClub: await tx.passwordResetToken.count({ where: { tenantId: b.tenantId, email: oldEmail, used: false } }),
    }));
    expect(after).toEqual({ reset: 0, login: 0, waiver: 1, otherClub: 1 });
  });

  it("a staff change of a PASSWORD-holding member's address signs them out everywhere and is recorded unverified; a passwordless member's is not bumped", async () => {
    const c = await mkClub("sv");
    const passwordless = await withRlsBypass((tx) => tx.member.create({ data: { tenantId: c.tenantId, name: "Walk-in Synthetic", email: addr("walkin") } }));
    const before = await withRlsBypass((tx) => tx.member.findMany({ where: { id: { in: [c.memberId, passwordless.id] } }, select: { id: true, sessionVersion: true, passwordHash: true } }));
    const sv = (id: string) => before.find((r) => r.id === id)!.sessionVersion;
    asOwner(c);
    vi.mocked(logAudit).mockClear();
    const r1 = (await patchMember(req("PATCH", { email: addr("moved") }) as never, params(c.memberId))) as Res;
    expect(r1.status).toBe(200);
    const r2 = (await patchMember(req("PATCH", { email: addr("moved2") }) as never, params(passwordless.id))) as Res;
    expect(r2.status).toBe(200);
    const after = await withRlsBypass((tx) => tx.member.findMany({ where: { id: { in: [c.memberId, passwordless.id] } }, select: { id: true, sessionVersion: true, passwordHash: true } }));
    const now = (id: string) => after.find((r) => r.id === id)!;
    expect(now(c.memberId).sessionVersion).toBe(sv(c.memberId) + 1); // exactly one bump
    expect(now(c.memberId).passwordHash).toBe("x"); // credentials untouched
    expect(now(passwordless.id).sessionVersion).toBe(sv(passwordless.id));
    const rows = vi.mocked(logAudit).mock.calls.map((call) => call[0] as { action: string; entityId: string; metadata: Record<string, unknown> }).filter((a) => a.action === "member.update");
    expect(rows.find((a) => a.entityId === c.memberId)?.metadata).toMatchObject({ unverified: true, sessionsRevoked: true });
    expect(rows.find((a) => a.entityId === passwordless.id)?.metadata).not.toHaveProperty("sessionsRevoked");
  });

  it("retireEmailBoundTokens: default purposes leave waiver links; naming waiver_open retires them; tenant-scoped", async () => {
    const c = await mkClub("ret");
    const z = addr("z");
    const exp = new Date(Date.now() + DAY_MS);
    const tok = () => `${STAMP}-${Math.random().toString(36).slice(2)}-${++seq}`;
    await withRlsBypass(async (tx) => {
      for (const t of [c.tenantId, b.tenantId]) {
        await tx.passwordResetToken.create({ data: { tenantId: t, email: z, tokenHash: tok(), expiresAt: exp } });
        await tx.magicLinkToken.create({ data: { tenantId: t, email: z, tokenHash: tok(), purpose: "first_time_signup", expiresAt: exp } });
        await tx.magicLinkToken.create({ data: { tenantId: t, email: z, tokenHash: tok(), purpose: "waiver_open", expiresAt: exp } });
      }
    });
    const first = await withTenantContext(c.tenantId, (tx) => retireEmailBoundTokens(tx, { tenantId: c.tenantId, emails: [z.toUpperCase()] }));
    expect(first).toEqual({ resetCodes: 1, signInLinks: 1 });
    const onlyWaiver = await withTenantContext(c.tenantId, (tx) => retireEmailBoundTokens(tx, { tenantId: c.tenantId, emails: [z], purposes: ["waiver_open"] }));
    expect(onlyWaiver).toEqual({ resetCodes: 0, signInLinks: 1 });
    const live = (t: string) => withRlsBypass(async (tx) =>
      (await tx.passwordResetToken.count({ where: { tenantId: t, email: z, used: false } })) +
      (await tx.magicLinkToken.count({ where: { tenantId: t, email: z, used: false } })));
    expect(await live(c.tenantId)).toBe(0);
    expect(await live(b.tenantId)).toBe(3);
  });

  // ── Families ──────────────────────────────────────────────────────────────
  it("shared family: a child added on a parent gets a synthesised login (no collision); a payer address is not a login", async () => {
    const c = await mkClub("fam");
    asOwner(c);
    const kid = (await createMember(req("POST", { name: "Kid Synthetic", accountType: "kids", parentMemberId: c.memberId, dateOfBirth: "2018-04-02" }) as never)) as Res;
    expect(kid.status).toBe(201);
    const kidBody = (await kid.json()) as { email: string };
    expect(isSynthesisedEmail(kidBody.email)).toBe(true);
    expect(await holders(c.tenantId, c.memberEmail)).toBe(1);

    // A guardian draft: synthesised login, the family's payer address kept as unverifiedEmail.
    const payer = addr("payer");
    await withRlsBypass((tx) => tx.member.create({ data: { tenantId: c.tenantId, name: "Guardian Draft", email: `adult-${STAMP}${++seq}@no-login.matflow.local`, unverifiedEmail: payer } }));
    const claim = await withTenantContext(c.tenantId, (tx) => claimLoginIdentity(tx, { tenantId: c.tenantId, email: payer }));
    expect(claim).toEqual({ kind: "none" });
    // ...so a staff login on that address is allowed (the payer address is contact, not identity).
    const staff = (await createStaff(req("POST", { name: "Payer Staff", email: payer, role: "coach", password: STRONG }) as never)) as Res;
    expect(staff.status).toBe(201);
    // Bulk claims skip synthesised logins and report the rest.
    const many = await withTenantContext(c.tenantId, (tx) => claimLoginIdentities(tx, c.tenantId, [kidBody.email, payer, addr("nobody")]));
    expect(many.get(kidBody.email)).toEqual({ kind: "none" });
    expect(many.get(payer)).toMatchObject({ kind: "user" });
  });

  it("guardian confirm that would ADOPT a staff login's address as the parent's login is refused", async () => {
    const c = await mkClub("adopt");
    const parent = await withRlsBypass((tx) =>
      tx.member.create({ data: { tenantId: c.tenantId, name: "Guardian Draft", email: `adult-${STAMP}${++seq}@no-login.matflow.local`, unverifiedEmail: c.coachEmail } }));
    const child = await withRlsBypass((tx) =>
      tx.member.create({ data: { tenantId: c.tenantId, name: "Child Synthetic", email: `kid-${STAMP}${++seq}@no-login.matflow.local`, accountType: "kids", parentMemberId: parent.id, guardianSuggestedBy: "emergency_contact" } }));
    asOwner(c);
    const r = (await guardian(req("POST", { action: "confirm", adoptUnverifiedEmail: true }) as never, params(child.id))) as Res;
    expect(r.status).toBe(409);
    const p = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: parent.id }, select: { email: true, unverifiedEmail: true } }));
    expect(isSynthesisedEmail(p?.email)).toBe(true);
    expect(p?.unverifiedEmail).toBe(c.coachEmail);
  });

  // ── Legacy duplicates ─────────────────────────────────────────────────────
  it("a legacy cross-table duplicate is reported as many (both holders, no pick) and refuses new claims", async () => {
    const c = await mkClub("dup");
    const dup = addr("dup");
    const shouted = dup.replace(/^./, (ch) => ch.toUpperCase()).replace("@example.test", "@Example.TEST");
    // Written directly, as rows from before normalise-on-write and the claim lock were.
    const legacy = await withRlsBypass(async (tx) => ({
      user: await tx.user.create({ data: { tenantId: c.tenantId, email: dup, name: "Legacy Staff", role: "coach", passwordHash: "x" } }),
      member: await tx.member.create({ data: { tenantId: c.tenantId, email: shouted, name: "Legacy Member" } }),
    }));
    const claim = await withTenantContext(c.tenantId, (tx) => claimLoginIdentity(tx, { tenantId: c.tenantId, email: dup }));
    expect(claim.kind).toBe("many");
    if (claim.kind !== "many") throw new Error("unreachable");
    expect(claim.holders.map((h) => `${h.kind}:${h.id}`).sort()).toEqual([`member:${legacy.member.id}`, `user:${legacy.user.id}`].sort());
    asOwner(c);
    const r = (await createMember(req("POST", { name: "Third", email: dup }) as never)) as Res;
    expect(r.status).toBe(409);

    // The read-only report finds it: exit 3, a cross-table group, and no address in its output.
    const run = spawnSync(process.execPath, [path.join("scripts", "readiness", "login-identity-duplicates.mjs"), "--env", ".env.test", "--tenant", c.slug], {
      cwd: process.cwd(), encoding: "utf8", timeout: 90_000,
    });
    expect(run.status).toBe(3);
    const lines = run.stdout.trim().split("\n");
    const summary = JSON.parse(lines[lines.length - 1]) as { ok: boolean; duplicateGroups: { crossTable: number; userUser: number; memberMember: number } };
    expect(summary.ok).toBe(true);
    expect(summary.duplicateGroups).toEqual({ crossTable: 1, userUser: 0, memberMember: 0 });
    expect(run.stdout.toLowerCase()).not.toContain(dup.toLowerCase());
    expect(run.stdout).toContain(legacy.user.id);
    expect(run.stdout).toContain(legacy.member.id);
  }, 120_000);
});
