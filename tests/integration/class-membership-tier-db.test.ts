// T6a — ClassMembershipTier against real Postgres (Neon child branch).
//
// The unit tests pin the decisions; this proves the Prisma calls, the
// transaction boundaries and the Class row lock really behave:
//  - create with tiers is atomic, rows carry the class's tenantId;
//  - another club's tier id is refused (400) and nothing is written
//    (acceptance 7);
//  - a PATCH that throws after replacing the rows leaves the old rows;
//  - D2: a narrowing keeps the bookings it excludes (acceptance 8 used to
//    delete them) and records them inside the write;
//  - acceptance 9: a tier-list change that commits while a check-in waits on
//    the Class lock is the list the check-in is judged against.
//
// Skips when DATABASE_URL is unset (run on a Neon child branch, never prod).

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

// A switch to make the write transaction throw AFTER the tier rows were
// replaced, to prove it rolls them back. D2 (24 Oct 2026): the durable record
// of kept bookings (recordKeptBookings) is written after the tier and roster
// rewrites, inside the same transaction, so that is where the fault goes.
const fault = vi.hoisted(() => ({ on: false, calls: 0 }));
vi.mock("@/lib/booking-eligibility-db", async (orig) => {
  const real = await orig<typeof import("@/lib/booking-eligibility-db")>();
  return {
    ...real,
    recordKeptBookings: async (...args: Parameters<typeof real.recordKeptBookings>) => {
      fault.calls += 1;
      if (fault.on) throw new Error("injected fault after the tier rows were replaced");
      return real.recordKeptBookings(...args);
    },
  };
});

import { auth } from "@/auth";
import { logAudit } from "@/lib/audit-log";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST } from "@/app/api/classes/route";
import { PATCH } from "@/app/api/classes/[id]/route";
import { performCheckin } from "@/lib/checkin";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

describe.skipIf(!HAS_DB)("ClassMembershipTier — real database", () => {
  let tenantA: string;
  let tenantB: string;
  let ownerA: string;
  let tierBeg: string;
  let tierAdv: string;
  let tierB: string;
  let memberBeg: string;
  let classId: string;
  let instanceId: string;

  const rowsFor = (cid: string) =>
    withRlsBypass((tx) => tx.classMembershipTier.findMany({ where: { classId: cid }, select: { tierId: true, tenantId: true } }));
  const patch = (body: unknown) =>
    PATCH(new Request(`http://test/api/classes/${classId}`, { method: "PATCH", body: JSON.stringify(body) }), {
      params: Promise.resolve({ id: classId }),
    });

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const a = await tx.tenant.create({ data: { name: `Tier A ${STAMP}`, slug: `tier-a-${STAMP}` } });
      const b = await tx.tenant.create({ data: { name: `Tier B ${STAMP}`, slug: `tier-b-${STAMP}` } });
      tenantA = a.id;
      tenantB = b.id;
      const owner = await tx.user.create({
        data: { tenantId: tenantA, email: `tier-owner-${STAMP}@test.local`, name: "Owner", role: "owner", passwordHash: "x" },
      });
      ownerA = owner.id;
      tierBeg = (await tx.membershipTier.create({ data: { tenantId: tenantA, name: "Beginners Unlimited" } })).id;
      tierAdv = (await tx.membershipTier.create({ data: { tenantId: tenantA, name: "Advanced Unlimited" } })).id;
      tierB = (await tx.membershipTier.create({ data: { tenantId: tenantB, name: "Other club tier" } })).id;
      memberBeg = (await tx.member.create({
        data: {
          tenantId: tenantA, name: "Bea Beginner", email: `tier-beg-${STAMP}@test.local`,
          membershipTierId: tierBeg, waiverAccepted: true, paymentStatus: "paid",
        },
      })).id;
    });
    mockAuth.mockResolvedValue({ user: { id: ownerA, role: "owner", tenantId: tenantA } } as never);
  });

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      for (const t of [tenantA, tenantB]) {
        if (!t) continue;
        await tx.attendanceRecord.deleteMany({ where: { tenantId: t } });
        await tx.classMembershipTier.deleteMany({ where: { tenantId: t } });
        await tx.classRoster.deleteMany({ where: { tenantId: t } });
        await tx.classSubscription.deleteMany({ where: { class: { tenantId: t } } });
        await tx.classInstance.deleteMany({ where: { class: { tenantId: t } } });
        await tx.classSchedule.deleteMany({ where: { class: { tenantId: t } } });
        await tx.class.deleteMany({ where: { tenantId: t } });
        await tx.member.deleteMany({ where: { tenantId: t } });
        await tx.membershipTier.deleteMany({ where: { tenantId: t } });
        await tx.user.deleteMany({ where: { tenantId: t } });
        await tx.tenant.deleteMany({ where: { id: t } });
      }
    });
  });

  it("creates a class with its tiers atomically; rows carry the class's tenantId", async () => {
    const res = await POST(new Request("http://test/api/classes", {
      method: "POST",
      body: JSON.stringify({
        name: "Advanced", duration: 60,
        schedules: [{ dayOfWeek: 1, startTime: "19:00", endTime: "20:00" }],
        allowedTierIds: [tierAdv],
      }),
    }));
    expect(res.status).toBe(201);
    classId = ((await res.json()) as { id: string }).id;
    expect(await rowsFor(classId)).toEqual([{ tierId: tierAdv, tenantId: tenantA }]);
  });

  it("acceptance 7: another club's tier id is refused on create and nothing is written", async () => {
    const before = await withRlsBypass((tx) => tx.class.count({ where: { tenantId: tenantA } }));
    const res = await POST(new Request("http://test/api/classes", {
      method: "POST",
      body: JSON.stringify({
        name: "Sneaky", duration: 60,
        schedules: [{ dayOfWeek: 2, startTime: "19:00", endTime: "20:00" }],
        allowedTierIds: [tierAdv, tierB],
      }),
    }));
    expect(res.status).toBe(400);
    expect(await withRlsBypass((tx) => tx.class.count({ where: { tenantId: tenantA } }))).toBe(before);
    expect(await withRlsBypass((tx) => tx.classMembershipTier.count({ where: { tierId: tierB } }))).toBe(0);
  });

  it("acceptance 7: another club's tier id is refused on edit and the rows do not change", async () => {
    const res = await patch({ allowedTierIds: [tierB] });
    expect(res.status).toBe(400);
    expect(await rowsFor(classId)).toEqual([{ tierId: tierAdv, tenantId: tenantA }]);
  });

  it("a PATCH that throws after replacing the rows leaves the old rows", async () => {
    // The fault fires in the durable record written after deleteMany +
    // createMany have run, inside the same transaction.
    await withRlsBypass((tx) => tx.classSubscription.create({ data: { memberId: memberBeg, classId } }));
    fault.calls = 0;
    fault.on = true;
    try {
      const res = await patch({ allowedTierIds: [tierBeg, tierAdv] });
      expect(res.status).toBe(500);
      expect(fault.calls).toBe(1);
    } finally {
      fault.on = false;
    }
    expect(await rowsFor(classId)).toEqual([{ tierId: tierAdv, tenantId: tenantA }]);
    // The booking survived too.
    expect(await withRlsBypass((tx) => tx.classSubscription.count({ where: { classId, memberId: memberBeg } }))).toBe(1);
  });

  it("acceptance 8 (D2): narrowing KEEPS the excluded booking and records it inside the write", async () => {
    // Open the class, then restrict it to Advanced again.
    expect((await patch({ allowedTierIds: [] })).status).toBe(200);
    expect(await rowsFor(classId)).toEqual([]);
    vi.mocked(logAudit).mockClear();
    expect((await patch({ allowedTierIds: [tierAdv] })).status).toBe(200);
    expect(await withRlsBypass((tx) => tx.classSubscription.count({ where: { classId, memberId: memberBeg } }))).toBe(1);
    const kept = (vi.mocked(logAudit).mock.calls as unknown as Array<[{ action: string; tx?: unknown; metadata: Record<string, unknown> }]>)
      .map((c) => c[0])
      .filter((e) => e.action === "class.bookings.kept_ineligible");
    expect(kept).toHaveLength(1);
    expect(kept[0].tx).toBeTruthy();
    expect(kept[0].metadata).toMatchObject({ trigger: "membership", memberIds: [memberBeg], bookingsKept: true });
  });

  it("acceptance 8 (D2) on a ROSTERED class: the rostered member the new list excludes keeps the booking (both must hold at the door)", async () => {
    expect((await patch({ allowedTierIds: [] })).status).toBe(200);
    await withRlsBypass(async (tx) => {
      await tx.classRoster.create({ data: { tenantId: tenantA, classId, memberId: memberBeg } });
      await tx.classSubscription.upsert({
        where: { memberId_classId: { memberId: memberBeg, classId } },
        create: { memberId: memberBeg, classId },
        update: {},
      });
    });
    try {
      expect((await patch({ allowedTierIds: [tierAdv] })).status).toBe(200);
      expect(await withRlsBypass((tx) => tx.classSubscription.count({ where: { classId, memberId: memberBeg } }))).toBe(1);
    } finally {
      await withRlsBypass((tx) => tx.classRoster.deleteMany({ where: { tenantId: tenantA, classId } }));
    }
  });

  it("acceptance 9: a tier change committed while a check-in waits on the Class lock is the list it is judged against", async () => {
    // Open the class first, and give it a session to check into.
    expect((await patch({ allowedTierIds: [] })).status).toBe(200);
    instanceId = (await withRlsBypass((tx) =>
      tx.classInstance.create({ data: { classId, date: new Date("2030-01-07T00:00:00.000Z"), startTime: "06:00", endTime: "07:00" } }),
    )).id;

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });

    // Holder: takes the same Class lock the PATCH takes, restricts the class to
    // Advanced, and holds the lock until released.
    const holder = withRlsBypass(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Class" WHERE "id" = ${classId} FOR UPDATE`;
      await tx.classMembershipTier.create({ data: { tenantId: tenantA, classId, tierId: tierAdv } });
      locked();
      await gate;
    });
    await lockTaken;

    const checkin = performCheckin({
      tenantId: tenantA, memberId: memberBeg, classInstanceId: instanceId, method: "self",
      enforceRankGate: false, enforceTimeWindow: false, requireCoverage: false,
      enforceCapacity: true, enforceWaiverGate: true, enforceHoldGate: true, enforceKidsGate: true,
      enforceVenueGate: true,
    });
    // Let the check-in reach the lock and wait on it.
    await new Promise((r) => setTimeout(r, 500));
    release();
    await holder;

    const result = await checkin;
    expect(result.kind).toBe("tier_not_included");
    expect(await withRlsBypass((tx) => tx.attendanceRecord.count({ where: { classInstanceId: instanceId } }))).toBe(0);
  });
});
