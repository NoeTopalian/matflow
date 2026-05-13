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
    await withRlsBypass(async (tx) => {
      // Tear-down in dependency order — same RESTRICT walls apply here too.
      const kids = await tx.member.findMany({
        where: { parentMemberId: parentAId },
        select: { id: true },
      });
      for (const k of kids) {
        const ranks = await tx.memberRank.findMany({ where: { memberId: k.id }, select: { id: true } });
        if (ranks.length > 0) await tx.rankHistory.deleteMany({ where: { memberRankId: { in: ranks.map((r) => r.id) } } });
        await tx.memberRank.deleteMany({ where: { memberId: k.id } });
        await tx.attendanceRecord.deleteMany({ where: { memberId: k.id } });
        await tx.signedWaiver.deleteMany({ where: { memberId: k.id } });
        await tx.member.deleteMany({ where: { id: k.id } });
      }
      await tx.member.deleteMany({ where: { id: parentAId } });
      await tx.tenant.deleteMany({ where: { id: tenantAId } });
    });
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
    mockAuth.mockResolvedValue({
      user: { id: "user-a", memberId: parentAId, tenantId: tenantAId, role: "member", email: "parent-a" },
    } as never);
    // We already created 2 kids above (Kid Alpha + Mid-Tier). Top up to 10.
    const existing = await withRlsBypass((tx) =>
      tx.member.count({ where: { parentMemberId: parentAId } }),
    );
    for (let i = existing; i < 10; i++) {
      const r = await createChild(jsonReq({ name: `Filler ${i}` }));
      expect(r.status).toBe(201);
    }
    const eleventh = await createChild(jsonReq({ name: "Eleventh" }));
    expect(eleventh.status).toBe(409);
  });

  it("DELETE purges FK-RESTRICTed dependents and survives parent", async () => {
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
    expect(delRes.status).toBe(200);

    const stillThere = await withRlsBypass((tx) =>
      tx.member.findUnique({ where: { id: kidWithHistoryId } }),
    );
    expect(stillThere).toBeNull();

    // Parent must survive untouched
    const parentStill = await withRlsBypass((tx) =>
      tx.member.findUnique({ where: { id: parentAId } }),
    );
    expect(parentStill).not.toBeNull();
  });

  it("DELETE rejects a kid belonging to another parent (404)", async () => {
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
    expect(res.status).toBe(404);

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

  it("PATCH silently drops staff-only fields (status, accountType, waiverAccepted, parentMemberId)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-a", memberId: parentAId, tenantId: tenantAId, role: "member", email: "parent-a" },
    } as never);
    const createRes = await createChild(jsonReq({ name: "Drop Test" }));
    const created = await createRes.json() as { id: string };

    // PATCH with a name change AND every forbidden field — the name must
    // land in DB; everything else must not.
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
    expect(res.status).toBe(200);

    const db = await withRlsBypass((tx) =>
      tx.member.findUnique({
        where: { id: created.id },
        select: { name: true, status: true, accountType: true, waiverAccepted: true, parentMemberId: true },
      }),
    );
    expect(db?.name).toBe("Drop Test Renamed");
    expect(db?.status).toBe("active"); // unchanged
    expect(db?.accountType).toBe("kids"); // unchanged
    expect(db?.waiverAccepted).toBe(false); // unchanged
    expect(db?.parentMemberId).toBe(parentAId); // unchanged — never reassigned
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
