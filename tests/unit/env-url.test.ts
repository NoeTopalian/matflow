import { describe, it, expect, beforeEach } from "vitest";

const ORIGINAL = process.env.NEXTAUTH_URL;

beforeEach(() => {
  // Reset between tests to keep them isolated.
  if (ORIGINAL === undefined) delete process.env.NEXTAUTH_URL;
  else process.env.NEXTAUTH_URL = ORIGINAL;
});

describe("getBaseUrl — defensive NEXTAUTH_URL helper", () => {
  it("returns the value as-is when clean", async () => {
    process.env.NEXTAUTH_URL = "https://matflow.studio";
    const { getBaseUrl } = await import("@/lib/env-url");
    expect(getBaseUrl()).toBe("https://matflow.studio");
  });

  it("strips trailing newline (the original bug)", async () => {
    process.env.NEXTAUTH_URL = "https://matflow.studio\n";
    const { getBaseUrl } = await import("@/lib/env-url");
    expect(getBaseUrl()).toBe("https://matflow.studio");
  });

  it("strips leading + trailing whitespace + tabs", async () => {
    process.env.NEXTAUTH_URL = "  \t https://matflow.studio  \r\n";
    const { getBaseUrl } = await import("@/lib/env-url");
    expect(getBaseUrl()).toBe("https://matflow.studio");
  });

  it("strips a single trailing slash", async () => {
    process.env.NEXTAUTH_URL = "https://matflow.studio/";
    const { getBaseUrl } = await import("@/lib/env-url");
    expect(getBaseUrl()).toBe("https://matflow.studio");
  });

  it("strips multiple trailing slashes", async () => {
    process.env.NEXTAUTH_URL = "https://matflow.studio////";
    const { getBaseUrl } = await import("@/lib/env-url");
    expect(getBaseUrl()).toBe("https://matflow.studio");
  });

  it("preserves a path beyond the host", async () => {
    process.env.NEXTAUTH_URL = "https://example.com/app";
    const { getBaseUrl } = await import("@/lib/env-url");
    expect(getBaseUrl()).toBe("https://example.com/app");
  });

  it("falls back to req.url origin when env is missing", async () => {
    delete process.env.NEXTAUTH_URL;
    const { getBaseUrl } = await import("@/lib/env-url");
    const req = new Request("https://fallback.example.com/api/some/path?q=1");
    expect(getBaseUrl(req)).toBe("https://fallback.example.com");
  });

  it("falls back to req.url origin when env is whitespace-only", async () => {
    process.env.NEXTAUTH_URL = "   \n  ";
    const { getBaseUrl } = await import("@/lib/env-url");
    const req = new Request("https://fallback.example.com/api");
    expect(getBaseUrl(req)).toBe("https://fallback.example.com");
  });

  it("returns empty string when env missing AND no req provided", async () => {
    delete process.env.NEXTAUTH_URL;
    const { getBaseUrl } = await import("@/lib/env-url");
    expect(getBaseUrl()).toBe("");
  });

  it("env wins over req.url even when both present", async () => {
    process.env.NEXTAUTH_URL = "https://envwins.example.com";
    const { getBaseUrl } = await import("@/lib/env-url");
    const req = new Request("https://reqorigin.example.com/api");
    expect(getBaseUrl(req)).toBe("https://envwins.example.com");
  });
});
