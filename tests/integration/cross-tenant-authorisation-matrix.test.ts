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
  let tierBId: string;

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

      // MembershipTier in tenant B only. Singled out because it is the model
      // this week's commercial work began writing to (Member.membershipTierId),
      // so it went from "not yet covered" to "carries money decisions" without
      // ever gaining a cross-tenant test.
      const tierB = await tx.membershipTier.create({
        data: {
          tenantId: tB.id,
          name: `Tier B (target) ${STAMP}`,
          pricePence: 5000,
        },
      });
      tierBId = tierB.id;
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
      await tx.membershipTier.deleteMany({ where: { name: { contains: String(STAMP) } } });
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
      // ?confirm=1 is required since 483dd0e (lane-01 V-02): a bare DELETE is
      // rejected with 400 before any tenant lookup happens. Without it this
      // case asserts the arm-guard rather than the cross-tenant boundary it is
      // here to prove — the request has to get far enough to be scoped.
      const req = new Request(`http://test/api/members/${memberBId}?confirm=1`, {
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

  // ── Implemented: MembershipTier ────────────────────────────────────────────
  // The route is app/api/memberships/[id] — NOT the
  // app/api/membership-tiers/[id] the stub used to name, which does not exist.
  // A stub that names the wrong file is worse than no stub: whoever picks it up
  // starts by looking for a route that was never there.
  describe("MembershipTier", () => {
    it("PATCH returns 404 for a cross-tenant tier AND leaves it unchanged", async () => {
      const before = await withRlsBypass((tx) =>
        tx.membershipTier.findUnique({ where: { id: tierBId } }),
      );
      const { PATCH } = await import("@/app/api/memberships/[id]/route");
      const req = new Request(`http://test/api/memberships/${tierBId}`, {
        method: "PATCH",
        headers: { Origin: "http://test", Host: "test", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Hijacked Tier", pricePence: 1 }),
      });
      const res = await PATCH(req as Request, {
        params: Promise.resolve({ id: tierBId }),
      } as { params: Promise<{ id: string }> });

      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) =>
        tx.membershipTier.findUnique({ where: { id: tierBId } }),
      );
      // The price especially: a tenant repricing another gym's membership is
      // the money version of this whole test file.
      expect(after?.name).toBe(before?.name);
      expect(after?.pricePence).toBe(before?.pricePence);
    });

    it("DELETE returns 404 AND the cross-tenant tier stays active", async () => {
      const { DELETE } = await import("@/app/api/memberships/[id]/route");
      const req = new Request(`http://test/api/memberships/${tierBId}`, {
        method: "DELETE",
        headers: { Origin: "http://test", Host: "test" },
      });
      const res = await DELETE(req as Request, {
        params: Promise.resolve({ id: tierBId }),
      } as { params: Promise<{ id: string }> });

      expect(res.status).toBe(404);
      // This route soft-deletes via isActive=false, so "still exists" is not
      // the assertion — "still ACTIVE" is. A row that survived as archived
      // would still have detached every member on it.
      const after = await withRlsBypass((tx) =>
        tx.membershipTier.findUnique({ where: { id: tierBId } }),
      );
      expect(after).not.toBeNull();
      expect(after?.isActive).toBe(true);
    });
  });

  // ── Not yet covered ────────────────────────────────────────────────────────
  // These were `describe.skip` blocks containing nothing but comments. An empty
  // skipped suite is a TODO wearing the shape of coverage: it reports as a
  // skipped SUITE in the run output, which reads like "these tests exist and
  // were skipped" rather than "these tests were never written". `it.todo` says
  // the true thing, and vitest counts it separately.
  //
  // To implement any of them, copy the Member or MembershipTier block above,
  // swap the route import, and adjust the DELETE assertion for whether that
  // route hard-deletes or soft-deletes. VERIFY THE ROUTE PATH FIRST — the
  // MembershipTier stub named one that does not exist.
  it.todo("User (staff) — app/api/dashboard/users/[id], soft-delete via isActive");
  it.todo("RankSystem — cross-tenant PATCH must not rewrite another gym's belts");
  it.todo("Class — app/api/classes/[id], soft-delete via isActive");
  it.todo("Announcement — app/api/announcements/[id]");
  it.todo("Initiative — app/api/initiatives/[id]");
  it.todo("ClassPack — soft-delete via isActive");
  it.todo("Payment refund POST — assert status unchanged AND no Stripe call attempted");
  it.todo("Order mark-paid POST");
  it.todo("Product — soft-deleted rows must stay soft-deleted");

  // Documented as no-mutator-route (skipped intentionally):
  //   AttendanceRecord, Notification, LoginEvent, MagicLinkToken,
  //   PasswordResetToken, AuditLog, SignedWaiver, IndexedDriveFile,
  //   GoogleDriveConnection, ImportJob, EmailLog, Dispute, MonthlyReport,
  //   RankRequirement, MemberClassPack, ClassRoster
});
