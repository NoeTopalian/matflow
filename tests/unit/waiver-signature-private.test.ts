import { vi, describe, it, expect, beforeEach } from "vitest";

// Fix 2 — authed proxy for signature blob reads. The Vercel Blob URL is
// public at the SDK level (v0.27.3 only supports access:"public"), but
// /api/waiver/[id]/signature wraps it with auth + tenant scoping so the
// raw URL never leaves the server. A leaked client URL still 401s/403s
// without a session.

// Use the real next/server — the route uses both NextResponse.json() and
// new NextResponse(stream) so a custom mock would have to support both.
// Real implementation handles both cleanly.

const { findFirstMock, authMock, fetchMock, logAuditMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  authMock: vi.fn(),
  fetchMock: vi.fn(),
  logAuditMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
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
