import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { lookupTenantWithAbort } from "@/lib/login-lookup";
import type { GymBranding } from "@/lib/login-lookup";

const MOCK_BRANDING: GymBranding = {
  name: "Total BJJ",
  slug: "totalbjj",
  logoUrl: "https://example.com/logo.png",
  primaryColor: "#ff0000",
  secondaryColor: "#000000",
  textColor: "#ffffff",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lookupTenantWithAbort", () => {
  it("single lookup succeeds — returns branding, not aborted", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => MOCK_BRANDING,
    } as Response);

    const controller = new AbortController();
    const result = await lookupTenantWithAbort("totalbjj", controller);

    expect(result.aborted).toBe(false);
    expect(result.error).toBeNull();
    expect(result.branding).toEqual(MOCK_BRANDING);
  });

  it("aborted request — returns aborted:true and never applies branding", async () => {
    // Simulate a slow fetch: abort before the promise resolves
    const controller = new AbortController();

    vi.mocked(fetch).mockImplementationOnce(async (_url, options) => {
      // Abort during the in-flight request
      controller.abort();
      // Throw as a real aborted fetch would
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      throw err;
    });

    const result = await lookupTenantWithAbort("abc", controller);

    expect(result.aborted).toBe(true);
    expect(result.branding).toBeNull();
    expect(result.error).toBeNull();
  });

  it("two concurrent lookups — only last-write wins, first is aborted", async () => {
    let resolveFirst!: (v: Response) => void;
    const firstFetch = new Promise<Response>((res) => { resolveFirst = res; });

    const callOrder: string[] = [];

    vi.mocked(fetch)
      .mockImplementationOnce((_url) => {
        callOrder.push("first-started");
        return firstFetch;
      })
      .mockImplementationOnce((_url) => {
        callOrder.push("second-started");
        return Promise.resolve({
          ok: true,
          json: async () => MOCK_BRANDING,
        } as Response);
      });

    const controller1 = new AbortController();
    const controller2 = new AbortController();

    // Start first lookup, do NOT await yet
    const firstPromise = lookupTenantWithAbort("abc", controller1);

    // Abort first (simulating what GymCodeStep does on a new keystroke)
    controller1.abort();

    // Start second lookup
    const secondPromise = lookupTenantWithAbort("totalbjj", controller2);

    // Now resolve the first fetch response (arrives late, after abort)
    resolveFirst({
      ok: true,
      json: async () => ({ ...MOCK_BRANDING, slug: "abc" }),
    } as Response);

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.aborted).toBe(true);
    expect(first.branding).toBeNull();

    expect(second.aborted).toBe(false);
    expect(second.branding).toEqual(MOCK_BRANDING);
    expect(callOrder).toContain("second-started");
  });

  it("404 response — returns branding:null and error message", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: "not found" }),
    } as Response);

    const controller = new AbortController();
    const result = await lookupTenantWithAbort("fakegym", controller);

    expect(result.aborted).toBe(false);
    expect(result.branding).toBeNull();
    expect(result.error).toBe("Club not found. Check your code and try again.");
  });

  it("network error — returns branding:null and generic error message", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network failure"));

    const controller = new AbortController();
    const result = await lookupTenantWithAbort("totalbjj", controller);

    expect(result.aborted).toBe(false);
    expect(result.branding).toBeNull();
    expect(result.error).toBe("Something went wrong. Please try again.");
  });
});
