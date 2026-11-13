// Fix re-review 4 (12 Nov 2026): the one stored spelling of a blob URL, and every spelling of a blob-store host.
import { describe, expect, it } from "vitest";
import { isBlobStoreHost, isCanonicalBlobUrl } from "@/lib/blob-url";

const BASE = "https://abc123.private.blob.vercel-storage.com/tenants/t1/photo.webp";

describe("isCanonicalBlobUrl", () => {
  it("accepts the stored spelling", () => {
    expect(isCanonicalBlobUrl(BASE)).toBe(true);
    expect(isCanonicalBlobUrl("https://abc123.public.blob.vercel-storage.com/tenants/t1/members/m1/a.png")).toBe(true);
  });
  it.each([
    ["a query", `${BASE}?v=1`],
    ["an empty query", `${BASE}?`],
    ["a fragment", `${BASE}#x`],
    ["an empty fragment", `${BASE}#`],
    ["an upper-case host", BASE.replace("abc123.private", "ABC123.PRIVATE")],
    ["credentials", BASE.replace("https://", "https://u:p@")],
    ["an explicit default port", BASE.replace(".com/", ".com:443/")],
    ["another port", BASE.replace(".com/", ".com:8443/")],
    ["a trailing-dot host", BASE.replace(".com/", ".com./")],
    ["a dot segment", BASE.replace("/tenants/", "/x/../tenants/")],
    ["an upper-case scheme", BASE.replace("https://", "HTTPS://")],
    ["an IDN host", "https://xn--bcher-kva.private.blob.vercel-storage.com/tenants/t1/photo.webp".replace("xn--bcher-kva", "b\u00fccher")],
    ["a protocol-relative URL", BASE.replace("https:", "")],
    ["not a URL", "not a url"],
  ])("refuses %s", (_what, url) => {
    expect(isCanonicalBlobUrl(url)).toBe(false);
  });
});

describe("the club-root rule leans on the namespace check for paths", () => {
  it("refuses a percent-encoded or dot-segment path even when it is otherwise canonical", async () => {
    const { isClubRootBlobUrl } = await import("@/lib/blob-ownership");
    expect(isClubRootBlobUrl("https://abc123.private.blob.vercel-storage.com/tenants/t1/photo.webp", "t1")).toBe(true);
    expect(isClubRootBlobUrl("https://abc123.private.blob.vercel-storage.com/tenants/t1/a%2Fb.webp", "t1")).toBe(false);
    expect(isClubRootBlobUrl("https://abc123.private.blob.vercel-storage.com/tenants/t1/members/m1/a.webp", "t1")).toBe(false);
  });
});

describe("isBlobStoreHost", () => {
  it.each([
    BASE,
    BASE.replace(".com/", ".com:443/"),
    BASE.replace(".com/", ".com./"),
    BASE.replace("abc123.private", "ABC123.PUBLIC"),
    "https://blob.vercel-storage.com/x",
    BASE.replace("https:", ""),
    BASE.replace("https://", "/\\"),
  ])("recognises %s", (url) => {
    expect(isBlobStoreHost(url)).toBe(true);
  });
  it.each(["https://evil.example/blob.vercel-storage.com/x", "https://blob.vercel-storage.com.evil.example/x", "https://notblob.vercel-storage.com/x", "nope"])(
    "does not claim %s",
    (url) => {
      expect(isBlobStoreHost(url)).toBe(false);
    },
  );
});
