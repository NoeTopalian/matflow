// Verifies the parent-with-no-membership / kid-with-membership case end-to-end.
//
// The user-facing question this answers: "Can a parent Member exist with
// membershipType: null while their kid has membershipType: 'Monthly Unlimited'?"
//
// Covers:
//   1. Schema accepts a parent Member with membershipType: null
//   2. POST /api/member/children creates a kid tied to that parent
//   3. The kid can be assigned a real membershipType via a direct staff update
//      (mirrors the path an owner takes via the Edit Member form)
//   4. Both rows persist with the expected shape — parent.membershipType is
//      still null, kid.membershipType matches what was set
//   5. The parent surfaces correctly when scoped by parentMemberId (the same
//      query the Family panel uses)
//
// Backstop for docs/KIDS-PARENT-LINKAGE-ASSESSMENT-2026-05-15.md Q2. Skips
// when DATABASE_URL is unset (CI gate).

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
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as createChild } from "@/app/api/member/children/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

function jsonReq(body: unknown): Request {
  return new Request("https://test.local/api/member/children", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!HAS_DB)("Parent with no membership + kid with membership", () => {
  let tenantId: string;
  let parentId: string;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({
        data: { name: "ParentNoMembership", slug: `pnm-${STAMP}` },
      });
      tenantId = t.id;

      // Parent: deliberately no membershipType. accountType="parent" (not
      // "adult") to match how the parent-only onboarding wizard sets it.
      const parent = await tx.member.create({
        data: {
          tenantId,
          name: "Parent Without Membership",
          email: `parent-${STAMP}@pnm.test`,
          accountType: "parent",
          // membershipType deliberately omitted — should persist as null
        },
      });
      parentId = parent.id;
    });
  });

  afterAll(async () => {
    await withRlsBypass((tx) => tx.member.deleteMany({ where: { tenantId } }));
    await withRlsBypass((tx) => tx.tenant.deleteMany({ where: { id: tenantId } }));
  });

  it("persists the parent with membershipType=null", async () => {
    const parent = await withRlsBypass((tx) =>
      tx.member.findUnique({
        where: { id: parentId },
        select: { membershipType: true, accountType: true },
      }),
    );
    expect(parent?.membershipType).toBeNull();
    expect(parent?.accountType).toBe("parent");
  });

  it("creates a kid tied to the parent and lets staff set the kid's membership", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-parent", memberId: parentId, tenantId, role: "member", email: "parent" },
    } as never);

    const res = await createChild(
      jsonReq({
        name: "Kid Withmem",
        dateOfBirth: "2017-05-10",
        accountType: "kids",
      }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; name: string };
    const kidId = created.id;

    // Mirror the staff path that assigns a kid's membership — direct DB
    // update via the same wrapper a PATCH /api/members/[id] would use.
    await withRlsBypass((tx) =>
      tx.member.update({
        where: { id: kidId },
        data: { membershipType: "Monthly Unlimited" },
      }),
    );

    const kid = await withRlsBypass((tx) =>
      tx.member.findUnique({
        where: { id: kidId },
        select: {
          membershipType: true,
          parentMemberId: true,
          accountType: true,
          passwordHash: true,
          email: true,
        },
      }),
    );

    expect(kid?.membershipType).toBe("Monthly Unlimited");
    expect(kid?.parentMemberId).toBe(parentId);
    expect(kid?.accountType).toBe("kids");
    expect(kid?.passwordHash).toBeNull();
    // Single-source synthesised-email format from lib/synthesise-kid-email.ts
    expect(kid?.email).toMatch(/^kid-[a-f0-9]{32}@no-login\.matflow\.local$/);
  });

  it("parent still has membershipType=null after kid creation", async () => {
    // No write should touch the parent row. This guards against accidental
    // cascading writes from the create-kid path.
    const parent = await withRlsBypass((tx) =>
      tx.member.findUnique({
        where: { id: parentId },
        select: { membershipType: true },
      }),
    );
    expect(parent?.membershipType).toBeNull();
  });

  it("Family-panel scope (parentMemberId === parent.id) returns the kid only", async () => {
    const kids = await withRlsBypass((tx) =>
      tx.member.findMany({
        where: { parentMemberId: parentId, tenantId },
        select: { id: true, name: true, membershipType: true },
      }),
    );
    expect(kids).toHaveLength(1);
    expect(kids[0].name).toBe("Kid Withmem");
    expect(kids[0].membershipType).toBe("Monthly Unlimited");
  });
});
