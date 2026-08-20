import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * GET /api/blob-image must STREAM the blob's bytes, never redirect to it.
 *
 * The bug: uploads are written `access: "private"` (app/api/upload/route.ts),
 * and in @vercel/blob@2.3.3 `downloadUrl` is just the blob URL with
 * `?download=1` appended — no signature, no token — while the SDK's own reader
 * `get()` sends `authorization: Bearer <BLOB_READ_WRITE_TOKEN>`. So the old
 * 302 to `head(url).downloadUrl` handed the browser an unauthenticated URL for
 * a private object and every avatar in the app rendered as blank space.
 *
 * The second bug in the same handler: one bare `catch` turned a Blob outage, a
 * missing/invalid token and a genuinely absent file into an identical unlogged
 * 404 — an outage indistinguishable from "this member never uploaded a photo"
 * (docs/RULES.md §2).
 *
 * The SDK is mocked here because there is no BLOB_READ_WRITE_TOKEN available
 * to this repo and production credentials are off limits. That is fine for
 * what is being proved: the contract under test is what THIS route does with
 * the SDK's documented return shapes, and those shapes are read off
 * node_modules/@vercel/blob/dist/index.d.ts (get() resolves null for a missing
 * blob, throws otherwise, and resolves { statusCode: 200, stream, blob } on a
 * hit). See "What is NOT covered" at the foot of this file.
 */

const { getMock, headMock } = vi.hoisted(() => ({ getMock: vi.fn(), headMock: vi.fn() }));
vi.mock("@vercel/blob", () => ({ get: getMock, head: headMock }));

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { GET } from "@/app/api/blob-image/route";
import { auth } from "@/auth";

const mockAuth = vi.mocked(auth);

const TENANT = "tenant-A";
const OTHER_TENANT = "tenant-B";
const BLOB_URL = `https://store123.blob.vercel-storage.com/tenants/${TENANT}/abc-x1y2.webp`;

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** The shape @vercel/blob's get() resolves to on a hit (dist/index.d.ts). */
function blobHit(opts: { contentType?: string; bytes?: Uint8Array } = {}) {
  const bytes = opts.bytes ?? new Uint8Array([0x52, 0x49, 0x46, 0x46]);
  return {
    statusCode: 200 as const,
    stream: streamOf(bytes),
    headers: new Headers(),
    blob: {
      url: BLOB_URL,
      downloadUrl: `${BLOB_URL}?download=1`,
      pathname: `tenants/${TENANT}/abc-x1y2.webp`,
      contentType: opts.contentType ?? "image/webp",
      contentDisposition: "",
      cacheControl: "",
      size: bytes.byteLength,
      uploadedAt: new Date(),
      etag: "etag-1",
    },
  };
}

function req(url = BLOB_URL) {
  return new Request(`https://test.local/api/blob-image?url=${encodeURIComponent(url)}`);
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  mockAuth.mockResolvedValue({
    user: { id: "u-1", role: "member", tenantId: TENANT, email: "m@gym.test" },
  } as never);
  // head() is stubbed with a REALISTIC result on purpose. The route must not
  // call it, but if a future change reinstates the old redirect this makes the
  // mutation produce a genuine 302-to-downloadUrl, so the guards below fail on
  // the actual defect rather than incidentally on a undefined-property throw.
  headMock.mockResolvedValue(blobHit().blob);
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("GET /api/blob-image — serves bytes, not a redirect", () => {
  it("returns 200 with the image bytes and the blob's content type", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    getMock.mockResolvedValueOnce(blobHit({ bytes }));

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never answers with a redirect to the credential-free blob URL", async () => {
    getMock.mockResolvedValueOnce(blobHit());

    const res = await GET(req());

    // The precise defect: a 3xx whose Location is the private blob URL. A
    // browser following it arrives unauthenticated and renders nothing.
    expect(res.status).toBeLessThan(300);
    const location = res.headers.get("location");
    expect(location).toBeNull();
    expect(location ?? "").not.toContain("blob.vercel-storage.com");
  });

  it("reads through the authenticated SDK path, not head()", async () => {
    getMock.mockResolvedValueOnce(blobHit());

    await GET(req());

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith(BLOB_URL, { access: "private" });
    // head() only yields metadata plus that unauthenticated downloadUrl, so
    // reaching for it again would be the old bug returning.
    expect(headMock).not.toHaveBeenCalled();
  });

  it("sets a private, immutable cache policy and nosniff", async () => {
    getMock.mockResolvedValueOnce(blobHit());

    const res = await GET(req());

    const cache = res.headers.get("cache-control") ?? "";
    expect(cache).toContain("private");
    expect(cache).toMatch(/max-age=\d+/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses to serve a non-image content type as itself", async () => {
    // Serving bytes from OUR origin (rather than redirecting to Vercel's)
    // means a blob declaring text/html would be same-origin stored XSS.
    getMock.mockResolvedValueOnce(blobHit({ contentType: "text/html" }));

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });
});

describe("GET /api/blob-image — an outage is not an empty state", () => {
  it("returns 502 (not 404) when the Blob SDK throws", async () => {
    // What an unset BLOB_READ_WRITE_TOKEN actually does: the SDK throws
    // BlobError("Vercel Blob: No token found…") before any network call.
    getMock.mockRejectedValueOnce(new Error("Vercel Blob: No token found."));

    const res = await GET(req());

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; reference?: string };
    expect(body.error).not.toMatch(/not found/i);
    // apiError mints a reference and logs it, so the failure is diagnosable
    // instead of vanishing into a bare catch.
    expect(body.reference).toBeTruthy();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("returns 404 only when the blob is genuinely absent, and logs it", async () => {
    // get() resolves null (rather than throwing) for a missing blob.
    getMock.mockResolvedValueOnce(null);

    const res = await GET(req());

    expect(res.status).toBe(404);
    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain(`/tenants/${TENANT}/`);
  });

  it("does not answer 200 with an empty body on an unexpected status code", async () => {
    getMock.mockResolvedValueOnce({
      statusCode: 304,
      stream: null,
      headers: new Headers(),
      blob: { ...blobHit().blob, contentType: null, size: null },
    });

    const res = await GET(req());

    expect(res.status).toBe(502);
  });
});

describe("GET /api/blob-image — access controls must not regress", () => {
  it("401s an unauthenticated caller without touching the store", async () => {
    mockAuth.mockResolvedValueOnce(null as never);

    const res = await GET(req());

    expect(res.status).toBe(401);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("403s a blob outside the caller's tenant prefix", async () => {
    const foreign = `https://store123.blob.vercel-storage.com/tenants/${OTHER_TENANT}/secret.webp`;

    const res = await GET(req(foreign));

    expect(res.status).toBe(403);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("403s a tenant id that merely prefixes the caller's own", async () => {
    // `/tenants/tenant-A` must not satisfy the prefix for `/tenants/tenant-AB/`.
    mockAuth.mockResolvedValueOnce({
      user: { id: "u-1", role: "member", tenantId: "tenant-AB", email: "m@gym.test" },
    } as never);

    const res = await GET(req(BLOB_URL));

    expect(res.status).toBe(403);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("400s a URL that is not a Vercel Blob host", async () => {
    const res = await GET(req("https://evil.example.com/tenants/tenant-A/x.webp"));

    expect(res.status).toBe(400);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("400s when the url parameter is missing entirely", async () => {
    const res = await GET(new Request("https://test.local/api/blob-image"));

    expect(res.status).toBe(400);
    expect(getMock).not.toHaveBeenCalled();
  });
});

/**
 * What is NOT covered here, stated rather than implied:
 *
 *  - That a real private blob is actually fetchable with a real token. There
 *    is no BLOB_READ_WRITE_TOKEN in this environment, so the SDK is mocked and
 *    the network leg is unexercised. What IS established from source is the
 *    reason the old shape could not work: `downloadUrl` carries no credential.
 *  - Backpressure / large-file streaming behaviour. The tests read the whole
 *    body, so a chunked stream is proved to arrive intact but nothing here
 *    measures memory or time on a large object.
 *  - That the browser honours the cache policy. Only the header is asserted.
 */
