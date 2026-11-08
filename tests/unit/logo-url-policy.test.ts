import { describe, it, expect, afterEach } from "vitest";
import { isAcceptableLogoUrl, logoUrlVerdict, LOGO_DATA_URL_MAX } from "@/lib/logo-url";
import { loginLogoPx, LOGIN_LOGO_PX } from "@/lib/login-lookup";

// T9b: the logo acceptance policy itself, independent of the settings route.

afterEach(() => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

describe("logoUrlVerdict", () => {
  it("accepts raster data: URLs inside the bound", () => {
    for (const t of ["png", "jpeg", "jpg", "webp"]) {
      expect(isAcceptableLogoUrl(`data:image/${t};base64,AAAA`, "t-A")).toBe(true);
    }
  });

  it("refuses SVG and non-base64 data: URLs", () => {
    expect(isAcceptableLogoUrl("data:image/svg+xml;base64,PHN2Zz4=", "t-A")).toBe(false);
    expect(isAcceptableLogoUrl("data:image/png,rawbytes", "t-A")).toBe(false);
    expect(isAcceptableLogoUrl("data:text/html;base64,PGgxPg==", "t-A")).toBe(false);
  });

  it("refuses a data: URL over 3 MB with a size message", () => {
    const v = logoUrlVerdict(`data:image/png;base64,${"A".repeat(LOGO_DATA_URL_MAX)}`, "t-A");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/too large/i);
  });

  it("accepts a blob URL only under this club's namespace", () => {
    expect(isAcceptableLogoUrl("https://s1.private.blob.vercel-storage.com/tenants/t-A/a.webp", "t-A")).toBe(true);
    expect(isAcceptableLogoUrl("https://s1.private.blob.vercel-storage.com/tenants/t-B/a.webp", "t-A")).toBe(false);
  });

  it("with a store token configured, refuses a blob URL on someone else's store", () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_ourstore_secret";
    expect(isAcceptableLogoUrl("https://ourstore.private.blob.vercel-storage.com/tenants/t-A/a.webp", "t-A")).toBe(true);
    expect(isAcceptableLogoUrl("https://theirs.private.blob.vercel-storage.com/tenants/t-A/a.webp", "t-A")).toBe(false);
  });

  it("refuses external https, root-relative and the blob proxy", () => {
    expect(isAcceptableLogoUrl("https://example.com/logo.png", "t-A")).toBe(false);
    expect(isAcceptableLogoUrl("/logo.png", "t-A")).toBe(false);
    expect(isAcceptableLogoUrl("/api/blob-image?url=https%3A%2F%2Fx", "t-A")).toBe(false);
    expect(isAcceptableLogoUrl("//example.com/logo.png", "t-A")).toBe(false);
  });
});

describe("loginLogoPx (T9b acceptance 4)", () => {
  it("renders the large size when the club chose lg", () => {
    expect(loginLogoPx("lg")).toBe(LOGIN_LOGO_PX.lg);
    expect(LOGIN_LOGO_PX.lg).toBeGreaterThan(LOGIN_LOGO_PX.md);
  });

  it("keeps the historical 120px for md, and falls back to md for anything else", () => {
    expect(loginLogoPx("md")).toBe(120);
    expect(loginLogoPx(undefined)).toBe(120);
    expect(loginLogoPx(null)).toBe(120);
    expect(loginLogoPx("huge")).toBe(120);
    expect(loginLogoPx("sm")).toBeLessThan(120);
  });
});
