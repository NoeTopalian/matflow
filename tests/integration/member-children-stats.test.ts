// US-4: rich kid stats parity with the parent's own dashboard.
//
// Asserts that GET /api/member/children/[id] returns the same stats + nextClass
// shape that /api/member/me returns for an adult member. Both routes call the
// single shared `computeMemberStats` helper at lib/member-stats.ts — this test
// is what stops the two response shapes from drifting in future edits.
//
// Strategy:
//   - Seed one parent + one kid in a fresh tenant
//   - Seed 3 attendance rows for the kid spanning 2 distinct ISO weeks
//   - Call the kid GET as the parent; verify thisWeek + totalClasses + streak
//   - Verify the response object has the same KEY SET that /api/member/me
//     produces for the parent (the shape contract — values can differ, keys
//     can't)
//
// Uses tests/setup-test-db.ts gate. Skips when DATABASE_URL is unset.

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
import { GET as getChild } from "@/app/api/member/children/[id]/route";
import { GET as getMe } from "@/app/api/member/me/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

function req(): Request {
  return new Request("https://test.local/", {
    method: "GET",
    headers: { origin: "https://test.local", host: "test.local" },
  });
}

describe.skipIf(!HAS_DB)("US-4 rich kid stats parity", () => {
  let tenantId: string;
  let parentId: string;
  let kidId: string;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({
        data: { name: "Stats-Parity", slug: `stats-parity-${STAMP}` },
      });
      tenantId = t.id;

      const parent = await tx.member.create({
        data: { tenantId, name: "Parent", email: `parent-${STAMP}@stats.test` },
      });
      parentId = parent.id;

      const kid = await tx.member.create({
        data: {
          tenantId,
          name: "Kid",
          email: `kid-${STAMP}@kids.local`,
          parentMemberId: parent.id,
          accountType: "kids",
        },
      });
      kidId = kid.id;

      // Class + 3 instances spanning 2 ISO weeks, 1 attendance per instance.
      const cls = await tx.class.create({
        data: { tenantId, name: "Kids Open Mat", duration: 60 },
      });

      const today = new Date();
      const weekAgo = new Date(today);
      weekAgo.setDate(today.getDate() - 8);

      for (const [i, date] of [today, weekAgo, today].entries()) {
        const inst = await tx.classInstance.create({
          data: { classId: cls.id, date, startTime: "10:00", endTime: "11:00" },
        });
        await tx.attendanceRecord.create({
          data: {
            tenantId,
            memberId: kidId,
            classInstanceId: inst.id,
            checkInMethod: "admin",
            // Stagger timestamps so the unique (memberId, classInstanceId) holds
            checkInTime: new Date(date.getTime() - i * 1000),
          },
        });
      }
    });
  });

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.attendanceRecord.deleteMany({ where: { memberId: { in: [parentId, kidId] } } });
      const insts = await tx.classInstance.findMany({ where: { class: { tenantId } }, select: { id: true } });
      await tx.classInstance.deleteMany({ where: { id: { in: insts.map((i) => i.id) } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { id: { in: [parentId, kidId] } } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  it("kid GET response includes stats + nextClass keys with correct shape", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-parent", memberId: parentId, tenantId, role: "member", email: "parent" },
    } as never);

    const res = await getChild(req(), { params: Promise.resolve({ id: kidId }) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    // The contract: stats object with the 7 known keys, nextClass nullable
    expect(body).toHaveProperty("stats");
    expect(body).toHaveProperty("nextClass");
    const stats = body.stats as Record<string, unknown>;
    expect(stats).toMatchObject({
      thisWeek: expect.any(Number),
      thisMonth: expect.any(Number),
      thisYear: expect.any(Number),
      streakWeeks: expect.any(Number),
      totalClasses: expect.any(Number),
      avgClassesPerWeek: expect.any(Number),
    });
    expect(Array.isArray(stats.attendanceByClass)).toBe(true);

    // 3 attendance rows seeded, all within "this year". 2 are "today" so
    // thisWeek must be ≥ 2; totalClasses must be exactly 3.
    expect(stats.totalClasses).toBe(3);
    expect(stats.thisWeek as number).toBeGreaterThanOrEqual(2);
  });

  it("kid stats response shape mirrors /api/member/me", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-parent", memberId: parentId, tenantId, role: "member", email: "parent" },
    } as never);

    const [kidRes, meRes] = await Promise.all([
      getChild(req(), { params: Promise.resolve({ id: kidId }) }),
      getMe(),
    ]);
    expect(kidRes.status).toBe(200);
    expect(meRes.status).toBe(200);

    const kidBody = await kidRes.json() as Record<string, unknown>;
    const meBody = await meRes.json() as Record<string, unknown>;

    const kidStatsKeys = Object.keys(kidBody.stats as object).sort();
    const meStatsKeys = Object.keys(meBody.stats as object).sort();
    expect(kidStatsKeys).toEqual(meStatsKeys);

    // nextClass either both null or both object-shaped — we just check
    // the type, since the parent's nextClass and kid's nextClass come from
    // the same tenant-scoped query and therefore must agree.
    if (kidBody.nextClass !== null && meBody.nextClass !== null) {
      const kidNextKeys = Object.keys(kidBody.nextClass as object).sort();
      const meNextKeys = Object.keys(meBody.nextClass as object).sort();
      expect(kidNextKeys).toEqual(meNextKeys);
    }
  });
});
