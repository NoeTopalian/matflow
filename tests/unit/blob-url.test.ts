import { describe, it, expect } from "vitest";
import { isVercelBlobUrl, toBlobProxyUrl } from "@/lib/blob-url";

// Regression: a bare-host blob URL (no store-id subdomain) — a shape the upload
// route can return (see tests/unit/upload-blob.test.ts) — was rejected by the
// host matcher, surfacing as "Invalid data" when saving a profile picture.
describe("isVercelBlobUrl", () => {
  it("accepts the bare host (no store subdomain)", () => {
    expect(isVercelBlobUrl("https://blob.vercel-storage.com/tenants/t/abc.webp")).toBe(true);
  });

  it("accepts a single store-id subdomain", () => {
    expect(isVercelBlobUrl("https://store123.blob.vercel-storage.com/x.webp")).toBe(true);
  });

  it("accepts the public store subdomain shape", () => {
    expect(isVercelBlobUrl("https://store123.public.blob.vercel-storage.com/x.webp")).toBe(true);
  });

  it("stays a strict allowlist — rejects look-alike / spoofed hosts", () => {
    expect(isVercelBlobUrl("https://evil.com/blob.vercel-storage.com/x")).toBe(false);
    expect(isVercelBlobUrl("https://blob.vercel-storage.com.evil.com/x")).toBe(false);
    expect(isVercelBlobUrl("http://blob.vercel-storage.com/x")).toBe(false); // not https
    expect(isVercelBlobUrl("data:image/webp;base64,AAAA")).toBe(false);
  });
});

describe("toBlobProxyUrl", () => {
  it("routes bare-host blob URLs through the image proxy", () => {
    const out = toBlobProxyUrl("https://blob.vercel-storage.com/t/a.webp");
    expect(out).toBe("/api/blob-image?url=" + encodeURIComponent("https://blob.vercel-storage.com/t/a.webp"));
  });

  it("passes non-blob (data:) URLs through unchanged", () => {
    expect(toBlobProxyUrl("data:image/webp;base64,AAAA")).toBe("data:image/webp;base64,AAAA");
  });
});
