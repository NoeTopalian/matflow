import { vi, describe, it, expect, beforeEach } from "vitest";

// LB-002 (audit C10): /api/upload writes to Vercel Blob, never to the
// local filesystem (which is read-only on Vercel). Acceptance criteria:
//  - missing BLOB_READ_WRITE_TOKEN → 503 with helpful message
//  - successful upload → returns { url } that is the blob URL

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

const { putMock } = vi.hoisted(() => ({ putMock: vi.fn() }));
vi.mock("@vercel/blob", () => ({ put: putMock }));

vi.mock("@/lib/authz", () => ({
  requireOwner: vi.fn(async () => ({
    session: {} as unknown,
    tenantId: "tenant-X",
    userId: "user-1",
    role: "owner",
  })),
}));

import { POST } from "@/app/api/upload/route";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

// 1×1 PNG — minimal valid bytes (magic header + IHDR + IEND)
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
  0x00, 0x00, 0x00, 0x0d, // IHDR length
  0x49, 0x48, 0x44, 0x52, // IHDR
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
  0x1f, 0x15, 0xc4, 0x89, // CRC
]);

function makeUploadReq(bytes: Uint8Array, type = "image/png", name = "test.png") {
  const fd = new FormData();
  fd.append("file", new File([bytes as BlobPart], name, { type }));
  return new Request("http://localhost/api/upload", { method: "POST", body: fd });
}

describe("POST /api/upload", () => {
  it("returns 503 when BLOB_READ_WRITE_TOKEN is unset", async () => {
    const res = await POST(makeUploadReq(PNG_BYTES));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/BLOB_READ_WRITE_TOKEN/);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("returns the Vercel Blob URL on successful upload", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    putMock.mockResolvedValueOnce({ url: "https://blob.vercel-storage.com/tenants/tenant-X/abc.png" });

    const res = await POST(makeUploadReq(PNG_BYTES));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe("https://blob.vercel-storage.com/tenants/tenant-X/abc.png");
    expect(putMock).toHaveBeenCalledTimes(1);
    // Filename must be tenant-scoped so cross-tenant uploads can't collide
    expect(putMock.mock.calls[0][0]).toContain("tenants/tenant-X/");
  });

  it("rejects bytes that don't match the declared image type", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    const fakePng = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
    const res = await POST(makeUploadReq(fakePng));
    expect(res.status).toBe(400);
    expect(putMock).not.toHaveBeenCalled();
  });
});
