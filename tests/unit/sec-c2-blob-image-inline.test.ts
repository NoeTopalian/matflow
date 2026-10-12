/**
 * SF-28 follow-up / SF-42 (lane C2, 9 Oct 2026): /api/blob-image renders only RASTER images inline.
 * An `image/svg+xml` object (a document that can carry script) already in the club's own store must
 * be served as an opaque attachment from our origin, never inline, and every response carries a
 * sandbox CSP. Red against HEAD: the SVG cells answered `image/svg+xml` + `inline`.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock("@vercel/blob", () => ({ get: getMock, head: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { GET } from "@/app/api/blob-image/route";
import { auth } from "@/auth";

const TENANT = "secC2-tenant-A";
const TOKEN = "vercel_blob_rw_secC2store01_synthetic0000";
const OWN = (name: string) => `https://secC2store01.private.blob.vercel-storage.com/tenants/${TENANT}/${name}`;

function hit(contentType: string) {
  return {
    statusCode: 200 as const,
    stream: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([0x3c])); c.close(); } }),
    headers: new Headers(),
    blob: { url: "x", downloadUrl: "x", pathname: "x", contentType, contentDisposition: "", cacheControl: "", size: 1, uploadedAt: new Date(), etag: "e" },
  };
}
const req = (url: string) => new Request(`http://localhost/api/blob-image?url=${encodeURIComponent(url)}`);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BLOB_READ_WRITE_TOKEN = TOKEN;
  vi.mocked(auth).mockResolvedValue({ user: { id: "secC2-u1", tenantId: TENANT, role: "owner" } } as never);
});

describe("/api/blob-image inline policy", () => {
  it.each(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "IMAGE/WEBP; charset=binary"])(
    "positive control: raster %s is served inline as an image",
    async (type) => {
      getMock.mockResolvedValue(hit(type));
      const res = await GET(req(OWN("a.webp")));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(type.toLowerCase().split(";")[0].trim());
      expect(res.headers.get("content-disposition")).toBe("inline");
    },
  );

  it.each(["image/svg+xml", "image/svg+xml; charset=utf-8", "IMAGE/SVG+XML", "text/html", "application/xhtml+xml", "image/x-icon", "application/pdf", ""])(
    "%j is served as an opaque attachment, never inline",
    async (type) => {
      getMock.mockResolvedValue(hit(type));
      const res = await GET(req(OWN("evil.svg")));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toBe("attachment");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    },
  );

  it("every response carries a sandbox CSP (a mis-typed document opened directly stays inert)", async () => {
    getMock.mockResolvedValue(hit("image/webp"));
    const csp = (await GET(req(OWN("a.webp")))).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox");
    expect(csp).not.toMatch(/script-src/);
  });
});
