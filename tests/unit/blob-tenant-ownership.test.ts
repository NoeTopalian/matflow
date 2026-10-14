/**
 * Cross-tenant blob ownership (security review of PR #31, residual I-1 owner
 * path; fixed 14 Oct 2026). A club could submit ANOTHER club's blob URL as a
 * photo and, on replace or delete, have the other club's store file deleted.
 * isTenantBlobUrl pins a blob URL to this club's `/tenants/<id>/` namespace;
 * the rank route refuses a foreign URL at accept time and never passes a
 * foreign stored URL to del(). @vercel/blob is mocked: no real file is ever
 * touched to prove this.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));

const m = vi.hoisted(() => ({
  del: vi.fn(async () => {}),
  photoCreate: vi.fn(async () => ({ id: "ph-new" })),
  photoDeleteMany: vi.fn(async () => ({ count: 1 })),
  oldPhotos: [] as Array<{ id: string; url: string }>,
}));

vi.mock("@vercel/blob", () => ({ del: m.del }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "u1", tenantId: "t-A", role: "owner" } })) }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/push", () => ({ sendPushToMember: vi.fn(async () => {}) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      member: { findFirst: vi.fn(async () => ({ id: "m-1", name: "M", tenantId: "t-A" })) },
      rankSystem: { findFirst: vi.fn(async () => ({ id: "r1", tenantId: "t-A", discipline: "BJJ", name: "Blue", color: "#00a", order: 1 })) },
      memberRank: {
        findFirst: vi.fn(async () => ({ id: "mr-1", rankSystemId: "r1", stripes: 0, rankSystem: { discipline: "BJJ" } })),
        update: vi.fn(async () => ({ id: "mr-1", rankSystemId: "r1", stripes: 0, achievedAt: new Date(), rankSystem: { discipline: "BJJ", name: "Blue", color: "#00a" } })),
        create: vi.fn(async () => ({ id: "mr-1", rankSystemId: "r1", stripes: 0, achievedAt: new Date(), rankSystem: { discipline: "BJJ", name: "Blue", color: "#00a" } })),
        findMany: vi.fn(async () => []),
      },
      memberPhoto: { findMany: vi.fn(async () => m.oldPhotos), deleteMany: m.photoDeleteMany, create: m.photoCreate },
      classSubscription: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      $queryRaw: vi.fn(async () => []),
    }),
  withRlsBypass: vi.fn(),
}));

import { isTenantBlobUrl, isVercelBlobUrl, isForeignBlobUrl } from "@/lib/blob-url";
import { POST as rankAward } from "@/app/api/members/[id]/rank/route";

const OWN = "https://abc123.private.blob.vercel-storage.com/tenants/t-A/photo-1.jpg";
const FOREIGN = "https://abc123.private.blob.vercel-storage.com/tenants/t-B/photo-9.jpg";
const UNPREFIXED = "https://abc123.private.blob.vercel-storage.com/photo-legacy.jpg";

function req(body: unknown): Request {
  return { url: "https://x/api/members/m-1/rank", headers: new Headers({ "content-type": "application/json" }), json: async () => body } as unknown as Request;
}
const params = { params: Promise.resolve({ id: "m-1" }) };

beforeEach(() => { vi.clearAllMocks(); m.oldPhotos = []; });

describe("isTenantBlobUrl", () => {
  it("accepts only our store under this club's namespace", () => {
    expect(isVercelBlobUrl(OWN)).toBe(true);
    expect(isTenantBlobUrl(OWN, "t-A")).toBe(true);
    expect(isTenantBlobUrl(FOREIGN, "t-A")).toBe(false);
    expect(isTenantBlobUrl(UNPREFIXED, "t-A")).toBe(false);
    expect(isTenantBlobUrl("https://evil.example/tenants/t-A/x.jpg", "t-A")).toBe(false);
    expect(isTenantBlobUrl("data:image/png;base64,AAAA", "t-A")).toBe(false);
    expect(isTenantBlobUrl(OWN, "")).toBe(false);
    // prefix must be a whole path segment
    expect(isTenantBlobUrl("https://abc123.private.blob.vercel-storage.com/tenants/t-AB/x.jpg", "t-A")).toBe(false);
    // M-1: encoded separators and dot-segments never pass, wherever they sit
    expect(isTenantBlobUrl("https://abc123.private.blob.vercel-storage.com/tenants/t-A/..%2Ftenants%2Ft-B%2Fx.jpg", "t-A")).toBe(false);
    expect(isTenantBlobUrl("https://abc123.private.blob.vercel-storage.com/tenants/t-A/%2e%2e/t-B/x.jpg", "t-A")).toBe(false);
    expect(isTenantBlobUrl("https://abc123.private.blob.vercel-storage.com/tenants/t-A/x%5Cy.jpg", "t-A")).toBe(false);
  });

  it("isForeignBlobUrl is case-insensitive on the scheme and host (I-2) and ignores non-blob URLs", () => {
    expect(isForeignBlobUrl("HTTPS://ABC123.PRIVATE.BLOB.VERCEL-STORAGE.COM/tenants/t-B/x.jpg", "t-A")).toBe(true);
    expect(isForeignBlobUrl(FOREIGN, "t-A")).toBe(true);
    expect(isForeignBlobUrl(OWN, "t-A")).toBe(false);
    expect(isForeignBlobUrl("data:image/png;base64,AAAA", "t-A")).toBe(false);
    expect(isForeignBlobUrl("/api/blob/abc", "t-A")).toBe(false);
  });
});

describe("rank award — foreign blob URLs", () => {
  it("a foreign club's blob URL is refused at accept time; nothing written, nothing deleted", async () => {
    const res = await rankAward(req({ rankSystemId: "r1", photoUrl: FOREIGN }), params);
    expect(res.status).toBe(400);
    expect(m.photoCreate).not.toHaveBeenCalled();
    expect(m.del).not.toHaveBeenCalled();
  });

  it("an upper-case scheme does not slip a foreign URL past the accept check (I-2)", async () => {
    const res = await rankAward(req({ rankSystemId: "r1", photoUrl: "HTTPS://abc123.private.blob.vercel-storage.com/tenants/t-B/photo-9.jpg" }), params);
    expect(res.status).toBe(400);
    expect(m.photoCreate).not.toHaveBeenCalled();
  });

  it("our own blob URL is accepted (unchanged behaviour)", async () => {
    const res = await rankAward(req({ rankSystemId: "r1", photoUrl: OWN }), params);
    expect(res.status).toBe(200);
    expect(m.photoCreate).toHaveBeenCalledTimes(1);
  });

  it("a stored foreign URL is never passed to del() when photos are replaced", async () => {
    m.oldPhotos = [{ id: "p1", url: FOREIGN }, { id: "p2", url: OWN }, { id: "p3", url: "data:image/png;base64,AAAA" }];
    const res = await rankAward(req({ rankSystemId: "r1", photoUrl: OWN }), params);
    expect(res.status).toBe(200);
    expect(m.del).toHaveBeenCalledTimes(1);
    expect(m.del).toHaveBeenCalledWith([OWN]);
  });

  it("data: URLs keep working without any blob checks", async () => {
    const res = await rankAward(req({ rankSystemId: "r1", photoUrl: "data:image/png;base64,AAAA" }), params);
    expect(res.status).toBe(200);
    expect(m.del).not.toHaveBeenCalled();
  });
});
