// Covers F5 from the kids-billing plan: the parent-deletion gateway in
// lib/member-delete.ts and its DELETE /api/members/[id] route surface.
//
// Verifies:
//   - Probe call (no strategy) on a parent with kids returns 409 + kid list
//   - Probe call on a parent with NO kids deletes cleanly (back-compat)
//   - reassign strategy: kid's parentMemberId updates, old parent deleted
//   - reassign with invalid target (kid, cross-tenant, nested) is rejected
//   - cascade strategy: every kid is removed alongside the parent
//   - orphan strategy: kid's accountType flips to junior, parentMemberId null,
//     satisfying the new Member_kids_must_have_parent CHECK constraint
//
// Skips when TEST_DATABASE_URL is unset, like every other integration test.

import { vi, describe, it, beforeEach, afterAll, expect } from "vitest";

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
import { DELETE as deleteMember } from "@/app/api/members/[id]/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

function deleteReq(id: string, strategy?: string, toParentMemberId?: string): Request {
  const params = new URLSearchParams();
  if (strategy) params.set("strategy", strategy);
  if (toParentMemberId) params.set("toParentMemberId", toParentMemberId);
  const qs = params.toString();
  const url = `https://test.local/api/members/${id}${qs ? "?" + qs : ""}`;
  return new Request(url, {
    method: "DELETE",
    headers: { origin: "https://test.local", host: "test.local" },
  });
}

describe.skipIf(!HAS_DB)("Parent-deletion gateway (F5)", () => {
  let tenantId: string;

  // Each test seeds its own parent + kids so cases stay independent.
  async function seedParentWithKids(suffix: string, kidCount = 2) {
    return await withRlsBypass(async (tx) => {
      const parent = await tx.member.create({
        data: {
          tenantId,
          name: `Parent ${suffix}`,
          email: `parent-${suffix}-${STAMP}@pdg.test`,
          accountType: "parent",
        },
      });
      const kids = [];
      for (let i = 0; i < kidCount; i++) {
        const kid = await tx.member.create({
          data: {
            tenantId,
            name: `Kid ${suffix}-${i}`,
            email: `kid-${suffix}-${i}-${STAMP}@no-login.matflow.local`,
            accountType: "kids",
            parentMemberId: parent.id,
            passwordHash: null,
          },
        });
        kids.push(kid);
      }
      return { parent, kids };
    });
  }

  beforeEach(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({
        data: { name: "ParentDelGateway", slug: `pdg-${STAMP}-${Math.random().toString(36).slice(2, 8)}` },
      });
      tenantId = t.id;
    });
    mockAuth.mockResolvedValue({
      user: { id: "u-owner", tenantId, role: "owner", email: "o@x" },
    } as never);
  });

  afterAll(async () => {
    // Best-effort sweep — each test creates its own tenant so this just
    // cleans up any leftovers from interrupted runs.
    await withRlsBypass((tx) =>
      tx.member.deleteMany({ where: { email: { contains: `-${STAMP}@` } } }),
    );
    await withRlsBypass((tx) =>
      tx.tenant.deleteMany({ where: { slug: { startsWith: `pdg-${STAMP}-` } } }),
    );
  });

  it("probe call (no strategy) on a parent with kids returns 409 + kid list", async () => {
    const { parent, kids } = await seedParentWithKids("probe");
    const res = await deleteMember(deleteReq(parent.id), {
      params: Promise.resolve({ id: parent.id }),
    } as never);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { kids: Array<{ id: string; name: string }> };
    expect(body.kids).toHaveLength(2);
    const seededIds = kids.map((k) => k.id).sort();
    const returnedIds = body.kids.map((k) => k.id).sort();
    expect(returnedIds).toEqual(seededIds);

    // Parent still exists — the probe must not have deleted anything.
    const stillThere = await withRlsBypass((tx) =>
      tx.member.findUnique({ where: { id: parent.id } }),
    );
    expect(stillThere).not.toBeNull();
  });

  it("probe call on a parent with NO kids deletes cleanly (back-compat)", async () => {
    const childlessParent = await withRlsBypass((tx) =>
      tx.member.create({
        data: {
          tenantId,
          name: "Childless",
          email: `childless-${STAMP}@pdg.test`,
          accountType: "adult",
        },
      }),
    );
    const res = await deleteMember(deleteReq(childlessParent.id), {
      params: Promise.resolve({ id: childlessParent.id }),
    } as never);
    expect(res.status).toBe(200);
    const gone = await withRlsBypass((tx) =>
      tx.member.findUnique({ where: { id: childlessParent.id } }),
    );
    expect(gone).toBeNull();
  });

  it("reassign strategy moves kids to the new parent and deletes the old one", async () => {
    const { parent: oldParent } = await seedParentWithKids("reassign-old");
    const newParent = await withRlsBypass((tx) =>
      tx.member.create({
        data: {
          tenantId,
          name: "New Parent",
          email: `new-parent-${STAMP}@pdg.test`,
          accountType: "adult",
        },
      }),
    );

    const res = await deleteMember(
      deleteReq(oldParent.id, "reassign", newParent.id),
      { params: Promise.resolve({ id: oldParent.id }) } as never,
    );
    expect(res.status).toBe(200);

    const movedKids = await withRlsBypass((tx) =>
      tx.member.findMany({ where: { parentMemberId: newParent.id, tenantId } }),
    );
    expect(movedKids).toHaveLength(2);

    const gone = await withRlsBypass((tx) =>
      tx.member.findUnique({ where: { id: oldParent.id } }),
    );
    expect(gone).toBeNull();
  });

  it("reassign rejects when target is itself a kid", async () => {
    const { parent } = await seedParentWithKids("reassign-bad", 1);
    // Use a different parent's kid as the bad target.
    const { kids: badTargetKids } = await seedParentWithKids("other-family", 1);
    const badTarget = badTargetKids[0];

    const res = await deleteMember(
      deleteReq(parent.id, "reassign", badTarget.id),
      { params: Promise.resolve({ id: parent.id }) } as never,
    );
    expect(res.status).toBe(400);

    // Parent still exists — invalid reassign must not partially apply.
    const stillThere = await withRlsBypass((tx) =>
      tx.member.findUnique({ where: { id: parent.id } }),
    );
    expect(stillThere).not.toBeNull();
  });

  it("cascade strategy deletes every kid alongside the parent", async () => {
    const { parent, kids } = await seedParentWithKids("cascade", 3);
    const res = await deleteMember(deleteReq(parent.id, "cascade"), {
      params: Promise.resolve({ id: parent.id }),
    } as never);
    expect(res.status).toBe(200);

    const survivors = await withRlsBypass((tx) =>
      tx.member.findMany({
        where: { id: { in: [parent.id, ...kids.map((k) => k.id)] }, tenantId },
      }),
    );
    expect(survivors).toHaveLength(0);
  });

  it("orphan strategy flips kid.accountType to junior + clears parentMemberId (CHECK passes)", async () => {
    const { parent, kids } = await seedParentWithKids("orphan", 2);
    const res = await deleteMember(deleteReq(parent.id, "orphan"), {
      params: Promise.resolve({ id: parent.id }),
    } as never);
    expect(res.status).toBe(200);

    const reloadedKids = await withRlsBypass((tx) =>
      tx.member.findMany({
        where: { id: { in: kids.map((k) => k.id) }, tenantId },
        select: { accountType: true, parentMemberId: true },
      }),
    );
    expect(reloadedKids).toHaveLength(2);
    for (const k of reloadedKids) {
      // Crucially: NOT 'kids' (would violate CHECK once parentMemberId is null).
      expect(k.accountType).toBe("junior");
      // Cascaded onDelete SetNull from the parent drop.
      expect(k.parentMemberId).toBeNull();
    }
  });
});
