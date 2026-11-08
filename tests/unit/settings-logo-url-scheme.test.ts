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
// unbounded column write.
//
// T9b (17 Oct 2026, Q9 E-9 (a)): narrowed again. A logo must render with no
// session on the login page, kiosk, leaderboard and public club page, so the
// accepted shapes are a raster data: URL inside the bound, or a blob URL under
// THIS club's own namespace. External https:// images, root-relative paths
// (including /api/blob-image?url=…) and foreign-namespace blobs are refused.
// Existing values are not migrated: re-sending the stored value unchanged is
// not a new write and is let through (acceptance 5).
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { update, findUnique } = vi.hoisted(() => ({ update: vi.fn(), findUnique: vi.fn() }));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
// findUnique: the route reads the row before writing so the audit row can carry
// before/after for the owner’s Undo (1 Oct 2026), and (T9b) so an unchanged
// legacy logo is not refused. Null here = no stored row / no stored logo.
vi.mock("@/lib/prisma", () => ({ prisma: { tenant: { update, findUnique } } }));
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

const OWN_BLOB = "https://abc123.private.blob.vercel-storage.com/tenants/t-A/logo-x1y2.webp";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BLOB_READ_WRITE_TOKEN;
  update.mockResolvedValue({ id: "t-A" });
  findUnique.mockResolvedValue(null);
});

describe("PATCH /api/settings refuses a logo URL it cannot safely render", () => {
  for (const [label, value] of [
    ["a script-bearing SVG data URL", svgWithScript],
    ["a bare svg+xml data URL", "data:image/svg+xml,%3Csvg%3E%3C/svg%3E"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a file: URL", "file:///etc/passwd"],
    ["a plain http:// URL", "http://evil.test/logo.png"],
    ["a data URL over the 3 MB bound", `data:image/png;base64,${"A".repeat(4_000_000)}`],
    // T9b: the general https:// and root-relative branches are gone.
    ["an external https:// image", "https://cdn.example.com/logo.png"],
    ["an app-relative path", "/uploads/logo.png"],
    [
      "the authenticated blob proxy",
      `/api/blob-image?url=${encodeURIComponent(OWN_BLOB)}`,
    ],
    [
      "another club's blob namespace",
      "https://abc123.private.blob.vercel-storage.com/tenants/t-B/logo.webp",
    ],
    ["a blob URL outside any club namespace", "https://abc123.public.blob.vercel-storage.com/logo.webp"],
    [
      "a dot-segment escape from this club's namespace",
      "https://abc123.private.blob.vercel-storage.com/tenants/t-A/%2e%2e/t-B/logo.webp",
    ],
  ] as const) {
    it(`${label} is a 400 and nothing is written`, async () => {
      const res = await patchWith({ logoUrl: value });
      expect(res.status).toBe(400);
      expect(update).not.toHaveBeenCalled();
    });
  }

  it("names logoUrl in a field error the settings screen can show", async () => {
    const res = await patchWith({ logoUrl: "https://cdn.example.com/logo.png" });
    const body = (await res.json()) as {
      error?: string;
      details?: { fieldErrors?: Record<string, string[]> };
    };
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/upload/i);
    expect(body.details?.fieldErrors?.logoUrl?.[0]).toBe(body.error);
  });

  it("refuses an external image even when an unrelated field in the same save is valid", async () => {
    const res = await patchWith({ primaryColor: "#123456", logoUrl: "https://cdn.example.com/logo.png" });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  for (const [label, value] of [
    ["this club's own blob namespace", OWN_BLOB],
    ["a png data URL inside the bound", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="],
    ["a jpeg data URL", "data:image/jpeg;base64,/9j/4AAQSkZJRg=="],
    ["a webp data URL", "data:image/webp;base64,UklGRhIAAABXRUJQ"],
  ] as const) {
    it(`${label} is accepted`, async () => {
      const res = await patchWith({ logoUrl: value });
      expect(res.status).toBe(200);
      expect(update).toHaveBeenCalledTimes(1);
    });
  }

  it("clearing the logo with null is still accepted", async () => {
    const res = await patchWith({ logoUrl: null });
    expect(res.status).toBe(200);
  });

  describe("a club whose stored logo predates the policy (acceptance 5)", () => {
    const LEGACY = "https://cdn.example.com/old-logo.png";

    it("can still save an unrelated branding change that re-sends the stored logo unchanged", async () => {
      findUnique.mockResolvedValue({ id: "t-A", logoUrl: LEGACY });
      const res = await patchWith({ primaryColor: "#123456", logoUrl: LEGACY });
      expect(res.status).toBe(200);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it("cannot swap it for a different refused value", async () => {
      findUnique.mockResolvedValue({ id: "t-A", logoUrl: LEGACY });
      const res = await patchWith({ logoUrl: "https://cdn.example.com/other.png" });
      expect(res.status).toBe(400);
      expect(update).not.toHaveBeenCalled();
    });

    it("can replace it with an uploaded data: logo", async () => {
      findUnique.mockResolvedValue({ id: "t-A", logoUrl: LEGACY });
      const res = await patchWith({ logoUrl: "data:image/webp;base64,UklGRhIAAABXRUJQ" });
      expect(res.status).toBe(200);
    });
  });
});
