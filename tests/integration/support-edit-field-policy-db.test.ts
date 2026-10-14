// Edit-session field policy against REAL Postgres (external review, 13 Oct
// 2026). The unit suite (tests/unit/support-edit-field-policy.test.ts) proves
// the guard with mocks; this proves persistence on the database: a refused
// request leaves the member row byte-identical (prohibited alone AND mixed —
// no partial allowed-field write), a member created in an edit session gets no
// MagicLinkToken row, and a cross-tenant target answers 404 with nothing
// written. Sessions are supplied through a mocked auth() — the guard reads
// scope from the session object, which in production comes only from the
// HMAC-verified impersonation token (proven in support-session-binding-db).
//
// Neon TEST branch only (tests/setup-test-db.ts refuses the production
// endpoint). Synthetic, uniquely-named rows; deleted in afterAll. Skips
// without a database.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { auth } from "@/auth";
import { PATCH as memberPatch } from "@/app/api/members/[id]/route";
import { POST as memberPost } from "@/app/api/members/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG_A = `fp-a-${STAMP}`;
const SLUG_B = `fp-b-${STAMP}`;

function req(url: string, body: unknown): Request {
  return {
    url,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Request;
}

describe.skipIf(!HAS_DB)("edit-session field policy on the database", () => {
  let tenantA = "";
  let tenantB = "";
  let ownerA = "";
  let memberA = "";
  let memberB = "";

  const editSession = () => ({
    user: { id: ownerA, tenantId: tenantA, role: "owner", email: `fp-owner-${STAMP}@example.test`, name: "FP Owner", impersonatedBy: "op-fp", supportScope: "edit" },
  });

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const a = await tx.tenant.create({ data: { name: `FP A ${STAMP}`, slug: SLUG_A, onboardingCompleted: true, subscriptionStatus: "active" } });
      const b = await tx.tenant.create({ data: { name: `FP B ${STAMP}`, slug: SLUG_B, onboardingCompleted: true, subscriptionStatus: "active" } });
      tenantA = a.id; tenantB = b.id;
      const owner = await tx.user.create({ data: { tenantId: tenantA, email: `fp-owner-${STAMP}@example.test`, name: "FP Owner", role: "owner", passwordHash: "x" } });
      ownerA = owner.id;
      const ma = await tx.member.create({ data: { tenantId: tenantA, name: "FP Member A", email: `fp-ma-${STAMP}@example.test`, status: "active", paymentStatus: "paid" } });
      const mb = await tx.member.create({ data: { tenantId: tenantB, name: "FP Member B", email: `fp-mb-${STAMP}@example.test`, status: "active" } });
      memberA = ma.id; memberB = mb.id;
    });
  }, 60000);

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      for (const t of [tenantA, tenantB].filter(Boolean)) {
        await tx.auditLog.deleteMany({ where: { tenantId: t } });
        await tx.magicLinkToken.deleteMany({ where: { tenantId: t } });
        await tx.memberStatusEvent.deleteMany({ where: { tenantId: t } });
        await tx.member.deleteMany({ where: { tenantId: t } });
        await tx.user.deleteMany({ where: { tenantId: t } });
        await tx.tenant.deleteMany({ where: { id: t } });
      }
    });
    await prisma.$disconnect();
  }, 60000);

  const snapshot = (id: string) =>
    withRlsBypass((tx) => tx.member.findUnique({ where: { id } }));

  it("prohibited field alone: 403 and the row is byte-identical", async () => {
    mockAuth.mockResolvedValue(editSession() as never);
    const before = await snapshot(memberA);
    const res = await memberPatch(req(`https://x/api/members/${memberA}`, { status: "cancelled" }), { params: Promise.resolve({ id: memberA }) });
    expect(res.status).toBe(403);
    expect(await snapshot(memberA)).toEqual(before);
  }, 30000);

  it("prohibited mixed with legitimate: 403 and NO partial write of the allowed field", async () => {
    mockAuth.mockResolvedValue(editSession() as never);
    const before = await snapshot(memberA);
    const res = await memberPatch(req(`https://x/api/members/${memberA}`, { name: "Partially Applied?", paymentStatus: "free" }), { params: Promise.resolve({ id: memberA }) });
    expect(res.status).toBe(403);
    const after = await snapshot(memberA);
    expect(after!.name).toBe("FP Member A");
    expect(after).toEqual(before);
  }, 30000);

  it("allowed field under edit scope really persists (the session can still work)", async () => {
    mockAuth.mockResolvedValue(editSession() as never);
    const res = await memberPatch(req(`https://x/api/members/${memberA}`, { phone: "07700900001" }), { params: Promise.resolve({ id: memberA }) });
    expect(res.status).toBe(200);
    expect((await snapshot(memberA))!.phone).toBe("+447700900001"); // phoneField normalises to E.164
  }, 30000);

  it("member created in an edit session: row exists, NO MagicLinkToken, inviteUrl null", async () => {
    mockAuth.mockResolvedValue(editSession() as never);
    const email = `fp-new-${STAMP}@example.test`;
    const res = await memberPost(req("https://x/api/members", { name: "FP Created", email }));
    expect([200, 201]).toContain(res.status);
    const body = await res.json() as { id: string; inviteUrl: string | null };
    expect(body.inviteUrl).toBeNull();
    const tokens = await withRlsBypass((tx) => tx.magicLinkToken.count({ where: { tenantId: tenantA, email } }));
    expect(tokens).toBe(0);
  }, 30000);

  it("cross-tenant target: 404 and the other club's row untouched", async () => {
    mockAuth.mockResolvedValue(editSession() as never);
    const before = await snapshot(memberB);
    const res = await memberPatch(req(`https://x/api/members/${memberB}`, { name: "Cross Tenant" }), { params: Promise.resolve({ id: memberB }) });
    expect(res.status).toBe(404);
    expect(await snapshot(memberB)).toEqual(before);
  }, 30000);
});
