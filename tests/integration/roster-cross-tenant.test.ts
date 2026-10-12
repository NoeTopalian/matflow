// Roster cross-tenant rejection (integration).
//
// These were three `it.todo` stubs ("requires a session-cookie test fixture
// pattern not yet established"). The pattern now exists — mock `@/auth`'s
// `auth()` and call the real route handlers, as
// tests/integration/cross-tenant-authorisation-matrix.test.ts does — so they
// are real assertions against two synthetic tenants on the Neon TEST branch
// (Workstream E, 6 Oct 2026).
//
// Each refusal is asserted on the HTTP status AND by re-reading gym B's rows
// through withRlsBypass: a 404 alone proves nothing (the class-roster wipe
// once answered 404 after deleting gym B's roster). Each case has a positive
// control on gym A's own class, so a refusal means "scoped away", not
// "route broken".

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

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
import * as rosterRoute from "@/app/api/classes/[id]/roster/route";
import * as rosterMemberRoute from "@/app/api/classes/[id]/roster/[memberId]/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

type Role = "owner" | "manager" | "admin" | "coach" | "member";
type RouteResult = { status: number; json: () => Promise<unknown> };
type AnyHandler = (req: never, ctx: never) => Promise<RouteResult>;

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

describe.skipIf(!HAS_DB)("Roster cross-tenant rejection (integration)", () => {
  let tenantAId: string;
  const actorIds: Partial<Record<Role, string>> = {};
  let classAId: string;
  let classBId: string;
  let memberAId: string;
  let memberBId: string;

  function actAs(role: Role) {
    mockAuth.mockResolvedValue({
      user: {
        id: actorIds[role]!,
        tenantId: tenantAId,
        role,
        email: `${role}-a-${STAMP}@xroster.local`,
        name: `${role} A`,
        ...(role === "member" ? { memberId: actorIds[role] } : {}),
      },
    } as never);
  }

  const rosterB = () =>
    withRlsBypass((tx) => tx.classRoster.findMany({ where: { classId: classBId }, orderBy: { id: "asc" } }));
  const subscriptionB = () =>
    withRlsBypass((tx) =>
      tx.classSubscription.findFirst({ where: { classId: classBId, memberId: memberBId } }),
    );

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const tA = await tx.tenant.create({ data: { name: "X-Roster A", slug: `xroster-a-${STAMP}` } });
      const tB = await tx.tenant.create({ data: { name: "X-Roster B", slug: `xroster-b-${STAMP}` } });
      tenantAId = tA.id;

      for (const role of ["owner", "manager", "admin", "coach"] as const) {
        const u = await tx.user.create({
          data: {
            tenantId: tA.id,
            email: `${role}-a-${STAMP}@xroster.local`,
            passwordHash: "$2a$12$test-hash-not-used-in-this-suite",
            name: `${role} A`,
            role,
          },
        });
        actorIds[role] = u.id;
      }
      const ownerB = await tx.user.create({
        data: {
          tenantId: tB.id,
          email: `owner-b-${STAMP}@xroster.local`,
          passwordHash: "$2a$12$test-hash-not-used-in-this-suite",
          name: "Owner B",
          role: "owner",
        },
      });

      memberAId = (await tx.member.create({
        data: { tenantId: tA.id, name: "Roster Member A", email: `rm-a-${STAMP}@xroster.local` },
      })).id;
      actorIds.member = memberAId;
      memberBId = (await tx.member.create({
        data: { tenantId: tB.id, name: "Roster Member B (target)", email: `rm-b-${STAMP}@xroster.local` },
      })).id;

      classAId = (await tx.class.create({ data: { tenantId: tA.id, name: "Roster Class A" } })).id;
      classBId = (await tx.class.create({ data: { tenantId: tB.id, name: "Roster Class B (target)" } })).id;

      // Gym B's own roster entry and subscription — what a cross-tenant
      // DELETE would remove and a cross-tenant GET would disclose.
      await tx.classRoster.create({
        data: { tenantId: tB.id, classId: classBId, memberId: memberBId, addedByUserId: ownerB.id },
      });
      await tx.classSubscription.create({ data: { classId: classBId, memberId: memberBId } });
    });
  });

  afterAll(async () => {
    // Tenant-scoped cleanup by slug prefix, so debris from an interrupted run
    // is cleared too (see the matrix file for why that matters).
    await withRlsBypass(async (tx) => {
      const tenants = await tx.tenant.findMany({ where: { slug: { contains: "xroster-" } }, select: { id: true } });
      const tenantIds = tenants.map((t) => t.id);
      if (tenantIds.length === 0) return;
      const scope = { tenantId: { in: tenantIds } };
      await tx.classSubscription.deleteMany({ where: { member: scope } });
      await tx.classRoster.deleteMany({ where: scope });
      await tx.class.deleteMany({ where: scope });
      await tx.auditLog.deleteMany({ where: scope });
      await tx.member.deleteMany({ where: scope });
      await tx.user.deleteMany({ where: scope });
      await tx.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    });
    vi.restoreAllMocks();
  });

  it("POST /api/classes/[id]/roster rejects member from different tenant with 404", async () => {
    const before = await rosterB();
    for (const role of ["owner", "manager", "admin"] as const) {
      actAs(role);
      // Gym B's member onto gym A's own class.
      const intoA = await call(rosterRoute.POST, "POST", `/api/classes/${classAId}/roster`, { id: classAId }, { memberId: memberBId });
      expect(intoA.status, `${role} member-B into class-A`).toBe(404);
      // Gym B's member onto gym B's class.
      const intoB = await call(rosterRoute.POST, "POST", `/api/classes/${classBId}/roster`, { id: classBId }, { memberId: memberBId });
      expect(intoB.status, `${role} member-B into class-B`).toBe(404);
      // Gym A's member onto gym B's class.
      const aIntoB = await call(rosterRoute.POST, "POST", `/api/classes/${classBId}/roster`, { id: classBId }, { memberId: memberAId });
      expect(aIntoB.status, `${role} member-A into class-B`).toBe(404);
    }
    const leakedIntoA = await withRlsBypass((tx) =>
      tx.classRoster.findFirst({ where: { classId: classAId, memberId: memberBId } }),
    );
    expect(leakedIntoA).toBeNull();
    expect(await rosterB()).toEqual(before);

    for (const role of ["coach", "member"] as const) {
      actAs(role);
      const r = await call(rosterRoute.POST, "POST", `/api/classes/${classBId}/roster`, { id: classBId }, { memberId: memberBId });
      expect(r.status, role).toBe(403);
    }
    expect(await rosterB()).toEqual(before);

    // Positive control: the route does add a same-tenant member.
    actAs("owner");
    const ok = await call(rosterRoute.POST, "POST", `/api/classes/${classAId}/roster`, { id: classAId }, { memberId: memberAId });
    expect(ok.status).toBe(201);
  });

  it("GET /api/classes/[id]/roster returns empty for class in different tenant", async () => {
    for (const role of ["owner", "manager", "admin"] as const) {
      actAs(role);
      const res = await call(rosterRoute.GET, "GET", `/api/classes/${classBId}/roster`, { id: classBId });
      expect(res.status, role).toBe(200);
      expect(res.body.roster, role).toEqual([]);
      expect(res.text).not.toContain(memberBId);
      expect(res.text).not.toContain("Roster Member B (target)");
      expect(res.text).not.toContain(`rm-b-${STAMP}@xroster.local`);
    }
    for (const role of ["coach", "member"] as const) {
      actAs(role);
      const res = await call(rosterRoute.GET, "GET", `/api/classes/${classBId}/roster`, { id: classBId });
      expect(res.status, role).toBe(403);
    }
    // Positive control: gym A's own roster is readable and holds the member
    // the previous case added.
    actAs("owner");
    const own = await call(rosterRoute.GET, "GET", `/api/classes/${classAId}/roster`, { id: classAId });
    expect(own.status).toBe(200);
    expect(own.text).toContain(memberAId);
  });

  it("DELETE /api/classes/[id]/roster/[memberId] cannot remove cross-tenant roster row", async () => {
    const beforeRoster = await rosterB();
    const beforeSub = await subscriptionB();
    expect(beforeRoster).toHaveLength(1);
    expect(beforeSub).not.toBeNull();

    for (const role of ["owner", "manager", "admin"] as const) {
      actAs(role);
      const res = await call(
        rosterMemberRoute.DELETE,
        "DELETE",
        `/api/classes/${classBId}/roster/${memberBId}`,
        { id: classBId, memberId: memberBId },
      );
      expect(res.status, role).toBe(404);
    }
    for (const role of ["coach", "member"] as const) {
      actAs(role);
      const res = await call(
        rosterMemberRoute.DELETE,
        "DELETE",
        `/api/classes/${classBId}/roster/${memberBId}`,
        { id: classBId, memberId: memberBId },
      );
      expect(res.status, role).toBe(403);
    }
    // Both halves of the cascade survived: the roster row and the
    // subscription the route would otherwise cancel.
    expect(await rosterB()).toEqual(beforeRoster);
    expect(await subscriptionB()).toEqual(beforeSub);

    // Positive control: gym A can remove its own roster entry.
    actAs("owner");
    const ok = await call(
      rosterMemberRoute.DELETE,
      "DELETE",
      `/api/classes/${classAId}/roster/${memberAId}`,
      { id: classAId, memberId: memberAId },
    );
    expect(ok.status).toBe(200);
  });
});
