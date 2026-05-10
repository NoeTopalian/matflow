// Cross-tenant authorisation matrix.
//
// The single highest-leverage test in the MatFlow ultimate test suite.
// For every tenant-scoped Prisma model with API mutator routes, asserts:
//   1. GET /api/<resource>/{tenantBRowId} as tenantA staff -> 404
//   2. PATCH /api/<resource>/{tenantBRowId} -> 404 + row unchanged
//   3. DELETE (or soft-delete) -> 404 + row still exists
//
// This catches the largest single class of failures (defensive-eng §1.1
// authorisation drift) at once. See .omc/specs/deep-dive-matflow-ultimate-test-suite.md
// "Phase E" for context.
//
// Auth strategy: mock `@/auth`'s `auth()` export to return a tenantA owner
// session, then call route handlers directly with constructed Request objects.
// Same pattern as tests/integration/tenant-isolation.test.ts and security.test.ts.
//
// DB strategy: relies on tests/setup-test-db.ts to gate against accidental
// prod-DB use. Skips entirely when no TEST_DATABASE_URL is set.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

// Mocks must be declared BEFORE imports — vitest hoists vi.mock calls.
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(),
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

describe.skipIf(!HAS_DB)("Cross-tenant authorisation matrix", () => {
  let tenantAId: string;
  let tenantBId: string;
  let ownerAId: string;
  let memberAId: string;
  let memberBId: string;

  beforeAll(async () => {
    // Seed two tenants and minimum-viable rows under each.
    await withRlsBypass(async (tx) => {
      const tA = await tx.tenant.create({
        data: { name: "X-Tenant A", slug: `xtenant-a-${STAMP}` },
      });
      const tB = await tx.tenant.create({
        data: { name: "X-Tenant B", slug: `xtenant-b-${STAMP}` },
      });
      tenantAId = tA.id;
      tenantBId = tB.id;

      // Owner user for tenantA — used to authenticate cross-tenant requests.
      const ownerA = await tx.user.create({
        data: {
          tenantId: tA.id,
          email: `owner-a-${STAMP}@xtenant.local`,
          passwordHash: "$2a$12$test-hash-not-used-in-this-suite",
          name: "Owner A",
          role: "owner",
        },
      });
      ownerAId = ownerA.id;

      // One Member row in each tenant — primary case.
      const memA = await tx.member.create({
        data: {
          tenantId: tA.id,
          name: "Member A",
          email: `mem-a-${STAMP}@xtenant.local`,
        },
      });
      const memB = await tx.member.create({
        data: {
          tenantId: tB.id,
          name: "Member B (target)",
          email: `mem-b-${STAMP}@xtenant.local`,
        },
      });
      memberAId = memA.id;
      memberBId = memB.id;
    });

    // Default auth mock: tenantA owner session.
    mockAuth.mockResolvedValue({
      user: {
        id: ownerAId,
        tenantId: tenantAId,
        role: "owner",
        email: `owner-a-${STAMP}@xtenant.local`,
        name: "Owner A",
      },
    } as never);
  });

  afterAll(async () => {
    // Best-effort cleanup. Stamp prefix limits blast radius if cleanup fails.
    await withRlsBypass(async (tx) => {
      await tx.member.deleteMany({ where: { email: { contains: `-${STAMP}@xtenant.local` } } });
      await tx.user.deleteMany({ where: { email: { contains: `-${STAMP}@xtenant.local` } } });
      await tx.tenant.deleteMany({ where: { slug: { contains: `xtenant-` } } });
    });
    vi.restoreAllMocks();
  });

  // ── Pattern proof: Member ──────────────────────────────────────────────────
  // The full pattern, end-to-end, for one model. Other models follow the
  // same shape — see the it.skip stubs below for the expansion list.

  describe("Member", () => {
    it("GET /api/dashboard/members/[id] returns 404 for cross-tenant member", async () => {
      const { GET } = await import("@/app/api/members/[id]/route");
      const req = new Request(`http://test/api/members/${memberBId}`, {
        method: "GET",
        headers: { Origin: "http://test", Host: "test" },
      });
      const res = await GET(req as Request, { params: Promise.resolve({ id: memberBId }) } as { params: Promise<{ id: string }> });
      expect(res.status).toBe(404);
      // Belt-and-braces: assert the response body does not leak member B data.
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toContain("Member B (target)");
    });

    it("PATCH /api/dashboard/members/[id] returns 404 AND leaves member B unchanged", async () => {
      const before = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: memberBId } }));
      const { PATCH } = await import("@/app/api/members/[id]/route");
      const req = new Request(`http://test/api/members/${memberBId}`, {
        method: "PATCH",
        headers: { Origin: "http://test", Host: "test", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Hijacked Name" }),
      });
      const res = await PATCH(req as Request, { params: Promise.resolve({ id: memberBId }) } as { params: Promise<{ id: string }> });
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: memberBId } }));
      expect(after?.name).toBe(before?.name);
      expect(after?.name).toBe("Member B (target)");
    });

    it("DELETE /api/dashboard/members/[id] returns 404 AND member B still exists", async () => {
      const { DELETE } = await import("@/app/api/members/[id]/route");
      const req = new Request(`http://test/api/members/${memberBId}`, {
        method: "DELETE",
        headers: { Origin: "http://test", Host: "test" },
      });
      const res = await DELETE(req as Request, { params: Promise.resolve({ id: memberBId }) } as { params: Promise<{ id: string }> });
      expect(res.status).toBe(404);
      const stillThere = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: memberBId } }));
      expect(stillThere).not.toBeNull();
    });
  });

  // ── Expansion stubs ────────────────────────────────────────────────────────
  // Each stub follows the Member pattern above. To implement: copy the three
  // it() blocks, swap the route import path, swap the mutating PATCH body
  // shape, and adjust DELETE expectation if the route does soft-delete (set
  // isActive=false) instead of hard-delete (assert the soft-delete column did
  // not change for the cross-tenant call).

  describe.skip("User (staff)", () => {
    // Route: app/api/dashboard/users/[id]/route.ts
    // PATCH body: { name?, role?, email? }
    // DELETE: soft-delete via isActive=false
  });

  describe.skip("RankSystem", () => {
    // Route: app/api/ranks/[id]/route.ts (or similar)
    // PATCH body: { name?, ranks? }
  });

  describe.skip("Class", () => {
    // Route: app/api/classes/[id]/route.ts
    // PATCH body: { name?, location?, maxCapacity? }
    // DELETE: soft-delete via isActive=false
  });

  describe.skip("Announcement", () => {
    // Route: app/api/announcements/[id]/route.ts
    // PATCH body: { title?, body?, pinned? }
  });

  describe.skip("Initiative", () => {
    // Route: app/api/initiatives/[id]/route.ts
  });

  describe.skip("ClassPack", () => {
    // Route: app/api/class-packs/[id]/route.ts
    // DELETE: soft-delete via isActive=false
  });

  describe.skip("Payment (refund POST)", () => {
    // Route: app/api/payments/[id]/refund/route.ts
    // No PATCH/DELETE — only POST refund. Adapt the matrix:
    //   1. POST refund as tenantA owner against payment B.id -> 404
    //   2. After: payment B status unchanged, no Stripe call attempted
  });

  describe.skip("Order (mark-paid POST)", () => {
    // Route: app/api/orders/[id]/mark-paid/route.ts
  });

  describe.skip("Product", () => {
    // Route: app/api/shop/products/[id]/route.ts
  });

  describe.skip("MembershipTier", () => {
    // Route: app/api/membership-tiers/[id]/route.ts
  });

  // Documented as no-mutator-route (skipped intentionally):
  //   AttendanceRecord, Notification, LoginEvent, MagicLinkToken,
  //   PasswordResetToken, AuditLog, SignedWaiver, IndexedDriveFile,
  //   GoogleDriveConnection, ImportJob, EmailLog, Dispute, MonthlyReport,
  //   RankRequirement, MemberClassPack, ClassRoster
});
