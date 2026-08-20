import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";
import sharp from "sharp";
import { isVercelBlobUrl } from "@/lib/blob-url";

// /api/upload writes to Vercel Blob (never the local filesystem, which is
// read-only on Vercel). Pipeline: validate magic bytes → sharp resize to WebP →
// put() to Blob, falling back to an inline data:image/webp URL when the Blob
// store is unavailable. Acceptance criteria covered here:
//  - PNG and JPEG inputs both succeed end-to-end (resized to WebP)
//  - successful blob upload → { url } passes isVercelBlobUrl
//  - no BLOB token → graceful inline data:image/webp fallback (never a hard 503)
//  - bytes that don't match the declared image type are rejected

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

const { putMock, delMock } = vi.hoisted(() => ({ putMock: vi.fn(), delMock: vi.fn() }));
vi.mock("@vercel/blob", () => ({ put: putMock, del: delMock }));

vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: vi.fn(async () => ({
    ok: true,
    session: {} as unknown,
    tenantId: "tenant-X",
    userId: "user-1",
    role: "owner",
  })),
}));

vi.mock("@/lib/authz", () => ({
  requireOwner: vi.fn(async () => ({
    session: {} as unknown,
    tenantId: "tenant-X",
    userId: "user-1",
    role: "owner",
  })),
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { POST } from "@/app/api/upload/route";
import { POST as deleteOrphan } from "@/app/api/upload/delete-orphan/route";
import { auth } from "@/auth";

const mockAuth = vi.mocked(auth);

// Valid, decodable image bytes (sharp can actually re-encode these to WebP —
// a bare PNG header with no IDAT would make sharp throw a 400).
let PNG_BYTES: Uint8Array;
let JPEG_BYTES: Uint8Array;

beforeAll(async () => {
  const base = { create: { width: 4, height: 4, channels: 3 as const, background: { r: 255, g: 0, b: 0 } } };
  PNG_BYTES = new Uint8Array(await sharp(base).png().toBuffer());
  JPEG_BYTES = new Uint8Array(await sharp({ ...base, create: { ...base.create, background: { r: 0, g: 255, b: 0 } } }).jpeg().toBuffer());
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

function makeUploadReq(bytes: Uint8Array, type: string, name: string) {
  const fd = new FormData();
  fd.append("file", new File([bytes as BlobPart], name, { type }));
  // Legacy owner-scoped path (matches the requireOwner mock). PNG/JPEG→WebP
  // conversion is identical across upload purposes, so this proves both formats.
  return new Request("http://localhost/api/upload", { method: "POST", body: fd });
}

describe("POST /api/upload", () => {
  const cases: Array<{ label: string; type: string; name: string; bytes: () => Uint8Array }> = [
    { label: "PNG", type: "image/png", name: "test.png", bytes: () => PNG_BYTES },
    { label: "JPEG", type: "image/jpeg", name: "test.jpg", bytes: () => JPEG_BYTES },
  ];

  for (const c of cases) {
    it(`${c.label}: returns a Vercel Blob URL on successful upload`, async () => {
      process.env.BLOB_READ_WRITE_TOKEN = "test-token";
      putMock.mockResolvedValueOnce({ url: "https://blob.vercel-storage.com/tenants/tenant-X/abc.webp" });

      const res = await POST(makeUploadReq(c.bytes(), c.type, c.name));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(isVercelBlobUrl(body.url)).toBe(true);
      expect(putMock).toHaveBeenCalledTimes(1);
      // Filename must be tenant-scoped so cross-tenant uploads can't collide.
      expect(putMock.mock.calls[0][0]).toContain("tenants/tenant-X/");
    });

    it(`${c.label}: falls back to an inline data:image/webp URL when no BLOB token`, async () => {
      const res = await POST(makeUploadReq(c.bytes(), c.type, c.name));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url.startsWith("data:image/webp;base64,")).toBe(true);
      expect(putMock).not.toHaveBeenCalled();
    });
  }

  it("rejects bytes that don't match the declared image type", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    const fakePng = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
    const res = await POST(makeUploadReq(fakePng, "image/png", "fake.png"));
    expect(res.status).toBe(400);
    expect(putMock).not.toHaveBeenCalled();
  });

  // The ingress cap governs only what may be SENT — every accepted image is
  // re-encoded to a bounded WebP below, so it never decides what is KEPT. At
  // 2MB it refused essentially every phone photo, which is what broke mobile
  // uploads. Padding a valid JPEG is the cheapest way to make a file of a
  // given size: the magic-byte check reads the first 12 bytes and a JPEG
  // decoder stops at the end-of-image marker, so the trailing bytes are inert
  // and only file.size is under test.
  function padded(bytes: Uint8Array, toSize: number): Uint8Array {
    const out = new Uint8Array(toSize);
    out.set(bytes);
    return out;
  }

  it("accepts a 3MB image — larger than a phone photo the old 2MB cap refused", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    putMock.mockResolvedValueOnce({ url: "https://blob.vercel-storage.com/tenants/tenant-X/a.webp" });

    const res = await POST(
      makeUploadReq(padded(JPEG_BYTES, 3 * 1024 * 1024), "image/jpeg", "phone.jpg"),
    );

    expect(res.status).toBe(200);
    expect(putMock).toHaveBeenCalledTimes(1);
  });

  // Asserts the INVARIANT, not the number. The cap must stay strictly below
  // Vercel's ~4.5MB serverless request-body limit: above it, the platform
  // rejects the upload with an opaque 413 before this route ever runs, so the
  // route's own friendly message can never fire and the user sees a raw
  // platform error. A cap of 6 advertised a size the product could not accept.
  // Pinning the literal here is what let that drift go unnoticed, so this test
  // reads the limit out of the message instead of restating it.
  it("refuses an oversized image, names its own limit, and keeps that limit under Vercel's body cap", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";

    const res = await POST(
      makeUploadReq(padded(JPEG_BYTES, 7 * 1024 * 1024), "image/jpeg", "huge.jpg"),
    );

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/^That image is too large\. The limit is \d+MB — try a smaller photo\.$/);

    const advertisedMb = Number(error.match(/(\d+)MB/)![1]);
    // Strictly below the platform limit, with no fractional cap to round past it.
    expect(advertisedMb).toBeLessThan(4.5);

    expect(putMock).not.toHaveBeenCalled();
  });

  // The dead zone the old cap created: between the platform limit and the
  // route's own cap, a file was accepted by the route's arithmetic but killed
  // by Vercel first. Nothing in this size range may reach `put`.
  it("refuses a 5MB image — the size the old 6MB cap wrongly advertised as allowed", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";

    const res = await POST(
      makeUploadReq(padded(JPEG_BYTES, 5 * 1024 * 1024), "image/jpeg", "dead-zone.jpg"),
    );

    expect(res.status).toBe(400);
    expect(putMock).not.toHaveBeenCalled();
  });
});

// Uploads are private since Bug 3, so blob hosts no longer carry a `.public.`
// label. The orphan-cleanup validator used to require that shape, which meant
// every current URL 400'd and the blob stayed orphaned forever.
describe("POST /api/upload/delete-orphan", () => {
  function makeOrphanReq(url: string) {
    return new Request("http://localhost/api/upload/delete-orphan", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  }

  beforeEach(() => {
    mockAuth.mockResolvedValue({ user: { tenantId: "tenant-X" } } as never);
  });

  it("accepts a private-store blob URL in the caller's tenant prefix", async () => {
    const url = "https://abc123.blob.vercel-storage.com/tenants/tenant-X/x.webp";
    const res = await deleteOrphan(makeOrphanReq(url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(delMock).toHaveBeenCalledWith(url);
  });

  it("rejects a non-blob host", async () => {
    const res = await deleteOrphan(makeOrphanReq("https://evil.com/tenants/tenant-X/x.webp"));
    expect(res.status).toBe(400);
    expect(delMock).not.toHaveBeenCalled();
  });
});
