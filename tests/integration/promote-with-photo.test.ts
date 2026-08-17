import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => b, headers: new Headers() }) },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as promoteRank } from "@/app/api/members/[id]/rank/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

// PHOTO_URL_SCHEMA in app/api/members/[id]/rank/route.ts only accepts a Vercel
// Blob host (lib/blob-url.ts `isVercelBlobUrl`) or a data:image/(png|jpeg|webp)
// base64 payload — the arbitrary-origin restriction is the L1-I2-S-06 stored-XSS
// fix, and no shipped version of the validator ever accepted `blob.example`.
// The fixture below is the exact shape the private-blob upload route returns
// since Bug 3 (efebb33): https://<store-id>.blob.vercel-storage.com/…
const PROMO_PHOTO_URL =
  "https://abc123store.blob.vercel-storage.com/tenants/pwp-test/promo.png";

function jsonReq(body: unknown): Request {
  return new Request("https://test.local/", { method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: JSON.stringify(body) });
}

describe.skipIf(!HAS_DB)("Promote with photo", () => {
  let tenantId: string;
  let ownerUserId: string;
  let memberId: string;
  let rankSystemId: string;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: "PWP", slug: `pwp-${STAMP}` } });
      tenantId = t.id;
      const u = await tx.user.create({ data: { tenantId, email: `o-${STAMP}@pwp.test`, passwordHash: "x", name: "Owner", role: "owner" } });
      ownerUserId = u.id;
      const m = await tx.member.create({ data: { tenantId, name: "Promotable", email: `m-${STAMP}@pwp.test` } });
      memberId = m.id;
      const rs = await tx.rankSystem.create({ data: { tenantId, discipline: "BJJ", name: "Blue", order: 2, color: "#3b82f6" } });
      rankSystemId = rs.id;
    });
  });
  afterAll(async () => {
    await withRlsBypass((tx) => tx.memberPhoto.deleteMany({ where: { tenantId } }));
    await withRlsBypass(async (tx) => {
      const ranks = await tx.memberRank.findMany({ where: { memberId }, select: { id: true } });
      if (ranks.length > 0) await tx.rankHistory.deleteMany({ where: { memberRankId: { in: ranks.map((r) => r.id) } } });
      await tx.memberRank.deleteMany({ where: { memberId } });
    });
    await withRlsBypass((tx) => tx.member.deleteMany({ where: { tenantId } }));
    await withRlsBypass((tx) => tx.rankSystem.deleteMany({ where: { tenantId } }));
    await withRlsBypass((tx) => tx.user.deleteMany({ where: { id: ownerUserId } }));
    await withRlsBypass((tx) => tx.tenant.deleteMany({ where: { id: tenantId } }));
  });

  it("creates MemberPhoto kind='promotion' linked to the new MemberRank when photoUrl present", async () => {
    mockAuth.mockResolvedValue({ user: { id: ownerUserId, tenantId, role: "owner", email: "owner" } } as never);
    const res = await promoteRank(
      jsonReq({ rankSystemId, stripes: 1, photoUrl: PROMO_PHOTO_URL, photoCaption: "Mat shot" }),
      { params: Promise.resolve({ id: memberId }) },
    );
    expect(res.status).toBeLessThan(300);

    const photos = await withRlsBypass((tx) => tx.memberPhoto.findMany({ where: { memberId, kind: "promotion" } }));
    expect(photos.length).toBe(1);
    expect(photos[0].url).toBe(PROMO_PHOTO_URL);
    expect(photos[0].memberRankId).not.toBeNull();
  });
});
