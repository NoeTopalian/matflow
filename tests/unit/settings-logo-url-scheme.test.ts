// Campaign lane L-B, J12 round 2: `logoUrl` accepted any URL scheme.
//
// The run's exact failure (tests/e2e/campaign/assess/lb-1-club-setup.spec.ts:417):
//
//   Error: an SVG with a script as the logo is refused, never a 500
//   Expected: >= 400   Received: 200
//
// `updateSchema.logoUrl` was a union whose FIRST branch was a bare
// `z.string().url()`. Zod's `.url()` is `new URL()`, which happily parses
// `data:image/svg+xml;base64,…`, `javascript:alert(1)` and `file:///etc/passwd`
// — so the two branches that follow it (an app-relative path, and a data: URL
// narrowed to png/jpeg/webp with a 3 MB bound) never got a say. The stored
// value is rendered as the club's logo on the member portal and the kiosk, so a
// script-bearing SVG data URL is stored XSS and a 20 MB data URL is an
// unbounded column write; the `httpsUrl()` helper three lines above in the same
// file was written for exactly this ("blocks javascript:/data:/file: URI XSS in
// stored links") and `logoUrl` was the one link field that did not use it.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { update } = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: { tenant: { update } } }));
vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: "u-1", tenantId: "t-A", role: "owner" } }),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: async () => {} }));
vi.mock("next/cache", () => ({ revalidateTag: () => {} }));

import { PATCH } from "@/app/api/settings/route";

function patchWith(body: unknown) {
  return PATCH(
    new Request("http://localhost:3847/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3847" },
      body: JSON.stringify(body),
    }),
  );
}

const svgWithScript =
  "data:image/svg+xml;base64," +
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString(
    "base64",
  );

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({ id: "t-A" });
});

describe("PATCH /api/settings refuses a logo URL it cannot safely render", () => {
  for (const [label, value] of [
    ["a script-bearing SVG data URL", svgWithScript],
    ["a bare svg+xml data URL", "data:image/svg+xml,%3Csvg%3E%3C/svg%3E"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a file: URL", "file:///etc/passwd"],
    ["a plain http:// URL", "http://evil.test/logo.png"],
    ["a data URL over the 3 MB bound", `data:image/png;base64,${"A".repeat(4_000_000)}`],
  ] as const) {
    it(`${label} is a 400 and nothing is written`, async () => {
      const res = await patchWith({ logoUrl: value });
      expect(res.status).toBe(400);
      expect(update).not.toHaveBeenCalled();
    });
  }

  for (const [label, value] of [
    ["an https blob URL", "https://abc123.public.blob.vercel-storage.com/tenants/t-A/logo.png"],
    ["an app-relative path", "/uploads/logo.png"],
    ["a png data URL inside the bound", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="],
    ["a webp data URL", "data:image/webp;base64,UklGRhIAAABXRUJQ"],
  ] as const) {
    it(`${label} is still accepted`, async () => {
      const res = await patchWith({ logoUrl: value });
      expect(res.status).toBe(200);
      expect(update).toHaveBeenCalledTimes(1);
    });
  }

  it("clearing the logo with null is still accepted", async () => {
    const res = await patchWith({ logoUrl: null });
    expect(res.status).toBe(200);
  });
});
