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
// Auth strategy: mock `@/auth`'s `auth()` export to return a tenantA session
// for the role under test (owner, manager, coach, admin or member), then call
// the REAL route handlers directly with constructed Request objects. Same
// pattern as tests/integration/tenant-isolation.test.ts and security.test.ts.
//
// Every refusal is asserted twice: the HTTP status, and a re-read of the
// tenant-B row through withRlsBypass proving it is byte-for-byte unchanged.
// A 404 alone is not evidence — the class-roster wipe fixed in the classes
// route answered 404 AFTER it had deleted gym B's roster.
//
// Every resource also carries a POSITIVE control on a tenant-A twin row, so a
// 404 here means "scoped away", not "route broken" (Workstream E, 6 Oct 2026).
//
// Outbound effects are stubbed and asserted not reached: Stripe (refund),
// Resend (refund email), Vercel Blob (announcement image delete). The rate
// limiter is stubbed so this suite writes no global RateLimitHit rows.
//
// DB strategy: relies on tests/setup-test-db.ts to gate against accidental
// prod-DB use. Skips entirely when no TEST_DATABASE_URL is set. Run it with
// the maintenance role (neondb_owner, BYPASSRLS — the application-layer filters
// are then the ONLY defence, which is the production-equivalent case if the
// production runtime role is the owner) and with the restricted role
// (RLS_ENFORCED=1, matflow_app) to see the RLS backstop.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

const spies = vi.hoisted(() => ({
  stripeConstructed: vi.fn(),
  sendEmail: vi.fn(async () => ({ ok: true })),
  blobDel: vi.fn(async () => undefined),
}));

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

// Any construction of a Stripe client is a provider side effect this suite
// must never cause on a refused request.
vi.mock("stripe", () => ({
  default: class StripeStub {
    constructor() {
      spies.stripeConstructed();
    }
  },
}));

vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendEmail: spies.sendEmail,
}));

vi.mock("@vercel/blob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vercel/blob")>()),
  del: spies.blobDel,
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import * as staffRoute from "@/app/api/staff/[id]/route";
import * as rankRoute from "@/app/api/ranks/[id]/route";
import * as classRoute from "@/app/api/classes/[id]/route";
import * as classCollectionRoute from "@/app/api/classes/route";
import * as announcementRoute from "@/app/api/announcements/[id]/route";
import * as initiativeRoute from "@/app/api/initiatives/[id]/route";
import * as classPackRoute from "@/app/api/class-packs/[id]/route";
import * as refundRoute from "@/app/api/payments/[id]/refund/route";
import * as markPaidRoute from "@/app/api/orders/[id]/mark-paid/route";
import * as productRoute from "@/app/api/products/[id]/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
// The restricted runner (q78/run-restricted.sh) sets RLS_ENFORCED=1. No case
// branches on it any more: since lane F's fixes (6 Oct 2026) every case must
// pass on both roles, so the application filters alone are what is proven.
const STAMP = Date.now();

type Role = "owner" | "manager" | "coach" | "admin" | "member";
type RouteResult = { status: number; json: () => Promise<unknown> };
type AnyHandler = (req: never, ctx: never) => Promise<RouteResult>;

/** Call a real route handler with a same-origin request. */
async function call(
  handler: unknown,
  method: string,
  path: string,
  params: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { Origin: "http://test", Host: "test" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const req = new Request(`http://test${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const res = await (handler as AnyHandler)(req as never, { params: Promise.resolve(params) } as never);
  const json = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  return { status: res.status, text: JSON.stringify(json), body: json };
}

describe.skipIf(!HAS_DB)("Cross-tenant authorisation matrix", () => {
  let tenantAId: string;
  let tenantBId: string;
  let ownerAId: string;
  let memberAId: string;
  let memberBId: string;
  let tierBId: string;

  // Representative tenant-A actors.
  const actorIds: Partial<Record<Role, string>> = {};

  // Tenant-B targets and tenant-A twins (positive controls).
  let coachAId: string;
  let coachBId: string;
  let rankAId: string;
  let rankBId: string;
  let classAId: string;
  let classBId: string;
  let annAId: string;
  let annBId: string;
  let initAId: string;
  let initBId: string;
  let packAId: string;
  let packBId: string;
  let payAId: string;
  let payBId: string;
  let orderAId: string;
  let orderBId: string;
  let prodAId: string;
  let prodBId: string;
  let prodBDeletedId: string;

  /** Point the mocked auth() at a tenant-A session of the given role. */
  function actAs(role: Role) {
    const id = actorIds[role]!;
    mockAuth.mockResolvedValue({
      user: {
        id,
        tenantId: tenantAId,
        role,
        email: `${role}-a-${STAMP}@xtenant.local`,
        name: `${role} A`,
        ...(role === "member" ? { memberId: id } : {}),
      },
    } as never);
  }

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
      actorIds.owner = ownerA.id;

      for (const role of ["manager", "admin"] as const) {
        const u = await tx.user.create({
          data: {
            tenantId: tA.id,
            email: `${role}-a-${STAMP}@xtenant.local`,
            passwordHash: "$2a$12$test-hash-not-used-in-this-suite",
            name: `${role} A`,
            role,
          },
        });
        actorIds[role] = u.id;
      }
      const coachA = await tx.user.create({
        data: {
          tenantId: tA.id,
          email: `coach-a-${STAMP}@xtenant.local`,
          passwordHash: "$2a$12$test-hash-not-used-in-this-suite",
          name: "Coach A",
          role: "coach",
        },
      });
      coachAId = coachA.id;
      actorIds.coach = coachA.id;

      // Tenant-B staff target.
      const coachB = await tx.user.create({
        data: {
          tenantId: tB.id,
          email: `coach-b-${STAMP}@xtenant.local`,
          passwordHash: "$2a$12$tenant-b-hash-must-not-change",
          name: "Coach B (target)",
          role: "coach",
        },
      });
      coachBId = coachB.id;

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
      actorIds.member = memA.id;

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

      rankAId = (await tx.rankSystem.create({
        data: { tenantId: tA.id, discipline: "BJJ", name: "Rank A", order: 1, color: "#ffffff" },
      })).id;
      rankBId = (await tx.rankSystem.create({
        data: { tenantId: tB.id, discipline: "BJJ", name: "Rank B (target)", order: 1, color: "#0000ff" },
      })).id;

      classAId = (await tx.class.create({ data: { tenantId: tA.id, name: "Class A" } })).id;
      classBId = (await tx.class.create({ data: { tenantId: tB.id, name: "Class B (target)" } })).id;
      // A real subscriber on gym B's class: the thing a cross-tenant roster
      // edit would cascade-cancel, and the id a leak would disclose.
      await tx.classSubscription.create({ data: { memberId: memB.id, classId: classBId } });

      annAId = (await tx.announcement.create({
        data: { tenantId: tA.id, title: "Ann A", body: "Body A" },
      })).id;
      annBId = (await tx.announcement.create({
        data: {
          tenantId: tB.id,
          title: "Ann B (target)",
          body: "Body B",
          // A blob-looking URL so a wrongly-admitted DELETE would reach del().
          imageUrl: `https://xtenant.public.blob.vercel-storage.com/tenants/${tB.id}/ann-${STAMP}.png`,
        },
      })).id;

      initAId = (await tx.initiative.create({
        data: { tenantId: tA.id, type: "marketing", startDate: new Date(), createdById: ownerA.id, notes: "Init A" },
      })).id;
      initBId = (await tx.initiative.create({
        data: { tenantId: tB.id, type: "marketing", startDate: new Date(), createdById: coachB.id, notes: "Init B (target)" },
      })).id;

      packAId = (await tx.classPack.create({
        data: { tenantId: tA.id, name: "Pack A", totalCredits: 10, validityDays: 90, pricePence: 9000 },
      })).id;
      packBId = (await tx.classPack.create({
        data: { tenantId: tB.id, name: "Pack B (target)", totalCredits: 10, validityDays: 90, pricePence: 9000 },
      })).id;

      // payA has no Stripe ids, so the owner's positive control stops at the
      // "No Stripe charge to refund" 400 — proof the row was FOUND — without
      // any provider call.
      payAId = (await tx.payment.create({
        data: { tenantId: tA.id, memberId: memberAId, amountPence: 4000, status: "succeeded" },
      })).id;
      payBId = (await tx.payment.create({
        data: {
          tenantId: tB.id,
          memberId: memB.id,
          amountPence: 4000,
          status: "succeeded",
          stripeChargeId: `ch_xtenant_${STAMP}`,
          stripePaymentIntentId: `pi_xtenant_${STAMP}`,
        },
      })).id;

      orderAId = (await tx.order.create({
        data: { tenantId: tA.id, orderRef: `XT-A-${STAMP}`, items: [], totalPence: 1500, paymentMethod: "pay_at_desk" },
      })).id;
      orderBId = (await tx.order.create({
        data: { tenantId: tB.id, orderRef: `XT-B-${STAMP}`, items: [], totalPence: 1500, paymentMethod: "pay_at_desk" },
      })).id;

      prodAId = (await tx.product.create({ data: { tenantId: tA.id, name: "Prod A", pricePence: 2000 } })).id;
      prodBId = (await tx.product.create({ data: { tenantId: tB.id, name: "Prod B (target)", pricePence: 2000 } })).id;
      prodBDeletedId = (await tx.product.create({
        data: { tenantId: tB.id, name: "Prod B deleted (target)", pricePence: 2000, deletedAt: new Date("2026-01-01T00:00:00Z") },
      })).id;
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
    // Cleanup is scoped to the TENANTS this suite creates, not to this run's
    // stamp — and that difference is load-bearing.
    //
    // It used to delete children by `${STAMP}` while deleting tenants by the
    // `xtenant-` prefix. Any earlier run that died before its own cleanup left
    // Users and Members behind with a different stamp, and those rows then made
    // `tenant.deleteMany` fail for ever on User_tenantId_fkey — a suite that
    // poisons the shared test branch a little more each time it is interrupted.
    //
    // Resolving the tenants first and deleting everything that belongs to them
    // clears this run AND any debris, so the suite heals rather than accretes.
    await withRlsBypass(async (tx) => {
      const stale = await tx.tenant.findMany({
        where: { slug: { contains: "xtenant-" } },
        select: { id: true },
      });
      const tenantIds = stale.map((t) => t.id);
      if (tenantIds.length === 0) return;

      const scope = { tenantId: { in: tenantIds } };
      // Children before parents. Class before RankSystem (a class may point at
      // a rank); MembershipTier and Payment before Member.
      await tx.classSubscription.deleteMany({ where: { member: scope } });
      await tx.classRoster.deleteMany({ where: scope });
      await tx.class.deleteMany({ where: scope });
      await tx.rankSystem.deleteMany({ where: scope });
      await tx.announcement.deleteMany({ where: scope });
      await tx.initiative.deleteMany({ where: scope });
      await tx.classPack.deleteMany({ where: scope });
      await tx.payment.deleteMany({ where: scope });
      await tx.order.deleteMany({ where: scope });
      await tx.product.deleteMany({ where: scope });
      await tx.auditLog.deleteMany({ where: scope });
      await tx.membershipTier.deleteMany({ where: scope });
      await tx.member.deleteMany({ where: scope });
      await tx.user.deleteMany({ where: scope });
      await tx.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    });
    vi.restoreAllMocks();
  });

  // ── Pattern proof: Member ──────────────────────────────────────────────────
  // The full pattern, end-to-end, for one model. Other models follow the
  // same shape.

  describe("Member", () => {
    it("GET /api/dashboard/members/[id] returns 404 for cross-tenant member", async () => {
      actAs("owner");
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
      actAs("owner");
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
      actAs("owner");
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

  // ── Implemented: MembershipTier ────────────────────────────────────────────
  // The route is app/api/memberships/[id] — NOT the
  // app/api/membership-tiers/[id] the stub used to name, which does not exist.
  // A stub that names the wrong file is worse than no stub: whoever picks it up
  // starts by looking for a route that was never there.
  describe("MembershipTier", () => {
    it("PATCH returns 404 for a cross-tenant tier AND leaves it unchanged", async () => {
      actAs("owner");
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
      actAs("owner");
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

  // ── The nine former `it.todo` stubs, now real (Workstream E, 6 Oct 2026) ──
  // Route paths were verified in source before writing each block:
  //   User (staff)   app/api/staff/[id]           owner only; HARD delete
  //   RankSystem     app/api/ranks/[id]           owner/manager; soft delete (deletedAt)
  //   Class          app/api/classes/[id]         GET any session; PATCH/DELETE owner/manager; soft delete (isActive)
  //   Announcement   app/api/announcements/[id]   owner/manager; hard delete + blob del()
  //   Initiative     app/api/initiatives/[id]     owner/manager; hard delete
  //   ClassPack      app/api/class-packs/[id]     owner/manager; soft delete (isActive)
  //   Payment refund app/api/payments/[id]/refund owner only; Stripe + email
  //   Order          app/api/orders/[id]/mark-paid owner/manager
  //   Product        app/api/products/[id]        owner/manager; soft delete (deletedAt)
  // The stub list said "app/api/dashboard/users/[id]" for staff — that route
  // does not exist; staff edits go through app/api/staff/[id].

  describe("User (staff) — app/api/staff/[id]", () => {
    // newPassword meets the shared rule (lib/password-policy.ts, 8 Oct 2026) so
    // the probe reaches the tenant guard rather than stopping at validation.
    const hijack = { name: "Hijacked Coach", role: "manager", newPassword: "Hijacked-Password-123" };

    it("owner A: PATCH of gym B's coach is 404 AND name/role/password/sessionVersion unchanged", async () => {
      const before = await withRlsBypass((tx) => tx.user.findUnique({ where: { id: coachBId } }));
      actAs("owner");
      const res = await call(staffRoute.PATCH, "PATCH", `/api/staff/${coachBId}`, { id: coachBId }, hijack);
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.user.findUnique({ where: { id: coachBId } }));
      expect(after).toEqual(before);
    });

    it("owner A: DELETE of gym B's coach is 404 AND the row still exists", async () => {
      actAs("owner");
      const res = await call(staffRoute.DELETE, "DELETE", `/api/staff/${coachBId}`, { id: coachBId });
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.user.findUnique({ where: { id: coachBId } }));
      expect(after).not.toBeNull();
    });

    it("manager, coach, admin and member of gym A: 403 on PATCH and DELETE, row unchanged", async () => {
      const before = await withRlsBypass((tx) => tx.user.findUnique({ where: { id: coachBId } }));
      for (const role of ["manager", "coach", "admin", "member"] as const) {
        actAs(role);
        const p = await call(staffRoute.PATCH, "PATCH", `/api/staff/${coachBId}`, { id: coachBId }, hijack);
        expect(p.status, `${role} PATCH`).toBe(403);
        const d = await call(staffRoute.DELETE, "DELETE", `/api/staff/${coachBId}`, { id: coachBId });
        expect(d.status, `${role} DELETE`).toBe(403);
      }
      const after = await withRlsBypass((tx) => tx.user.findUnique({ where: { id: coachBId } }));
      expect(after).toEqual(before);
    });

    it("positive control: owner A can rename their own coach", async () => {
      actAs("owner");
      const res = await call(staffRoute.PATCH, "PATCH", `/api/staff/${coachAId}`, { id: coachAId }, { name: "Coach A renamed" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Coach A renamed");
    });
  });

  describe("RankSystem — app/api/ranks/[id]", () => {
    const hijack = { name: "Hijacked Belt", color: "#ff0000", stripes: 9, order: 99 };

    it("owner A: PATCH of gym B's belt is 404 AND the belt is unchanged", async () => {
      const before = await withRlsBypass((tx) => tx.rankSystem.findUnique({ where: { id: rankBId } }));
      actAs("owner");
      const res = await call(rankRoute.PATCH, "PATCH", `/api/ranks/${rankBId}`, { id: rankBId }, hijack);
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.rankSystem.findUnique({ where: { id: rankBId } }));
      expect(after).toEqual(before);
    });

    it("manager A: DELETE of gym B's belt is 404 AND it is not soft-deleted", async () => {
      actAs("manager");
      const res = await call(rankRoute.DELETE, "DELETE", `/api/ranks/${rankBId}`, { id: rankBId });
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.rankSystem.findUnique({ where: { id: rankBId } }));
      expect(after?.deletedAt).toBeNull();
    });

    it("coach and member of gym A: 403, belt unchanged", async () => {
      const before = await withRlsBypass((tx) => tx.rankSystem.findUnique({ where: { id: rankBId } }));
      for (const role of ["coach", "member"] as const) {
        actAs(role);
        expect((await call(rankRoute.PATCH, "PATCH", `/api/ranks/${rankBId}`, { id: rankBId }, hijack)).status, role).toBe(403);
        expect((await call(rankRoute.DELETE, "DELETE", `/api/ranks/${rankBId}`, { id: rankBId })).status, role).toBe(403);
      }
      const after = await withRlsBypass((tx) => tx.rankSystem.findUnique({ where: { id: rankBId } }));
      expect(after).toEqual(before);
    });

    it("positive control: owner A can rename their own belt", async () => {
      actAs("owner");
      const res = await call(rankRoute.PATCH, "PATCH", `/api/ranks/${rankAId}`, { id: rankAId }, { name: "Rank A renamed" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Rank A renamed");
    });
  });

  describe("Class — app/api/classes/[id]", () => {
    it("owner A and member A: GET of gym B's class is 404 with no data", async () => {
      for (const role of ["owner", "member"] as const) {
        actAs(role);
        const res = await call(classRoute.GET, "GET", `/api/classes/${classBId}`, { id: classBId });
        expect(res.status, role).toBe(404);
        expect(res.text).not.toContain("Class B (target)");
      }
    });

    it("owner A: PATCH of gym B's class (fields AND roster) is 404, class and subscription unchanged", async () => {
      const before = await withRlsBypass((tx) => tx.class.findUnique({ where: { id: classBId } }));
      actAs("owner");
      const res = await call(classRoute.PATCH, "PATCH", `/api/classes/${classBId}`, { id: classBId }, {
        name: "Hijacked Class",
        isActive: false,
        roster: [],
      });
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.class.findUnique({ where: { id: classBId } }));
      expect(after).toEqual(before);
      // `roster: []` makes every subscriber a "loser"; the cascade must not
      // have reached gym B.
      const sub = await withRlsBypass((tx) =>
        tx.classSubscription.findFirst({ where: { classId: classBId, memberId: memberBId } }),
      );
      expect(sub).not.toBeNull();
    });

    it("manager A: DELETE ?force=true of gym B's class is 404 AND it stays active", async () => {
      actAs("manager");
      const res = await call(classRoute.DELETE, "DELETE", `/api/classes/${classBId}?force=true`, { id: classBId });
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.class.findUnique({ where: { id: classBId } }));
      expect(after?.isActive).toBe(true);
    });

    it("coach and member of gym A: 403 on PATCH and DELETE, class unchanged", async () => {
      const before = await withRlsBypass((tx) => tx.class.findUnique({ where: { id: classBId } }));
      for (const role of ["coach", "member"] as const) {
        actAs(role);
        expect((await call(classRoute.PATCH, "PATCH", `/api/classes/${classBId}`, { id: classBId }, { name: "x" })).status, role).toBe(403);
        expect((await call(classRoute.DELETE, "DELETE", `/api/classes/${classBId}?force=true`, { id: classBId })).status, role).toBe(403);
      }
      const after = await withRlsBypass((tx) => tx.class.findUnique({ where: { id: classBId } }));
      expect(after).toEqual(before);
    });

    it("positive control: owner A can read and rename their own class", async () => {
      actAs("owner");
      const g = await call(classRoute.GET, "GET", `/api/classes/${classAId}`, { id: classAId });
      expect(g.status).toBe(200);
      const p = await call(classRoute.PATCH, "PATCH", `/api/classes/${classAId}`, { id: classAId }, { name: "Class A renamed" });
      expect(p.status).toBe(200);
      expect(p.body.name).toBe("Class A renamed");
    });
  });

  describe("Announcement — app/api/announcements/[id]", () => {
    const hijack = { title: "Hijacked", body: "Hijacked body", pinned: true, durationDays: 1 };

    it("owner A: PATCH of gym B's announcement is 404 AND it is unchanged", async () => {
      const before = await withRlsBypass((tx) => tx.announcement.findUnique({ where: { id: annBId } }));
      actAs("owner");
      const res = await call(announcementRoute.PATCH, "PATCH", `/api/announcements/${annBId}`, { id: annBId }, hijack);
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.announcement.findUnique({ where: { id: annBId } }));
      expect(after).toEqual(before);
    });

    it("manager A: DELETE of gym B's announcement is 404, row kept AND its image is not deleted", async () => {
      spies.blobDel.mockClear();
      actAs("manager");
      const res = await call(announcementRoute.DELETE, "DELETE", `/api/announcements/${annBId}`, { id: annBId });
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.announcement.findUnique({ where: { id: annBId } }));
      expect(after).not.toBeNull();
      expect(spies.blobDel).not.toHaveBeenCalled();
    });

    it("coach and member of gym A: 403, announcement unchanged", async () => {
      const before = await withRlsBypass((tx) => tx.announcement.findUnique({ where: { id: annBId } }));
      for (const role of ["coach", "member"] as const) {
        actAs(role);
        expect((await call(announcementRoute.PATCH, "PATCH", `/api/announcements/${annBId}`, { id: annBId }, hijack)).status, role).toBe(403);
        expect((await call(announcementRoute.DELETE, "DELETE", `/api/announcements/${annBId}`, { id: annBId })).status, role).toBe(403);
      }
      const after = await withRlsBypass((tx) => tx.announcement.findUnique({ where: { id: annBId } }));
      expect(after).toEqual(before);
    });

    it("positive control: owner A can edit their own announcement", async () => {
      actAs("owner");
      const res = await call(announcementRoute.PATCH, "PATCH", `/api/announcements/${annAId}`, { id: annAId }, { title: "Ann A edited" });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Ann A edited");
    });
  });

  describe("Initiative — app/api/initiatives/[id]", () => {
    const hijack = { type: "holiday", notes: "Hijacked", endDate: "2026-12-31" };

    it("owner A: PATCH of gym B's initiative is 404 AND it is unchanged", async () => {
      const before = await withRlsBypass((tx) => tx.initiative.findUnique({ where: { id: initBId } }));
      actAs("owner");
      const res = await call(initiativeRoute.PATCH, "PATCH", `/api/initiatives/${initBId}`, { id: initBId }, hijack);
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.initiative.findUnique({ where: { id: initBId } }));
      expect(after).toEqual(before);
    });

    it("manager A: DELETE of gym B's initiative is 404 AND it still exists", async () => {
      actAs("manager");
      const res = await call(initiativeRoute.DELETE, "DELETE", `/api/initiatives/${initBId}`, { id: initBId });
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.initiative.findUnique({ where: { id: initBId } }));
      expect(after).not.toBeNull();
    });

    it("coach and member of gym A: 403, initiative unchanged", async () => {
      const before = await withRlsBypass((tx) => tx.initiative.findUnique({ where: { id: initBId } }));
      for (const role of ["coach", "member"] as const) {
        actAs(role);
        expect((await call(initiativeRoute.PATCH, "PATCH", `/api/initiatives/${initBId}`, { id: initBId }, hijack)).status, role).toBe(403);
        expect((await call(initiativeRoute.DELETE, "DELETE", `/api/initiatives/${initBId}`, { id: initBId })).status, role).toBe(403);
      }
      const after = await withRlsBypass((tx) => tx.initiative.findUnique({ where: { id: initBId } }));
      expect(after).toEqual(before);
    });

    it("positive control: manager A can edit their own initiative", async () => {
      actAs("manager");
      const res = await call(initiativeRoute.PATCH, "PATCH", `/api/initiatives/${initAId}`, { id: initAId }, { notes: "Init A edited" });
      expect(res.status).toBe(200);
      expect(res.body.notes).toBe("Init A edited");
    });
  });

  describe("ClassPack — app/api/class-packs/[id]", () => {
    const hijack = { name: "Hijacked Pack", isActive: false };

    it("owner A: PATCH of gym B's pack is 404 AND it is unchanged", async () => {
      const before = await withRlsBypass((tx) => tx.classPack.findUnique({ where: { id: packBId } }));
      actAs("owner");
      const res = await call(classPackRoute.PATCH, "PATCH", `/api/class-packs/${packBId}`, { id: packBId }, hijack);
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.classPack.findUnique({ where: { id: packBId } }));
      expect(after).toEqual(before);
    });

    it("manager A: DELETE of gym B's pack is 404 AND it stays active", async () => {
      actAs("manager");
      const res = await call(classPackRoute.DELETE, "DELETE", `/api/class-packs/${packBId}`, { id: packBId });
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.classPack.findUnique({ where: { id: packBId } }));
      expect(after?.isActive).toBe(true);
    });

    it("coach and member of gym A: 403, pack unchanged", async () => {
      const before = await withRlsBypass((tx) => tx.classPack.findUnique({ where: { id: packBId } }));
      for (const role of ["coach", "member"] as const) {
        actAs(role);
        expect((await call(classPackRoute.PATCH, "PATCH", `/api/class-packs/${packBId}`, { id: packBId }, hijack)).status, role).toBe(403);
        expect((await call(classPackRoute.DELETE, "DELETE", `/api/class-packs/${packBId}`, { id: packBId })).status, role).toBe(403);
      }
      const after = await withRlsBypass((tx) => tx.classPack.findUnique({ where: { id: packBId } }));
      expect(after).toEqual(before);
    });

    it("positive control: owner A can rename their own pack", async () => {
      actAs("owner");
      const res = await call(classPackRoute.PATCH, "PATCH", `/api/class-packs/${packAId}`, { id: packAId }, { name: "Pack A renamed" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Pack A renamed");
    });
  });

  describe("Payment refund — app/api/payments/[id]/refund", () => {
    it("owner A: refund of gym B's payment is 404, payment unchanged, no Stripe client, no email", async () => {
      spies.stripeConstructed.mockClear();
      spies.sendEmail.mockClear();
      const before = await withRlsBypass((tx) => tx.payment.findUnique({ where: { id: payBId } }));
      actAs("owner");
      const res = await call(refundRoute.POST, "POST", `/api/payments/${payBId}/refund`, { id: payBId }, {
        amountPence: 100,
        reason: "cross-tenant probe",
      });
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.payment.findUnique({ where: { id: payBId } }));
      expect(after).toEqual(before);
      expect(after?.tenantId).toBe(tenantBId);
      expect(after?.status).toBe("succeeded");
      expect(after?.refundedAmountPence).toBeNull();
      expect(spies.stripeConstructed).not.toHaveBeenCalled();
      expect(spies.sendEmail).not.toHaveBeenCalled();
    });

    it("manager, coach, admin and member of gym A: 403 (refunds are owner-only), payment unchanged", async () => {
      spies.stripeConstructed.mockClear();
      const before = await withRlsBypass((tx) => tx.payment.findUnique({ where: { id: payBId } }));
      for (const role of ["manager", "coach", "admin", "member"] as const) {
        actAs(role);
        const res = await call(refundRoute.POST, "POST", `/api/payments/${payBId}/refund`, { id: payBId }, { amountPence: 100 });
        expect(res.status, role).toBe(403);
      }
      const after = await withRlsBypass((tx) => tx.payment.findUnique({ where: { id: payBId } }));
      expect(after).toEqual(before);
      expect(spies.stripeConstructed).not.toHaveBeenCalled();
    });

    it("positive control: owner A's own payment is FOUND (stops at 'No Stripe charge', no provider call)", async () => {
      spies.stripeConstructed.mockClear();
      actAs("owner");
      const res = await call(refundRoute.POST, "POST", `/api/payments/${payAId}/refund`, { id: payAId }, { amountPence: 100 });
      expect(res.status).toBe(400);
      expect(res.text).toContain("No Stripe charge to refund");
      expect(spies.stripeConstructed).not.toHaveBeenCalled();
    });
  });

  describe("Order mark-paid — app/api/orders/[id]/mark-paid", () => {
    it("owner A and manager A: mark-paid of gym B's order is 404 AND it stays pending", async () => {
      const before = await withRlsBypass((tx) => tx.order.findUnique({ where: { id: orderBId } }));
      for (const role of ["owner", "manager"] as const) {
        actAs(role);
        const res = await call(markPaidRoute.POST, "POST", `/api/orders/${orderBId}/mark-paid`, { id: orderBId }, {
          reason: "cash at the desk",
        });
        expect(res.status, role).toBe(404);
      }
      const after = await withRlsBypass((tx) => tx.order.findUnique({ where: { id: orderBId } }));
      expect(after).toEqual(before);
      expect(after?.status).toBe("pending");
      expect(after?.paidAt).toBeNull();
      expect(after?.paidByUserId).toBeNull();
    });

    it("coach and member of gym A: 403, order unchanged", async () => {
      const before = await withRlsBypass((tx) => tx.order.findUnique({ where: { id: orderBId } }));
      for (const role of ["coach", "member"] as const) {
        actAs(role);
        const res = await call(markPaidRoute.POST, "POST", `/api/orders/${orderBId}/mark-paid`, { id: orderBId }, { reason: "cash" });
        expect(res.status, role).toBe(403);
      }
      const after = await withRlsBypass((tx) => tx.order.findUnique({ where: { id: orderBId } }));
      expect(after).toEqual(before);
    });

    it("positive control: manager A can mark their own order paid", async () => {
      actAs("manager");
      const res = await call(markPaidRoute.POST, "POST", `/api/orders/${orderAId}/mark-paid`, { id: orderAId }, { reason: "cash at the desk" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("paid");
    });
  });

  describe("Product — app/api/products/[id]", () => {
    const hijack = { name: "Hijacked Product", pricePence: 1, inStock: false };

    it("owner A: PATCH of gym B's live product is 404 AND it is unchanged", async () => {
      const before = await withRlsBypass((tx) => tx.product.findUnique({ where: { id: prodBId } }));
      actAs("owner");
      const res = await call(productRoute.PATCH, "PATCH", `/api/products/${prodBId}`, { id: prodBId }, hijack);
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.product.findUnique({ where: { id: prodBId } }));
      expect(after).toEqual(before);
    });

    it("owner A: PATCH of gym B's SOFT-DELETED product is 404 AND it stays soft-deleted", async () => {
      const before = await withRlsBypass((tx) => tx.product.findUnique({ where: { id: prodBDeletedId } }));
      actAs("owner");
      const res = await call(productRoute.PATCH, "PATCH", `/api/products/${prodBDeletedId}`, { id: prodBDeletedId }, hijack);
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.product.findUnique({ where: { id: prodBDeletedId } }));
      expect(after).toEqual(before);
      expect(after?.deletedAt).not.toBeNull();
    });

    it("manager A: DELETE of gym B's live product is 404 AND it is not soft-deleted", async () => {
      actAs("manager");
      const res = await call(productRoute.DELETE, "DELETE", `/api/products/${prodBId}`, { id: prodBId });
      expect(res.status).toBe(404);
      const after = await withRlsBypass((tx) => tx.product.findUnique({ where: { id: prodBId } }));
      expect(after?.deletedAt).toBeNull();
    });

    it("coach and member of gym A: 403, product unchanged", async () => {
      const before = await withRlsBypass((tx) => tx.product.findUnique({ where: { id: prodBId } }));
      for (const role of ["coach", "member"] as const) {
        actAs(role);
        expect((await call(productRoute.PATCH, "PATCH", `/api/products/${prodBId}`, { id: prodBId }, hijack)).status, role).toBe(403);
        expect((await call(productRoute.DELETE, "DELETE", `/api/products/${prodBId}`, { id: prodBId })).status, role).toBe(403);
      }
      const after = await withRlsBypass((tx) => tx.product.findUnique({ where: { id: prodBId } }));
      expect(after).toEqual(before);
    });

    it("positive control: owner A can reprice their own product", async () => {
      actAs("owner");
      const res = await call(productRoute.PATCH, "PATCH", `/api/products/${prodAId}`, { id: prodAId }, { pricePence: 2500 });
      expect(res.status).toBe(200);
      expect(res.body.pricePence).toBe(2500);
    });
  });

  // ── Findings surfaced by writing the matrix (kept as evidence) ────────────
  // These run LAST because the cross-reference probes temporarily point a
  // gym-A class at gym-B rows; each restores the class in `finally`.

  describe("Class — cross-tenant leaks found while implementing the matrix", () => {
    // FINDING E-1. app/api/classes/[id]/route.ts PATCH computes `affected`
    // (the subscribers who would lose access) with
    //   tx.classSubscription.findMany({ where: { classId: id, ... } })
    // BEFORE the ownership check, with no tenant predicate (ClassSubscription
    // has no tenantId column), and `?dryRun=1` returns that list. Under a
    // BYPASSRLS runtime role gym A can therefore read gym B's subscriber
    // member ids for any class id it holds. The RLS policy on
    // ClassSubscription (scoped through Member) closes it ONLY under the
    // restricted role. Expected secure behaviour: 404, no ids.
    // Proposed fix: move the `owned` check to the top of the handler (before
    // `affected` is computed) and add `member: { tenantId }` to both
    // classSubscription.findMany calls.
    // History: written as `RLS_ENFORCED ? it : it.fails` (leaked under the
    // BYPASSRLS owner role, hidden by RLS under the restricted role). FIXED
    // 6 Oct 2026 (lane F): ownership is checked first and both subscription
    // lookups carry `member: { tenantId }`, so it is a plain `it` on both roles.
    it("PATCH ?dryRun=1 on gym B's class must not disclose gym B's subscriber ids", async () => {
      actAs("owner");
      const res = await call(classRoute.PATCH, "PATCH", `/api/classes/${classBId}?dryRun=1`, { id: classBId }, { roster: [] });
      expect(res.text).not.toContain(memberBId);
    });
    // History: `it.fails` on both roles — the dry run answered 200
    // `{ dryRun: true, affectedMemberIds: [] }` for a class that was not the
    // caller's. FIXED 6 Oct 2026 (lane F).
    it("PATCH ?dryRun=1 on gym B's class must be refused with 404", async () => {
      actAs("owner");
      const res = await call(classRoute.PATCH, "PATCH", `/api/classes/${classBId}?dryRun=1`, { id: classBId }, { roster: [] });
      expect(res.status).toBe(404);
      expect(res.text).not.toContain(memberBId);
    });
    // Same handler, rank-gate dry run (the other subscription lookup).
    it("PATCH ?dryRun=1 with a rank gate on gym B's class is 404 with no ids", async () => {
      actAs("owner");
      const res = await call(classRoute.PATCH, "PATCH", `/api/classes/${classBId}?dryRun=1`, { id: classBId }, { requiredRankId: rankBId });
      expect(res.status).toBe(404);
      expect(res.text).not.toContain(memberBId);
    });

    // FINDING E-2. The same PATCH writes `requiredRankId`, `maxRankId` and
    // `coachUserId` straight from the body without checking they belong to the
    // caller's tenant (only `locationId` is checked). Gym A can point its own
    // class at gym B's belt or staff user; GET /api/classes/[id] then
    // `include`s requiredRank / coachUser and returns gym B's belt name and
    // coach name. Postgres FK checks ignore RLS, so the restricted role does
    // not stop the write. app/api/classes/route.ts POST has the same gap.
    // Expected secure behaviour: 400, the column unchanged, nothing of gym B in
    // the body. Proposed fix: validate each of the three ids with a
    // tenant-scoped findFirst inside the transaction (as locationId does) and
    // refuse with 400.
    // History: both were `it.fails` on both roles (the write succeeded and GET
    // returned gym B's names). FIXED 6 Oct 2026 (lane F): lib/class-refs.ts
    // refuses each id with 400 before anything is written.
    for (const field of ["requiredRankId", "maxRankId"] as const) {
      it(`PATCH of a gym-A class must refuse gym B's belt as ${field}`, async () => {
        actAs("owner");
        try {
          const res = await call(classRoute.PATCH, "PATCH", `/api/classes/${classAId}`, { id: classAId }, { [field]: rankBId });
          expect(res.status).toBe(400);
          const g = await call(classRoute.GET, "GET", `/api/classes/${classAId}`, { id: classAId });
          const after = await withRlsBypass((tx) => tx.class.findUnique({ where: { id: classAId } }));
          expect(after?.[field]).not.toBe(rankBId);
          expect(res.text).not.toContain("Rank B (target)");
          expect(g.text).not.toContain("Rank B (target)");
        } finally {
          await withRlsBypass((tx) =>
            tx.class.update({ where: { id: classAId }, data: { requiredRankId: null, maxRankId: null } }),
          );
        }
      });
    }

    it("PATCH of a gym-A class must refuse gym B's staff user as coachUserId", async () => {
      actAs("owner");
      try {
        const res = await call(classRoute.PATCH, "PATCH", `/api/classes/${classAId}`, { id: classAId }, { coachUserId: coachBId });
        expect(res.status).toBe(400);
        const g = await call(classRoute.GET, "GET", `/api/classes/${classAId}`, { id: classAId });
        const after = await withRlsBypass((tx) => tx.class.findUnique({ where: { id: classAId } }));
        expect(after?.coachUserId).not.toBe(coachBId);
        expect(res.text).not.toContain("Coach B (target)");
        expect(g.text).not.toContain("Coach B (target)");
      } finally {
        await withRlsBypass((tx) => tx.class.update({ where: { id: classAId }, data: { coachUserId: null } }));
      }
    });

    it("positive control: owner A can set their own belt and coach on their own class", async () => {
      actAs("owner");
      try {
        const res = await call(classRoute.PATCH, "PATCH", `/api/classes/${classAId}`, { id: classAId }, {
          requiredRankId: rankAId,
          coachUserId: coachAId,
        });
        expect(res.status).toBe(200);
        const after = await withRlsBypass((tx) => tx.class.findUnique({ where: { id: classAId } }));
        expect(after?.requiredRankId).toBe(rankAId);
        expect(after?.coachUserId).toBe(coachAId);
      } finally {
        await withRlsBypass((tx) =>
          tx.class.update({ where: { id: classAId }, data: { requiredRankId: null, coachUserId: null } }),
        );
      }
    });

    it("PATCH roster on a gym-A class never writes gym B's member", async () => {
      actAs("owner");
      try {
        const res = await call(classRoute.PATCH, "PATCH", `/api/classes/${classAId}`, { id: classAId }, {
          roster: [{ memberId: memberAId }, { memberId: memberBId }],
        });
        expect(res.status).toBe(200);
        const rows = await withRlsBypass((tx) =>
          tx.classRoster.findMany({ where: { classId: classAId }, select: { memberId: true } }),
        );
        expect(rows.map((r) => r.memberId)).toEqual([memberAId]);
      } finally {
        await withRlsBypass((tx) => tx.classRoster.deleteMany({ where: { classId: classAId } }));
      }
    });

    // E-2, POST /api/classes: the same three ids at create time.
    it.each([
      ["requiredRankId", () => rankBId],
      ["maxRankId", () => rankBId],
      ["coachUserId", () => coachBId],
    ] as const)("POST /api/classes refuses gym B's id as %s and creates nothing", async (field, foreignId) => {
      actAs("owner");
      const name = `X-post ${field} ${STAMP}`;
      try {
        const res = await call(classCollectionRoute.POST, "POST", "/api/classes", {}, {
          name,
          duration: 60,
          schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
          [field]: foreignId(),
        });
        expect(res.status).toBe(400);
        expect(res.text).not.toContain("Rank B (target)");
        expect(res.text).not.toContain("Coach B (target)");
        const created = await withRlsBypass((tx) => tx.class.findFirst({ where: { tenantId: tenantAId, name } }));
        expect(created).toBeNull();
      } finally {
        // Only reached with rows if the refusal regressed; the class's
        // children must go first or afterAll's class.deleteMany fails on FK.
        await withRlsBypass(async (tx) => {
          const stray = await tx.class.findMany({ where: { tenantId: tenantAId, name }, select: { id: true } });
          const ids = stray.map((c) => c.id);
          if (ids.length === 0) return;
          await tx.classInstance.deleteMany({ where: { classId: { in: ids } } });
          await tx.classSchedule.deleteMany({ where: { classId: { in: ids } } });
          await tx.class.deleteMany({ where: { id: { in: ids } } });
        });
      }
    });
  });

  describe("RankSystem — cross-tenant count disclosure (finding E-3)", () => {
    // app/api/ranks/[id]/route.ts DELETE counted belt holders with
    // `memberRank.count({ where: { rankSystemId: id } })` — no tenant — and
    // returned the count in its 409 before establishing that the belt was the
    // caller's. Reachable once a gym-A class pointed at gym B's belt (E-2;
    // rows written before that fix may still exist). FIXED 6 Oct 2026
    // (lane F): ownership first (404), and the count is scoped through Member.
    it("manager A: DELETE of gym B's belt that a gym-A class points at is 404 with no counts", async () => {
      let strayClassId: string | null = null;
      let memberRankId: string | null = null;
      try {
        await withRlsBypass(async (tx) => {
          strayClassId = (await tx.class.create({
            data: { tenantId: tenantAId, name: `X-stray-gate ${STAMP}`, requiredRankId: rankBId },
          })).id;
          memberRankId = (await tx.memberRank.create({ data: { memberId: memberBId, rankSystemId: rankBId } })).id;
        });
        actAs("manager");
        const res = await call(rankRoute.DELETE, "DELETE", `/api/ranks/${rankBId}`, { id: rankBId });
        expect(res.status).toBe(404);
        expect(res.body).not.toHaveProperty("memberRankCount");
        expect(res.body).not.toHaveProperty("classCount");
        const after = await withRlsBypass((tx) => tx.rankSystem.findUnique({ where: { id: rankBId } }));
        expect(after?.deletedAt).toBeNull();
      } finally {
        await withRlsBypass(async (tx) => {
          if (memberRankId) await tx.memberRank.delete({ where: { id: memberRankId } });
          if (strayClassId) await tx.class.delete({ where: { id: strayClassId } });
        });
      }
    });

    it("positive control: owner A's 409 still counts their own belt holders", async () => {
      let ownClassId: string | null = null;
      let memberRankId: string | null = null;
      try {
        await withRlsBypass(async (tx) => {
          ownClassId = (await tx.class.create({
            data: { tenantId: tenantAId, name: `X-own-gate ${STAMP}`, requiredRankId: rankAId },
          })).id;
          memberRankId = (await tx.memberRank.create({ data: { memberId: memberAId, rankSystemId: rankAId } })).id;
        });
        actAs("owner");
        const res = await call(rankRoute.DELETE, "DELETE", `/api/ranks/${rankAId}`, { id: rankAId });
        expect(res.status).toBe(409);
        expect(res.body.classCount).toBe(1);
        expect(res.body.memberRankCount).toBe(1);
      } finally {
        await withRlsBypass(async (tx) => {
          if (memberRankId) await tx.memberRank.delete({ where: { id: memberRankId } });
          if (ownClassId) await tx.class.delete({ where: { id: ownClassId } });
        });
      }
    });
  });

  // Documented as no-mutator-route (skipped intentionally):
  //   AttendanceRecord, Notification, LoginEvent, MagicLinkToken,
  //   PasswordResetToken, AuditLog, SignedWaiver, IndexedDriveFile,
  //   GoogleDriveConnection, ImportJob, EmailLog, Dispute, MonthlyReport,
  //   RankRequirement, MemberClassPack, ClassRoster (ClassRoster: see
  //   tests/integration/roster-cross-tenant.test.ts)
});
