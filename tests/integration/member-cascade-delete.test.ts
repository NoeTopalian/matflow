// Staff-side Member.DELETE — cascade safety for FK-RESTRICTed dependents.
//
// Catches the regression where a Member with any history (attendance, ranks,
// packs, signed waivers) couldn't be deleted because almost every
// Member-referencing FK in the schema is ON DELETE RESTRICT. The DELETE
// handler now routes through lib/member-delete.ts which purges each dependent
// in dependency order inside a transaction.
//
// Also verifies the orphan-kid contract: a deleted parent's kids survive
// with parentMemberId set to NULL (the schema's existing onDelete: SetNull).
//
// Uses Mode A (Neon test branch + tests/setup-test-db.ts gate). Skips if
// DATABASE_URL unset.

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
import { DELETE as deleteMember } from "@/app/api/members/[id]/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

function deleteReq(): Request {
  return new Request("https://test.local/api/members/x", {
    method: "DELETE",
    headers: { origin: "https://test.local", host: "test.local" },
  });
}

describe.skipIf(!HAS_DB)("Staff Member.DELETE cascade", () => {
  let tenantId: string;
  let ownerUserId: string;
  let memberWithHistoryId: string;
  let kidOrphanId: string;
  let classInstanceId: string;
  let packId: string;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({
        data: { name: "Cascade-T", slug: `cascade-${STAMP}` },
      });
      tenantId = t.id;

      const owner = await tx.user.create({
        data: {
          tenantId: t.id,
          email: `owner-${STAMP}@cascade.test`,
          passwordHash: "$2a$12$not-used",
          name: "Owner",
          role: "owner",
        },
      });
      ownerUserId = owner.id;

      const m = await tx.member.create({
        data: {
          tenantId: t.id,
          name: "Member With History",
          email: `mwh-${STAMP}@cascade.test`,
        },
      });
      memberWithHistoryId = m.id;

      // Kid attached to this member — will be orphaned after parent deletion.
      const kid = await tx.member.create({
        data: {
          tenantId: t.id,
          name: "Soon-To-Be Orphan",
          email: `orphan-${STAMP}@kids.local`,
          parentMemberId: m.id,
        },
      });
      kidOrphanId = kid.id;

      // Stack of FK-RESTRICTed history rows
      const cls = await tx.class.create({
        data: { tenantId: t.id, name: "Cascade BJJ", duration: 60 },
      });
      const inst = await tx.classInstance.create({
        data: { classId: cls.id, date: new Date(), startTime: "10:00", endTime: "11:00" },
      });
      classInstanceId = inst.id;
      const attendance = await tx.attendanceRecord.create({
        data: {
          tenantId: t.id,
          memberId: m.id,
          classInstanceId: inst.id,
          checkInMethod: "admin",
        },
      });

      const rs = await tx.rankSystem.create({
        data: { tenantId: t.id, discipline: "BJJ", name: "Blue", order: 2, color: "#3b82f6" },
      });
      const rank = await tx.memberRank.create({
        data: { memberId: m.id, rankSystemId: rs.id, stripes: 2 },
      });
      await tx.rankHistory.create({
        data: { memberRankId: rank.id, toRankId: rs.id },
      });

      await tx.signedWaiver.create({
        data: {
          memberId: m.id,
          tenantId: t.id,
          titleSnapshot: "Waiver",
          contentSnapshot: "x",
          ipAddress: "127.0.0.1",
        },
      });

      const cp = await tx.classPack.create({
        data: {
          tenantId: t.id,
          name: "5-class pack",
          totalCredits: 5,
          validityDays: 90,
          pricePence: 5000,
        },
      });
      const pack = await tx.memberClassPack.create({
        data: {
          memberId: m.id,
          tenantId: t.id,
          packId: cp.id,
          creditsRemaining: 4,
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
          status: "active",
        },
      });
      packId = pack.id;
      await tx.classPackRedemption.create({
        data: { memberPackId: pack.id, attendanceRecordId: attendance.id, redeemedAt: new Date() },
      });
    });
  });

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      // Best-effort cleanup. Don't fail the suite on already-deleted rows.
      await tx.attendanceRecord.deleteMany({ where: { classInstanceId } }).catch(() => {});
      await tx.classInstance.deleteMany({ where: { id: classInstanceId } }).catch(() => {});
      await tx.class.deleteMany({ where: { tenantId } }).catch(() => {});
      const ranks = await tx.memberRank.findMany({ where: { memberId: { in: [memberWithHistoryId, kidOrphanId] } } });
      if (ranks.length > 0) await tx.rankHistory.deleteMany({ where: { memberRankId: { in: ranks.map((r) => r.id) } } });
      await tx.memberRank.deleteMany({ where: { memberId: { in: [memberWithHistoryId, kidOrphanId] } } });
      const packs = await tx.memberClassPack.findMany({ where: { tenantId } });
      if (packs.length > 0) await tx.classPackRedemption.deleteMany({ where: { memberPackId: { in: packs.map((p) => p.id) } } });
      await tx.memberClassPack.deleteMany({ where: { tenantId } }).catch(() => {});
      await tx.classPack.deleteMany({ where: { tenantId } }).catch(() => {});
      await tx.signedWaiver.deleteMany({ where: { tenantId } }).catch(() => {});
      await tx.member.deleteMany({ where: { tenantId } }).catch(() => {});
      await tx.rankSystem.deleteMany({ where: { tenantId } }).catch(() => {});
      await tx.user.deleteMany({ where: { id: ownerUserId } }).catch(() => {});
      await tx.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
    });
  });

  it("owner can delete a member with full FK-RESTRICTed history", async () => {
    mockAuth.mockResolvedValue({
      user: { id: ownerUserId, tenantId, role: "owner", email: "owner" },
    } as never);

    const res = await deleteMember(deleteReq(), {
      params: Promise.resolve({ id: memberWithHistoryId }),
    });
    expect(res.status).toBe(200);

    const stillThere = await withRlsBypass((tx) =>
      tx.member.findUnique({ where: { id: memberWithHistoryId } }),
    );
    expect(stillThere).toBeNull();

    // All RESTRICTed dependents must have been cleaned up
    const att = await withRlsBypass((tx) =>
      tx.attendanceRecord.count({ where: { memberId: memberWithHistoryId } }),
    );
    expect(att).toBe(0);

    const packAfter = await withRlsBypass((tx) =>
      tx.memberClassPack.findUnique({ where: { id: packId } }),
    );
    expect(packAfter).toBeNull();
  });

  it("kid of deleted parent survives as orphan (parentMemberId = NULL)", async () => {
    const kidAfter = await withRlsBypass((tx) =>
      tx.member.findUnique({
        where: { id: kidOrphanId },
        select: { id: true, parentMemberId: true, tenantId: true },
      }),
    );
    expect(kidAfter).not.toBeNull();
    expect(kidAfter?.parentMemberId).toBeNull();
    expect(kidAfter?.tenantId).toBe(tenantId);
  });
});
