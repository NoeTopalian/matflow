/**
 * Security campaign iteration 2, lane E3 (9 Oct 2026) — review R2 coordinator residual: /api/upload sets
 * sharp's limitInputPixels to 50 MP (SEC-051, lane D F4), but no test pinned it: sec-d-image-bounds runs its own copy
 * of the pipeline, so deleting the option from the ROUTE kept every test green. This file mocks sharp and asserts the
 * route itself passes the bound for the uploaded bytes, on both resize branches.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The fake prisma below does not model the RateLimitHit store; the limiter is assumed to allow (lane C4, R6-N3).
vi.mock("@/lib/rate-limit", async (orig) => (await import("./sec-c4-allow-rate-limit")).allowRateLimit(orig));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

const { sharpMock } = vi.hoisted(() => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    c.rotate = vi.fn(() => c);
    c.resize = vi.fn(() => c);
    c.webp = vi.fn(() => c);
    c.toBuffer = vi.fn(async () => Buffer.from("RIFF0000WEBPVP8 "));
    c.metadata = vi.fn(async () => ({ width: 4, height: 4 }));
    return c;
  };
  return { sharpMock: vi.fn((_input?: unknown, _opts?: unknown) => chain()) };
});
vi.mock("sharp", () => ({ default: sharpMock }));
vi.mock("@vercel/blob", () => ({ put: vi.fn() }));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: vi.fn(async () => ({ ok: true, session: {}, tenantId: "tenant-E3", userId: "user-E3", role: "owner" })),
}));
vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "user-E3", tenantId: "tenant-E3", role: "member", memberId: "member-E3" } })),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>) =>
    fn({ member: { findFirst: async () => ({ id: "member-E3" }) } }),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { POST } from "@/app/api/upload/route";

// A PNG signature passes the route's magic-byte check; sharp is mocked, so nothing is decoded.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

function req(purpose: string | null) {
  const fd = new FormData();
  fd.append("file", new File([PNG as BlobPart], "x.png", { type: "image/png" }));
  if (purpose === "profile-pic") fd.append("targetMemberId", "member-E3");
  const q = purpose ? `?purpose=${purpose}` : "";
  return new Request(`http://localhost/api/upload${q}`, { method: "POST", body: fd });
}

beforeEach(() => {
  sharpMock.mockClear();
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

describe("/api/upload bounds image decoding at 50 MP (SEC-051)", () => {
  it.each([
    ["branding (owner, fit inside)", null],
    ["profile-pic (member self, cover crop)", "profile-pic"],
  ])("%s: the uploaded bytes are opened with limitInputPixels 50_000_000", async (_label, purpose) => {
    const res = await POST(req(purpose));
    expect(res.status).toBe(200); // positive control: the request is accepted and processed
    const uploadCall = sharpMock.mock.calls.find(([input]) => Buffer.isBuffer(input) && (input as Buffer).subarray(0, 8).equals(Buffer.from(PNG.subarray(0, 8))));
    expect(uploadCall, "sharp was never called on the uploaded bytes").toBeTruthy();
    expect(uploadCall![1]).toMatchObject({ limitInputPixels: 50_000_000 });
  });

  it("no sharp call on the uploaded bytes is left unbounded", async () => {
    await POST(req(null));
    for (const [input, opts] of sharpMock.mock.calls) {
      if (Buffer.isBuffer(input) && (input as Buffer).subarray(0, 8).equals(Buffer.from(PNG.subarray(0, 8)))) {
        const limit = (opts as { limitInputPixels?: unknown } | undefined)?.limitInputPixels;
        expect(typeof limit === "number" && limit > 0 && limit <= 50_000_000).toBe(true);
      }
    }
  });
});
