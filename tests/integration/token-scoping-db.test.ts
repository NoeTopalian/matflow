// Email-bound tokens after a contact-email change (admin hub ledger AH-08,
// 9 Oct 2026) against a REAL database — the Neon test branch only.
//
// Reset codes and sign-in links (MagicLinkToken purposes login /
// first_time_signup / waiver_open) are bound to an ADDRESS in a club, not to a
// member id: accept-invite and reset-password find their subject by
// (tenantId, token.email). So when a member's address changes, a link already
// sent to the old address must die — otherwise whoever holds that address next
// (a new member, or the stranger whose mailbox a typo pointed at) can set a
// password on the account that then carries it. Retirement must be scoped to
// the club (the same address in another club is a different person) and to
// sign-in purposes (a waiver link is not a credential).
//
// History: at HEAD 83a34fc the owner PATCH (app/api/members/[id]) retired
// nothing; the retirement under test is lane A's working-tree change
// (lib/login-email.ts retireEmailBoundTokens, called from the PATCH). These
// cases pin it through the REAL routes: PATCH, accept-invite, reset-password.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { PATCH as patchMember } from "@/app/api/members/[id]/route";
import { POST as acceptInvite } from "@/app/api/members/accept-invite/route";
import { POST as resetPassword } from "@/app/api/auth/reset-password/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `tks${Date.now().toString(36)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;
/** A synthetic password that satisfies both routes' policies; not a credential of anything real. */
const SYNTHETIC_PASSWORD = `Synthetic-${STAMP}-Aa1`;
const json = (url: string, method: string, body: unknown) =>
  new Request(url, { method, headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: JSON.stringify(body) });

type Club = { tenantId: string; slug: string; userId: string };
const clubs: Club[] = [];

async function mkClub(label: string): Promise<Club> {
  const c = await withRlsBypass(async (tx) => {
    const slug = `${STAMP}-${label}`;
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug, onboardingCompleted: true } });
    const u = await tx.user.create({ data: { tenantId: t.id, email: E(`${label}-owner`), name: "Owner", role: "owner", passwordHash: "x" } });
    return { tenantId: t.id, slug, userId: u.id };
  });
  clubs.push(c);
  return c;
}

type Purpose = "reset" | "login" | "first_time_signup" | "waiver_open";
/** Mint a token directly (as the minting routes do: HMAC of a random raw value). Returns the row id and the raw value. */
async function mint(tenantId: string, email: string, purpose: Purpose) {
  const raw = purpose === "reset" ? randomBytes(8).toString("hex") : randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const row = await withRlsBypass((tx) =>
    purpose === "reset"
      ? tx.passwordResetToken.create({ data: { tenantId, email, tokenHash: hashToken(raw), expiresAt }, select: { id: true } })
      : tx.magicLinkToken.create({ data: { tenantId, email, tokenHash: hashToken(raw), purpose, expiresAt }, select: { id: true } }),
  );
  return { id: row.id, raw, purpose };
}
type Minted = Awaited<ReturnType<typeof mint>>;
async function isUsed(t: Minted): Promise<boolean> {
  return withRlsBypass(async (tx) =>
    t.purpose === "reset"
      ? (await tx.passwordResetToken.findUniqueOrThrow({ where: { id: t.id } })).used
      : (await tx.magicLinkToken.findUniqueOrThrow({ where: { id: t.id } })).used,
  );
}

async function patch(club: Club, memberId: string, body: Record<string, unknown>) {
  mockAuth.mockResolvedValue({ user: { id: club.userId, tenantId: club.tenantId, role: "owner" } } as never);
  const res = await patchMember(json(`https://test.local/api/members/${memberId}`, "PATCH", body), { params: Promise.resolve({ id: memberId }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const member = (id: string) => withRlsBypass((tx) => tx.member.findUniqueOrThrow({ where: { id }, select: { email: true, passwordHash: true, status: true, sessionVersion: true } }));

describe.skipIf(!HAS_DB)("contact-email change retires the club's sign-in tokens, and only those (AH-08)", () => {
  let A: Club;
  let B: Club;
  const m: Record<string, string> = {};
  const tA: Record<string, Minted> = {};
  const tB: Record<string, Minted> = {};

  beforeAll(async () => {
    A = await mkClub("a");
    B = await mkClub("b");
    await withRlsBypass(async (tx) => {
      // The SAME address in two clubs: two different people.
      m.pat = (await tx.member.create({ data: { tenantId: A.tenantId, name: "Pat Shared", email: E("shared") } })).id; // passwordless
      m.patB = (await tx.member.create({ data: { tenantId: B.tenantId, name: "Pat Shared", email: E("shared") } })).id;
      m.quin = (await tx.member.create({ data: { tenantId: A.tenantId, name: "Quin Pass", email: E("quin-old"), passwordHash: "x" } })).id;
    });
    for (const p of ["reset", "login", "first_time_signup", "waiver_open"] as const) {
      tA[p] = await mint(A.tenantId, E("shared"), p);
      tB[p] = await mint(B.tenantId, E("shared"), p);
    }
    // A stale invite already minted to the address Pat is about to receive.
    tA.staleNew = await mint(A.tenantId, E("pat-new"), "first_time_signup");
    // Written mixed-case on purpose: the lowercase trigger (15 Sep 2026) must
    // store it canonical, so retirement by canonical address still reaches it.
    tA.mixed = await mint(A.tenantId, E("shared").toUpperCase(), "login");
    tA.quinReset = await mint(A.tenantId, E("quin-old"), "reset");
  }, 120_000);

  afterAll(async () => {
    const ids = clubs.map((c) => c.tenantId);
    for (const tenantId of ids) {
      await withRlsBypass(async (tx) => {
        await tx.magicLinkToken.deleteMany({ where: { tenantId } });
        await tx.passwordResetToken.deleteMany({ where: { tenantId } });
        await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
        await tx.member.deleteMany({ where: { tenantId } });
        await tx.user.deleteMany({ where: { tenantId } });
        await tx.tenant.delete({ where: { id: tenantId } });
      }, { timeout: 60_000 });
    }
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { id: { in: ids } } }),
      links: await tx.magicLinkToken.count({ where: { tenantId: { in: ids } } }),
      codes: await tx.passwordResetToken.count({ where: { tenantId: { in: ids } } }),
    }));
    expect(left).toEqual({ tenants: 0, links: 0, codes: 0 });
  }, 120_000);

  it("fixture: every token is live, and the mixed-case one was stored canonical", async () => {
    for (const t of [...Object.values(tA), ...Object.values(tB)]) expect(await isUsed(t)).toBe(false);
    const mixed = await withRlsBypass((tx) => tx.magicLinkToken.findUniqueOrThrow({ where: { id: tA.mixed.id } }));
    expect(mixed.email).toBe(E("shared"));
  });

  it("changing Pat's address in club A retires A's reset code, login and activation links for BOTH addresses; the waiver link is kept", async () => {
    const before = await member(m.pat);
    const r = await patch(A, m.pat, { email: E("pat-new") });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await isUsed(tA.reset)).toBe(true);
    expect(await isUsed(tA.login)).toBe(true);
    expect(await isUsed(tA.first_time_signup)).toBe(true);
    expect(await isUsed(tA.mixed)).toBe(true);
    expect(await isUsed(tA.staleNew)).toBe(true);
    expect(await isUsed(tA.waiver_open)).toBe(false);
    // Marked used (kept as evidence), never deleted.
    const link = await withRlsBypass((tx) => tx.magicLinkToken.findUniqueOrThrow({ where: { id: tA.first_time_signup.id } }));
    expect(link.usedAt).not.toBeNull();
    // A contact change grants nothing: the passwordless member stays passwordless, status unchanged.
    const after = await member(m.pat);
    expect(after).toMatchObject({ email: E("pat-new"), passwordHash: null, status: before.status });
  });

  it("the same address in club B is another person: every one of B's tokens stays live", async () => {
    for (const t of Object.values(tB)) expect(await isUsed(t), t.purpose).toBe(false);
    expect((await member(m.patB)).email).toBe(E("shared"));
  });

  it("a password-holding member's change retires the reset code sent to the old address; the password is untouched", async () => {
    const r = await patch(A, m.quin, { email: E("quin-new") });
    expect(r.status).toBe(200);
    expect(await isUsed(tA.quinReset)).toBe(true);
    expect((await member(m.quin)).passwordHash).toBe("x");
  });

  it("whoever holds the old address next cannot be taken over with a link or code sent before the change", async () => {
    const [nell, ola] = await withRlsBypass(async (tx) => [
      (await tx.member.create({ data: { tenantId: A.tenantId, name: "Nell Holder", email: E("shared") } })).id,
      (await tx.member.create({ data: { tenantId: A.tenantId, name: "Ola Holder", email: E("quin-old") } })).id,
    ]);
    m.nell = nell; m.ola = ola;
    const inv = await acceptInvite(json("https://test.local/api/members/accept-invite", "POST", { token: tA.first_time_signup.raw, password: SYNTHETIC_PASSWORD }));
    expect(inv.status).toBe(410);
    const rs1 = await resetPassword(json("https://test.local/api/auth/reset-password", "POST", { token: tA.reset.raw, email: E("shared"), tenantSlug: A.slug, password: SYNTHETIC_PASSWORD }));
    expect(rs1.status).toBe(400);
    const rs2 = await resetPassword(json("https://test.local/api/auth/reset-password", "POST", { token: tA.quinReset.raw, email: E("quin-old"), tenantSlug: A.slug, password: SYNTHETIC_PASSWORD }));
    expect(rs2.status).toBe(400);
    expect((await member(nell)).passwordHash).toBeNull();
    expect((await member(ola)).passwordHash).toBeNull();
    expect((await member(m.pat)).passwordHash).toBeNull();
    expect((await member(m.quin)).passwordHash).toBe("x");
  });

  it("control: club B's untouched invite still works for club B's member (the refusals above are retirement, not a broken path)", async () => {
    const inv = await acceptInvite(json("https://test.local/api/members/accept-invite", "POST", { token: tB.first_time_signup.raw, password: SYNTHETIC_PASSWORD }));
    expect(inv.status).toBe(200);
    expect((await member(m.patB)).passwordHash).not.toBeNull();
    expect(await isUsed(tB.reset)).toBe(false);
    expect(await isUsed(tB.waiver_open)).toBe(false);
  });

  it("an edit that does not change the address retires nothing (name edit; same address in another case)", async () => {
    const fresh = await mint(A.tenantId, E("pat-new"), "first_time_signup");
    const r1 = await patch(A, m.pat, { name: "Pat Renamed" });
    expect(r1.status).toBe(200);
    const r2 = await patch(A, m.pat, { email: E("pat-new").toUpperCase() });
    expect(r2.status).toBe(200);
    expect((await member(m.pat)).email).toBe(E("pat-new"));
    expect(await isUsed(fresh)).toBe(false);
  });
});
