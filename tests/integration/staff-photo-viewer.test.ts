import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => b, headers: new Headers() }) },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { GET as staffPhotos } from "@/app/api/members/[id]/photos/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

function req(): Request {
  return new Request("https://test.local/", { method: "GET", headers: { origin: "https://test.local", host: "test.local" } });
}

describe.skipIf(!HAS_DB)("GET /api/members/[id]/photos (staff)", () => {
  let tenantId: string;
  let otherTenantId: string;
  let memberId: string;
  let otherTenantMemberId: string;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: "Staff-Photos", slug: `sp-${STAMP}` } });
      tenantId = t.id;
      const m = await tx.member.create({ data: { tenantId, name: "Kid", email: `k-${STAMP}@sp.test` } });
      memberId = m.id;
      await tx.memberPhoto.create({ data: { tenantId, memberId, url: "https://blob.example/p1.png" } });

      const other = await tx.tenant.create({ data: { name: "OtherSP", slug: `other-sp-${STAMP}` } });
      otherTenantId = other.id;
      const om = await tx.member.create({ data: { tenantId: other.id, name: "OK", email: `ok-${STAMP}@sp.test` } });
      otherTenantMemberId = om.id;
      await tx.memberPhoto.create({ data: { tenantId: other.id, memberId: om.id, url: "https://blob.example/p2.png" } });
    });
  });
  afterAll(async () => {
    await withRlsBypass((tx) => tx.memberPhoto.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } }));
    await withRlsBypass((tx) => tx.member.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } }));
    await withRlsBypass((tx) => tx.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } }));
  });

  it("staff lists photos for a member in their tenant", async () => {
    mockAuth.mockResolvedValue({ user: { id: "owner-1", tenantId, role: "owner", email: "owner" } } as never);
    const res = await staffPhotos(req(), { params: Promise.resolve({ id: memberId }) });
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ url: string }>;
    expect(body.length).toBe(1);
    expect(body[0].url).toBe("https://blob.example/p1.png");
  });

  it("non-staff (member role) returns 403", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u", memberId: "x", tenantId, role: "member", email: "u" } } as never);
    const res = await staffPhotos(req(), { params: Promise.resolve({ id: memberId }) });
    expect(res.status).toBe(403);
  });

  it("cross-tenant memberId returns 404", async () => {
    mockAuth.mockResolvedValue({ user: { id: "owner-1", tenantId, role: "owner", email: "owner" } } as never);
    const res = await staffPhotos(req(), { params: Promise.resolve({ id: otherTenantMemberId }) });
    expect(res.status).toBe(404);
  });
});
