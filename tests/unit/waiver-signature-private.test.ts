import { vi, describe, it, expect, beforeEach } from "vitest";

// Fix 2 — authed proxy for signature blob reads. The signature blob is written
// access:"private" (lib/waiver-signature-upload.ts) and /api/waiver/[id]/signature
// wraps it with auth + tenant scoping so the raw URL never leaves the server.
// A leaked client URL still 401s/403s without a session.
//
// The `https://blob.test/…` URLs below are deliberately NOT Vercel Blob hosts:
// they exercise the legacy / non-blob branch, which still uses a plain fetch.
// The Vercel-hosted branch is covered by its own describe at the bottom, where
// the credentialled `get()` reader is what must be called.

// Use the real next/server — the route uses both NextResponse.json() and
// new NextResponse(stream) so a custom mock would have to support both.
// Real implementation handles both cleanly.

const { findFirstMock, authMock, fetchMock, logAuditMock, blobGetMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  authMock: vi.fn(),
  fetchMock: vi.fn(),
  logAuditMock: vi.fn().mockResolvedValue(undefined),
  blobGetMock: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ get: blobGetMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    signedWaiver: { findFirst: findFirstMock },
  },
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: message }),
  }),
}));

// Stub the global fetch so we don't actually hit Vercel Blob in tests.
beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
});

import { GET } from "@/app/api/waiver/[signedWaiverId]/signature/route";

function makeReq() {
  return new Request("http://localhost/api/waiver/sw-1/signature");
}
const params = (id: string) => ({ params: Promise.resolve({ signedWaiverId: id }) });

describe("GET /api/waiver/[id]/signature — Fix 2 authed proxy", () => {
  it("401 when unauthenticated", async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await GET(makeReq() as never, params("sw-1"));
    expect(res.status).toBe(401);
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404 when SignedWaiver belongs to a different tenant", async () => {
    authMock.mockResolvedValueOnce({
      user: { id: "u1", role: "owner", tenantId: "tenant-A" },
    } as never);
    findFirstMock.mockResolvedValueOnce(null);

    const res = await GET(makeReq() as never, params("sw-other"));
    expect(res.status).toBe(404);
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sw-other", tenantId: "tenant-A" },
      }),
    );
  });

  it("404 when row exists but signatureImageUrl is null", async () => {
    authMock.mockResolvedValueOnce({
      user: { id: "u1", role: "owner", tenantId: "tenant-A" },
    } as never);
    findFirstMock.mockResolvedValueOnce({ signatureImageUrl: null, memberId: "m1" });

    const res = await GET(makeReq() as never, params("sw-1"));
    expect(res.status).toBe(404);
  });

  it("403 when a different member tries to view someone else's signature", async () => {
    authMock.mockResolvedValueOnce({
      user: { id: "u-member", role: "member", tenantId: "tenant-A", memberId: "m-other" },
    } as never);
    findFirstMock.mockResolvedValueOnce({
      signatureImageUrl: "https://blob.test/sig.png",
      memberId: "m1",
    });

    const res = await GET(makeReq() as never, params("sw-1"));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("200 with image bytes when staff (owner) views", async () => {
    authMock.mockResolvedValueOnce({
      user: { id: "u1", role: "owner", tenantId: "tenant-A" },
    } as never);
    findFirstMock.mockResolvedValueOnce({
      signatureImageUrl: "https://blob.test/sig.png",
      memberId: "m1",
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream(),
    });

    const res = await GET(makeReq() as never, params("sw-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(fetchMock).toHaveBeenCalledWith("https://blob.test/sig.png");
  });

  it("200 when the member themselves views their own signature", async () => {
    authMock.mockResolvedValueOnce({
      user: { id: "u-member", role: "member", tenantId: "tenant-A", memberId: "m1" },
    } as never);
    findFirstMock.mockResolvedValueOnce({
      signatureImageUrl: "https://blob.test/sig.png",
      memberId: "m1",
    });
    fetchMock.mockResolvedValueOnce({ ok: true, body: new ReadableStream() });

    const res = await GET(makeReq() as never, params("sw-1"));
    expect(res.status).toBe(200);
  });

  it("200 when coach views (any staff role allowed)", async () => {
    authMock.mockResolvedValueOnce({
      user: { id: "u-coach", role: "coach", tenantId: "tenant-A" },
    } as never);
    findFirstMock.mockResolvedValueOnce({
      signatureImageUrl: "https://blob.test/sig.png",
      memberId: "m1",
    });
    fetchMock.mockResolvedValueOnce({ ok: true, body: new ReadableStream() });

    const res = await GET(makeReq() as never, params("sw-1"));
    expect(res.status).toBe(200);
  });

  it("502 when upstream blob fetch fails", async () => {
    authMock.mockResolvedValueOnce({
      user: { id: "u1", role: "owner", tenantId: "tenant-A" },
    } as never);
    findFirstMock.mockResolvedValueOnce({
      signatureImageUrl: "https://blob.test/sig.png",
      memberId: "m1",
    });
    fetchMock.mockResolvedValueOnce({ ok: false, body: null });

    const res = await GET(makeReq() as never, params("sw-1"));
    expect(res.status).toBe(502);
  });
});

// Audit 2026-09-20 #14. This branch used to resolve `head().downloadUrl` and
// fetch it bare. `downloadUrl` is the plain blob URL with `?download=1` and
// carries no credential, so against an access:"private" signature it 403'd and
// every rendered signature was a broken image. `get()` is the reader that
// sends the store token.
describe("GET /api/waiver/[id]/signature — private Vercel Blob reads", () => {
  const PRIVATE_BLOB = "https://abc123.blob.vercel-storage.com/tenants/tenant-A/waivers/sig-xyz.png";

  function staffViewing() {
    authMock.mockResolvedValueOnce({
      user: { id: "u1", role: "owner", tenantId: "tenant-A" },
    } as never);
    findFirstMock.mockResolvedValueOnce({ signatureImageUrl: PRIVATE_BLOB, memberId: "m1" });
  }

  it("reads the blob through get(url, { access: 'private' }) and never bare-fetches it", async () => {
    staffViewing();
    blobGetMock.mockResolvedValueOnce({ statusCode: 200, stream: new ReadableStream() });

    const res = await GET(makeReq() as never, params("sw-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(blobGetMock).toHaveBeenCalledWith(PRIVATE_BLOB, { access: "private" });
    // The whole point: no credential-less request to the blob host.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s when the store does not have the blob (get() returns null)", async () => {
    staffViewing();
    blobGetMock.mockResolvedValueOnce(null);

    const res = await GET(makeReq() as never, params("sw-1"));
    expect(res.status).toBe(404);
  });

  it("502s when the store answers with something other than 200", async () => {
    staffViewing();
    blobGetMock.mockResolvedValueOnce({ statusCode: 304, stream: null });

    const res = await GET(makeReq() as never, params("sw-1"));
    expect(res.status).toBe(502);
  });

  it("500s rather than leaking the blob error when the store throws", async () => {
    staffViewing();
    blobGetMock.mockRejectedValueOnce(new Error("No token found"));

    const res = await GET(makeReq() as never, params("sw-1"));
    expect(res.status).toBe(500);
  });
});
