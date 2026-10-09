// Security campaign lane C — SEC-039 (SSRF / cloud credential exposure) and
// SEC-041 (XSS) through GET /api/blob-image.
//
// Finding SF-C1 (9 Oct 2026): lib/blob-url.ts accepted ANY *.blob.vercel-storage.com
// host. /api/blob-image checks only that the URL's PATH starts with the caller's
// /tenants/<tenantId>/ prefix, so a URL on a store MatFlow does not own (any free
// Vercel account can create one) passed both checks. The route then called
// @vercel/blob get(url), which sends `authorization: Bearer <BLOB_READ_WRITE_TOKEN>`
// to that foreign host, and streamed the foreign object back from MatFlow's origin
// with the foreign object's declared Content-Type inline — image/svg+xml included.
// With 'unsafe-inline' in script-src (next.config.ts) an SVG <script> served that
// way runs in MatFlow's origin for any signed-in staff user who opens the link.
// The remote half (what a foreign public store returns to a request carrying our
// token) was NOT probed: third-party probing is out of scope. The local half is
// reproduced below with the SDK faked at its documented return shape.
//
// Fix: when BLOB_READ_WRITE_TOKEN names a store (vercel_blob_rw_<storeId>_…), only
// that store's hosts (<storeId>.private|public.blob.vercel-storage.com) count as
// Vercel Blob URLs. Without a well-formed token the matcher keeps its old,
// permissive shape (local/dev, unit tests), where get() cannot authenticate anyway.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock("@vercel/blob", () => ({ get: getMock, head: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { GET } from "@/app/api/blob-image/route";
import { auth } from "@/auth";
import { isVercelBlobUrl, toBlobProxyUrl } from "@/lib/blob-url";

const TENANT = "secC-tenant-A";
const TOKEN = "vercel_blob_rw_secCstore01_synthetic0000";
const OWN = `https://secCstore01.private.blob.vercel-storage.com/tenants/${TENANT}/a1.webp`;
const OWN_PUBLIC = `https://secCstore01.public.blob.vercel-storage.com/tenants/${TENANT}/a1.webp`;
const FOREIGN_SVG = `https://secCattacker.public.blob.vercel-storage.com/tenants/${TENANT}/evil.svg`;

function hit(contentType: string) {
  return {
    statusCode: 200 as const,
    stream: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([0x3c])); c.close(); } }),
    headers: new Headers(),
    blob: { url: "x", downloadUrl: "x", pathname: "x", contentType, contentDisposition: "", cacheControl: "", size: 1, uploadedAt: new Date(), etag: "e" },
  };
}
const req = (url: string) => new Request(`http://localhost/api/blob-image?url=${encodeURIComponent(url)}`);
const staff = () => vi.mocked(auth).mockResolvedValue({ user: { id: "secC-u1", tenantId: TENANT, role: "owner" } } as never);

let saved: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  saved = process.env.BLOB_READ_WRITE_TOKEN;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (saved === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = saved;
});

describe("SF-C1 /api/blob-image with a store token configured (production shape)", () => {
  beforeEach(() => { process.env.BLOB_READ_WRITE_TOKEN = TOKEN; });

  it("positive control: the club's own store, own tenant prefix → streamed", async () => {
    staff();
    getMock.mockResolvedValue(hit("image/webp"));
    const res = await GET(req(OWN));
    expect(res.status).toBe(200);
    expect(getMock).toHaveBeenCalledWith(OWN, { access: "private" });
  });

  it("positive control: the same store's public host is still accepted", async () => {
    staff();
    getMock.mockResolvedValue(hit("image/webp"));
    expect((await GET(req(OWN_PUBLIC))).status).toBe(200);
  });

  it("a foreign store URL with the caller's tenant prefix is refused before get() — the token is never sent", async () => {
    staff();
    getMock.mockResolvedValue(hit("image/svg+xml"));
    const res = await GET(req(FOREIGN_SVG));
    expect(res.status).toBe(400);
    expect(getMock).not.toHaveBeenCalled();
    expect(res.headers.get("content-type") ?? "").not.toContain("svg");
  });

  it.each([
    ["bare host", `https://blob.vercel-storage.com/tenants/${TENANT}/a.webp`],
    ["foreign private store", `https://secCother.private.blob.vercel-storage.com/tenants/${TENANT}/a.webp`],
    ["own id as a deeper label", `https://secCstore01.private.secCattacker.public.blob.vercel-storage.com/tenants/${TENANT}/a.webp`],
    ["userinfo trick", `https://secCstore01.private.blob.vercel-storage.com@evil.example/tenants/${TENANT}/a.webp`],
    ["suffix trick", `https://secCstore01.private.blob.vercel-storage.com.evil.example/tenants/${TENANT}/a.webp`],
    ["http scheme", `http://secCstore01.private.blob.vercel-storage.com/tenants/${TENANT}/a.webp`],
  ])("isVercelBlobUrl refuses %s", (_label, url) => {
    expect(isVercelBlobUrl(url)).toBe(false);
  });

  it("matching is case-insensitive on the host", () => {
    expect(isVercelBlobUrl(OWN.replace("secCstore01", "SECCSTORE01"))).toBe(true);
  });

  it("toBlobProxyUrl leaves a foreign-store URL unproxied (rendered as a plain cross-origin <img>, never via our origin)", () => {
    expect(toBlobProxyUrl(FOREIGN_SVG)).toBe(FOREIGN_SVG);
    expect(toBlobProxyUrl(OWN)).toBe(`/api/blob-image?url=${encodeURIComponent(OWN)}`);
  });
});

describe("SF-C1 without a well-formed token (local/dev/unit tests): unchanged permissive shape", () => {
  it.each([[undefined], ["test-token"], [""]])("token %j → any *.blob.vercel-storage.com host is a blob URL", (t) => {
    if (t === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = t;
    expect(isVercelBlobUrl(FOREIGN_SVG)).toBe(true);
    expect(isVercelBlobUrl(`https://blob.vercel-storage.com/x`)).toBe(true);
    expect(isVercelBlobUrl("https://evil.example/x")).toBe(false);
  });
});
