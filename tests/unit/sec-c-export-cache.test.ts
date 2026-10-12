// Security campaign lane C — SEC-047 (private cache leaks) on file exports.
//
// SF-C4 (9 Oct 2026): GET /api/payments/export.csv returned every payment in the
// club (member names, emails, amounts) with no Cache-Control at all, while its
// sibling exports (attendance export, import exceptions, DSAR export) send
// no-store. /api/payments is not under any next.config.ts no-store rule. With no
// Cache-Control the response falls back to the host's default, and a browser may
// keep the file in its disk cache on a shared front-desk machine after sign-out.
//
// The invariant, for every route that serves a download (Content-Disposition:
// attachment): Cache-Control carries no-store. Pinned statically over every
// export route, and dynamically for the payments export (with a positive control
// that the export itself still works).

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const findManyMock = vi.fn();
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: vi.fn().mockResolvedValue({ ok: true, tenantId: "secC-t1", userId: "secC-owner", role: "owner", session: { user: { id: "secC-owner" } } }),
}));
vi.mock("@/lib/support-session", () => ({ refuseSupportSession: () => null }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn({ payment: { findMany: findManyMock } })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  findManyMock.mockResolvedValue([
    {
      paidAt: new Date("2026-09-01T00:00:00Z"), createdAt: new Date("2026-09-01T00:00:00Z"), amountPence: 4500, currency: "GBP",
      status: "succeeded", description: null, stripeInvoiceId: null, stripePaymentIntentId: null, refundedAt: null,
      refundedAmountPence: null, member: { name: "secC Member", email: "secc-member@secc.example" },
    },
  ]);
});

describe("SF-C4 payments export is not cacheable", () => {
  it("positive control: the export answers 200 with the CSV", async () => {
    const { GET } = await import("@/app/api/payments/export.csv/route");
    const res = await GET(new Request("https://localhost/api/payments/export.csv"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("secC Member");
  });

  it("carries Cache-Control: private, no-store", async () => {
    const { GET } = await import("@/app/api/payments/export.csv/route");
    const res = await GET(new Request("https://localhost/api/payments/export.csv"));
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toMatch(/no-store/);
    expect(cc).toMatch(/private/);
  });
});

describe("SEC-047 every download route sets no-store", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts") files.push(p);
    }
  };
  walk(path.join(ROOT, "app/api"));
  const downloads = files.filter((f) => /Content-Disposition["']?\s*:\s*`?["']?attachment/.test(fs.readFileSync(f, "utf8")));

  it("found the download routes", () => {
    expect(downloads.length).toBeGreaterThanOrEqual(4);
  });
  for (const f of downloads) {
    it(`${path.relative(ROOT, f).split(path.sep).join("/")} sets Cache-Control no-store`, () => {
      const src = fs.readFileSync(f, "utf8");
      expect(src).toMatch(/["']Cache-Control["']\s*:\s*["'][^"']*no-store/);
    });
  }
});
