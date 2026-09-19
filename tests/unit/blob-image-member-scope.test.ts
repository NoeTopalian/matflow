import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Lane L-C round 1, defect 2.
 *
 * `GET /api/blob-image` authorised by TENANT and nothing else: the only check
 * was that the URL's pathname started `/tenants/<session.tenantId>/`. Every
 * blob the app writes lives under that one prefix — member profile pictures,
 * evidence photos, and the raw CSV of a membership import
 * (`tenants/<id>/imports/<cuid>.csv`, app/api/admin/import/upload/route.ts:83).
 *
 * So any authenticated member of a club could fetch any blob of that club
 * whose URL they held: another member's photograph, or the whole roster with
 * e-mail addresses and phone numbers. The e2e proof was the status itself —
 * the route can only answer 403 for "not your namespace", so the 502 an
 * unrelated member received (no BLOB token in the test environment) meant the
 * authorisation had already PASSED and the request had reached the store.
 *
 * `addRandomSuffix` made the URLs unguessable, which is why this was a
 * boundary held by obscurity rather than an open directory. Obscurity is not
 * the boundary; this is.
 *
 * The contract now: staff read any blob of their own tenant (they can already
 * see every member's photo on the roster screen). A member reads only blobs
 * referenced by their own rows or their children's, and never the import
 * prefix.
 */

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock("@vercel/blob", () => ({ get: getMock, head: vi.fn() }));

const { photoFindFirstMock } = vi.hoisted(() => ({ photoFindFirstMock: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { memberPhoto: { findFirst: photoFindFirstMock } } }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { GET } from "@/app/api/blob-image/route";
import { auth } from "@/auth";

const mockAuth = vi.mocked(auth);

const TENANT = "tenant-A";
const PHOTO_URL = `https://store123.blob.vercel-storage.com/tenants/${TENANT}/abc-x1y2.webp`;
const IMPORT_CSV = `https://store123.blob.vercel-storage.com/tenants/${TENANT}/imports/deadbeef.csv`;

function sessionAs(role: string, memberId?: string) {
  mockAuth.mockResolvedValue({
    user: { id: "u1", role, tenantId: TENANT, ...(memberId ? { memberId } : {}) },
  } as unknown as Awaited<ReturnType<typeof auth>>);
}

function req(url: string) {
  return new Request(`http://localhost/api/blob-image?url=${encodeURIComponent(url)}`);
}

function blobHit() {
  return {
    statusCode: 200 as const,
    stream: new ReadableStream({ start: (c) => { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } }),
    headers: new Headers(),
    blob: { url: PHOTO_URL, contentType: "image/webp", pathname: `tenants/${TENANT}/abc-x1y2.webp` },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue(blobHit());
});

describe("GET /api/blob-image — a member may not read another member's blob", () => {
  it("refuses a blob no row of the member's own points at", async () => {
    sessionAs("member", "mem-snooper");
    photoFindFirstMock.mockResolvedValue(null); // nothing of theirs references it

    const res = await GET(req(PHOTO_URL));
    expect(res.status, "403 is the only refusal this route can give; a 404 or 502 means it was authorised").toBe(403);
    expect(getMock, "and the store is never even asked").not.toHaveBeenCalled();
  });

  it("serves a blob the member's own photo row points at", async () => {
    sessionAs("member", "mem-self");
    photoFindFirstMock.mockResolvedValue({ id: "photo-1" });

    const res = await GET(req(PHOTO_URL));
    expect(res.status).toBe(200);
    expect(getMock).toHaveBeenCalled();
  });

  it("scopes the lookup to the member AND their children, inside the tenant", async () => {
    sessionAs("member", "mem-parent");
    photoFindFirstMock.mockResolvedValue({ id: "photo-kid" });

    await GET(req(PHOTO_URL));
    const where = photoFindFirstMock.mock.calls[0][0].where;
    expect(where.url, "matched on the exact URL, not a prefix").toBe(PHOTO_URL);
    expect(where.tenantId, "…and still inside the tenant").toBe(TENANT);
    expect(JSON.stringify(where), "…covering the caller's own rows and their children's")
      .toMatch(/parentMemberId/);
  });

  it("never serves the import CSV to a member, whatever any row says", async () => {
    sessionAs("member", "mem-self");
    // Even in the impossible case that a photo row pointed at the CSV.
    photoFindFirstMock.mockResolvedValue({ id: "photo-1" });

    const res = await GET(req(IMPORT_CSV));
    expect(res.status, "the roster export is not an image and is not theirs").toBe(403);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("refuses a session with no member identity at all", async () => {
    sessionAs("member"); // no memberId on the token
    const res = await GET(req(PHOTO_URL));
    expect(res.status).toBe(403);
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/blob-image — staff keep the tenant-wide read they already had", () => {
  for (const role of ["owner", "manager", "admin", "coach"]) {
    it(`serves any blob of the tenant to a ${role} without a per-member lookup`, async () => {
      sessionAs(role);
      const res = await GET(req(PHOTO_URL));
      expect(res.status, `${role} reads the roster's photos on the members screen`).toBe(200);
      expect(photoFindFirstMock, "staff need no ownership lookup").not.toHaveBeenCalled();
    });
  }

  it("still refuses another club's blob to staff", async () => {
    sessionAs("owner");
    const res = await GET(req("https://store123.blob.vercel-storage.com/tenants/tenant-B/x.webp"));
    expect(res.status).toBe(403);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("still refuses a blob with no tenant prefix at all", async () => {
    sessionAs("owner");
    const res = await GET(req("https://store123.blob.vercel-storage.com/loose.webp"));
    expect(res.status).toBe(403);
  });

  it("still refuses a URL that is not a Vercel blob", async () => {
    sessionAs("owner");
    const res = await GET(req("https://evil.test/tenants/tenant-A/x.webp"));
    expect(res.status).toBe(400);
  });
});
