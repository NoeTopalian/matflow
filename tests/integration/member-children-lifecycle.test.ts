// Parent-managed kid Member lifecycle.
//
// Covers:
//  - POST /api/member/children creates a kid tied to the calling parent
//  - Cross-tenant tampering rejected (parent in tenant A creates a kid →
//    kid lives in tenant A only — request never reaches tenant B)
//  - No-nesting rule: a member whose parentMemberId is set cannot create
//    grand-kids
//  - Max 10 kids per parent (cap)
//  - DELETE /api/member/children/[id] purges all FK-RESTRICT dependents and
//    drops the kid; parent + non-kid attendance survive
//
// Uses tests/setup-test-db.ts gate against accidental prod-DB use. Skips if
// DATABASE_URL is unset.

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
import { DELETE as deleteChild, PATCH as patchChild } from "@/app/api/member/children/[id]/route";

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

function deleteReq(): Request {
  return new Request("https://test.local/api/member/children/x", {
    method: "DELETE",
    headers: { origin: "https://test.local", host: "test.local" },
  });
}

describe.skipIf(!HAS_DB)("Parent/kid lifecycle", () => {
  let tenantAId: string;
  let parentAId: string;
  let kidWithHistoryId: string;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const tA = await tx.tenant.create({
        data: { name: "Kids-A", slug: `kids-a-${STAMP}` },
      });
      tenantAId = tA.id;

      const parentA = await tx.member.create({
        data: {
          tenantId: tA.id,
          name: "Parent A",
          email: `parent-a-${STAMP}@kids.test`,
        },
      });
      parentAId = parentA.id;
    });
  });

  afterAll(async () => {
    // Tenant-wide sweep — split into separate transactions because doing
    // ~20+ rows of cascading cleanup in a single transaction exceeds Neon's
    // default 5s transaction timeout.
    const memberIds = await withRlsBypass((tx) =>
      tx.member.findMany({ where: { tenantId: tenantAId }, select: { id: true } }),
    );
    const ids = memberIds.map((m) => m.id);
    if (ids.length > 0) {
      const ranks = await withRlsBypass((tx) =>
        tx.memberRank.findMany({ where: { memberId: { in: ids } }, select: { id: true } }),
      );
      if (ranks.length > 0) {
        await withRlsBypass((tx) =>
          tx.rankHistory.deleteMany({ where: { memberRankId: { in: ranks.map((r) => r.id) } } }),
        );
      }
      await withRlsBypass((tx) => tx.memberRank.deleteMany({ where: { memberId: { in: ids } } }));
      await withRlsBypass((tx) => tx.attendanceRecord.deleteMany({ where: { memberId: { in: ids } } }));
    }
    // Sweep waivers by tenant, not by memberId: since the SET NULL retention
    // fix (audit P0-2) a deleted kid's waiver survives with memberId = NULL,
    // so a memberId-scoped sweep would leave it behind.
    await withRlsBypass((tx) => tx.signedWaiver.deleteMany({ where: { tenantId: tenantAId } }));
    await withRlsBypass((tx) => tx.member.deleteMany({ where: { tenantId: tenantAId } }));
    // The "cleanup target" DELETE test seeds Class + ClassInstance +
    // RankSystem. Wipe them before dropping the tenant or its tenant_fkey
    // RESTRICTs reject the final deleteMany.
    const insts = await withRlsBypass((tx) =>
      tx.classInstance.findMany({ where: { class: { tenantId: tenantAId } }, select: { id: true } }),
    );
    if (insts.length > 0) {
      await withRlsBypass((tx) =>
        tx.classInstance.deleteMany({ where: { id: { in: insts.map((i) => i.id) } } }),
      );
    }
    await withRlsBypass((tx) => tx.class.deleteMany({ where: { tenantId: tenantAId } }));
    await withRlsBypass((tx) => tx.rankSystem.deleteMany({ where: { tenantId: tenantAId } }));
    await withRlsBypass((tx) => tx.tenant.deleteMany({ where: { id: tenantAId } }));
  });

  it("creates a kid tied to the calling parent", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-a", memberId: parentAId, tenantId: tenantAId, role: "member", email: "parent-a" },
    } as never);

    const res = await createChild(jsonReq({ name: "Kid Alpha", accountType: "kids" }));
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; name: string };
    expect(body.name).toBe("Kid Alpha");

    const persisted = await withRlsBypass((tx) =>
      tx.member.findUnique({
        where: { id: body.id },
        select: { tenantId: true, parentMemberId: true, accountType: true, passwordHash: true },
      }),
    );
    expect(persisted?.tenantId).toBe(tenantAId);
    expect(persisted?.parentMemberId).toBe(parentAId);
    expect(persisted?.accountType).toBe("kids");
    expect(persisted?.passwordHash).toBeNull();

    // T8a: the child's first status event committed with the child row —
    // exactly one, none -> active, self_signup, no staff actor.
    const events = await withRlsBypass((tx) =>
      tx.memberStatusEvent.findMany({
        where: { tenantId: tenantAId, memberId: body.id },
        select: { fromStatus: true, toStatus: true, reason: true, changedById: true },
      }),
    );
    expect(events).toEqual([{ fromStatus: null, toStatus: "active", reason: "self_signup", changedById: null }]);
  });

  it("rejects nested sub-accounts (kid trying to adopt grand-kid)", async () => {
    // Create a kid first
    mockAuth.mockResolvedValue({
      user: { id: "user-a", memberId: parentAId, tenantId: tenantAId, role: "member", email: "parent-a" },
    } as never);
    const r1 = await createChild(jsonReq({ name: "Mid-Tier" }));
    const mid = await r1.json() as { id: string };

    // Now pretend the kid is logged in and tries to create its own kid.
    mockAuth.mockResolvedValue({
      user: { id: "user-mid", memberId: mid.id, tenantId: tenantAId, role: "member", email: "mid" },
    } as never);
    const r2 = await createChild(jsonReq({ name: "Grand-kid" }));
    expect(r2.status).toBe(400);
  });

  it("enforces the per-parent cap at 10 kids", async () => {
    // Use a SEPARATE throwaway parent so we don't pollute parentAId's kid
    // roster for the PATCH / DELETE tests that follow.
    let capParentId = "";
    await withRlsBypass(async (tx) => {
      const p = await tx.member.create({
        data: { tenantId: tenantAId, name: "Cap Parent", email: `cap-parent-${STAMP}@kids.test` },
      });
      capParentId = p.id;
    });
    mockAuth.mockResolvedValue({
      user: { id: "user-cap", memberId: capParentId, tenantId: tenantAId, role: "member", email: "cap-parent" },
    } as never);
    for (let i = 0; i < 10; i++) {
      const r = await createChild(jsonReq({ name: `Filler ${i}` }));
      expect(r.status).toBe(201);
    }
    const eleventh = await createChild(jsonReq({ name: "Eleventh" }));
    expect(eleventh.status).toBe(409);
  });

  // Contract change 8d2e696 + the 2 Oct family-authority design: removing a
  // child is a relationship change and belongs to an owner or a manager; the
  // member portal refuses it before any read. The FK-RESTRICT cascade purge
  // itself is covered by tests/integration/member-cascade-delete.test.ts.
  it("DELETE by a parent is refused; the kid and every dependent survive", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-a", memberId: parentAId, tenantId: tenantAId, role: "member", email: "parent-a" },
    } as never);

    // Set up a kid with attendance + a signed waiver + a rank to exercise every cleanup branch.
    const newKid = await createChild(jsonReq({ name: "Cleanup Target" }));
    expect(newKid.status).toBe(201);
    kidWithHistoryId = (await newKid.json() as { id: string }).id;

    await withRlsBypass(async (tx) => {
      // Class + instance for an attendance row
      const cls = await tx.class.create({
        data: { tenantId: tenantAId, name: "Kids Open Mat", duration: 60 },
      });
      const inst = await tx.classInstance.create({
        data: { classId: cls.id, date: new Date(), startTime: "10:00", endTime: "11:00" },
      });
      await tx.attendanceRecord.create({
        data: {
          tenantId: tenantAId,
          memberId: kidWithHistoryId,
          classInstanceId: inst.id,
          checkInMethod: "admin",
        },
      });
      // Rank + history
      const rs = await tx.rankSystem.create({
        data: { tenantId: tenantAId, discipline: "BJJ-Kids", name: "White Belt", order: 1, color: "#fff" },
      });
      const rank = await tx.memberRank.create({
        data: { memberId: kidWithHistoryId, rankSystemId: rs.id, stripes: 1 },
      });
      await tx.rankHistory.create({
        data: { memberRankId: rank.id, toRankId: rs.id },
      });
      // Signed waiver
      await tx.signedWaiver.create({
        data: {
          memberId: kidWithHistoryId,
          tenantId: tenantAId,
          titleSnapshot: "Kid waiver",
          contentSnapshot: "blah",
          ipAddress: "127.0.0.1",
        },
      });
    });

    const delRes = await deleteChild(deleteReq(), { params: Promise.resolve({ id: kidWithHistoryId }) });
    expect(delRes.status).toBe(403);
    expect(((await delRes.json()) as { error?: string }).error).toBe("Family relationships are managed by club staff.");

    // Nothing was touched: the kid, every dependent row and the parent survive.
    const after = await withRlsBypass(async (tx) => ({
      kid: await tx.member.findUnique({ where: { id: kidWithHistoryId } }),
      attendance: await tx.attendanceRecord.count({ where: { memberId: kidWithHistoryId } }),
      waivers: await tx.signedWaiver.count({ where: { memberId: kidWithHistoryId } }),
      ranks: await tx.memberRank.count({ where: { memberId: kidWithHistoryId } }),
      parent: await tx.member.findUnique({ where: { id: parentAId } }),
    }));
    expect(after.kid).not.toBeNull();
    expect(after.attendance).toBe(1);
    expect(after.waivers).toBe(1);
    expect(after.ranks).toBe(1);
    expect(after.parent).not.toBeNull();
  });

  it("DELETE of another parent's kid is refused the same way (nothing leaks)", async () => {
    // Create a second parent in same tenant, give them a kid
    let otherKidId = "";
    await withRlsBypass(async (tx) => {
      const otherParent = await tx.member.create({
        data: { tenantId: tenantAId, name: "Other Parent", email: `other-${STAMP}@kids.test` },
      });
      const otherKid = await tx.member.create({
        data: {
          tenantId: tenantAId,
          name: "Not Yours",
          email: `not-yours-${STAMP}@kids.local`,
          parentMemberId: otherParent.id,
        },
      });
      otherKidId = otherKid.id;
    });

    mockAuth.mockResolvedValue({
      user: { id: "user-a", memberId: parentAId, tenantId: tenantAId, role: "member", email: "parent-a" },
    } as never);
    const res = await deleteChild(deleteReq(), { params: Promise.resolve({ id: otherKidId }) });
    // 8d2e696: refused by role before any read — the same 403 whether or not
    // the kid exists or is yours, so possession of an id learns nothing.
    expect(res.status).toBe(403);

    const stillExists = await withRlsBypass((tx) =>
      tx.member.findUnique({ where: { id: otherKidId } }),
    );
    expect(stillExists).not.toBeNull();
  });

  // ─── US-3: PATCH /api/member/children/[id] ───────────────────────────────

  function patchReq(body: unknown): Request {
    return new Request("https://test.local/api/member/children/x", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
      body: JSON.stringify(body),
    });
  }

  it("PATCH renames a kid (parent path)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-a", memberId: parentAId, tenantId: tenantAId, role: "member", email: "parent-a" },
    } as never);
    // Create a kid to rename
    const createRes = await createChild(jsonReq({ name: "Rename Me" }));
    const created = await createRes.json() as { id: string };

    const res = await patchChild(patchReq({ name: "Renamed Successfully" }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(res.status).toBe(200);

    const db = await withRlsBypass((tx) =>
      tx.member.findUnique({ where: { id: created.id }, select: { name: true } }),
    );
    expect(db?.name).toBe("Renamed Successfully");
  });

  it("PATCH cross-parent attempt returns 404 and DB row unchanged", async () => {
    let otherKidId = "";
    let originalName = "";
    await withRlsBypass(async (tx) => {
      const otherParent = await tx.member.create({
        data: { tenantId: tenantAId, name: "Other Parent 2", email: `other2-${STAMP}@kids.test` },
      });
      originalName = "Untouchable";
      const otherKid = await tx.member.create({
        data: {
          tenantId: tenantAId,
          name: originalName,
          email: `untouchable-${STAMP}@kids.local`,
          parentMemberId: otherParent.id,
        },
      });
      otherKidId = otherKid.id;
    });

    mockAuth.mockResolvedValue({
      user: { id: "user-a", memberId: parentAId, tenantId: tenantAId, role: "member", email: "parent-a" },
    } as never);

    const res = await patchChild(patchReq({ name: "Hacked Name" }), {
      params: Promise.resolve({ id: otherKidId }),
    });
    expect(res.status).toBe(404);

    const db = await withRlsBypass((tx) =>
      tx.member.findUnique({ where: { id: otherKidId }, select: { name: true } }),
    );
    expect(db?.name).toBe(originalName);
  });

  // Contract change 8d2e696: a PATCH carrying a guardian-authority or
  // account-type field is refused outright rather than silently stripped —
  // silence would hide the attempt (lib/family-authority.ts). Staff-only
  // fields that do not decide authority are still silently dropped.
  it("PATCH carrying guardian-authority fields is refused and nothing changes", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-a", memberId: parentAId, tenantId: tenantAId, role: "member", email: "parent-a" },
    } as never);
    const createRes = await createChild(jsonReq({ name: "Drop Test" }));
    const created = await createRes.json() as { id: string };

    const res = await patchChild(
      patchReq({
        name: "Drop Test Renamed",
        status: "cancelled",
        accountType: "adult",
        waiverAccepted: true,
        parentMemberId: "some-other-parent",
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe("Family relationships are managed by club staff.");

    const db = await withRlsBypass((tx) =>
      tx.member.findUnique({
        where: { id: created.id },
        select: { name: true, status: true, accountType: true, waiverAccepted: true, parentMemberId: true },
      }),
    );
    expect(db?.name).toBe("Drop Test"); // the whole request was refused
    expect(db?.status).toBe("active");
    expect(db?.accountType).toBe("kids");
    expect(db?.waiverAccepted).toBe(false);
    expect(db?.parentMemberId).toBe(parentAId); // never reassigned
  });

  it("PATCH silently drops non-authority staff fields (status, waiverAccepted) while applying editable ones", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-a", memberId: parentAId, tenantId: tenantAId, role: "member", email: "parent-a" },
    } as never);
    const createRes = await createChild(jsonReq({ name: "Drop Test 2" }));
    const created = await createRes.json() as { id: string };

    const res = await patchChild(
      patchReq({ name: "Drop Test 2 Renamed", status: "cancelled", waiverAccepted: true }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(res.status).toBe(200);

    const db = await withRlsBypass((tx) =>
      tx.member.findUnique({
        where: { id: created.id },
        select: { name: true, status: true, waiverAccepted: true, parentMemberId: true },
      }),
    );
    expect(db?.name).toBe("Drop Test 2 Renamed");
    expect(db?.status).toBe("active"); // dropped, unchanged
    expect(db?.waiverAccepted).toBe(false); // dropped, unchanged
    expect(db?.parentMemberId).toBe(parentAId);
  });

  it("PATCH with no editable fields returns 400", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-a", memberId: parentAId, tenantId: tenantAId, role: "member", email: "parent-a" },
    } as never);
    const createRes = await createChild(jsonReq({ name: "Empty Patch" }));
    const created = await createRes.json() as { id: string };

    const res = await patchChild(patchReq({ status: "cancelled" }), {
      params: Promise.resolve({ id: created.id }),
    });
    // Only forbidden fields => no editable fields => 400
    expect(res.status).toBe(400);
  });
});
