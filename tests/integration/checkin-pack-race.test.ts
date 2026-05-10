// Concurrency regression test: kiosk-path pack credit decrement.
//
// Bug pattern: lib/checkin.ts kiosk-path used findFirst → unguarded
// .update({decrement: 1}). Two parallel kiosk check-ins for the same member
// (consecutive classes, same pack with 1 credit) could both pass the
// findFirst gate and both decrement → pack.creditsRemaining = -1.
//
// Fix (iter-3): copied the self-path's atomic updateMany pattern
// ({where: {id, creditsRemaining: {gt: 0}}}) so only one decrement wins.
//
// This test asserts the invariant: under concurrent kiosk check-ins,
// pack.creditsRemaining never goes negative, and exactly one redemption
// is recorded.

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { performCheckin } from "@/lib/checkin";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

describe.skipIf(!HAS_DB)("Check-in pack-credit race (kiosk path)", () => {
  let tenantId: string;
  let memberId: string;
  let classId: string;
  let packId: string;
  let memberPackId: string;
  let instance1Id: string;
  let instance2Id: string;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: "Pack Race Test", slug: `pack-race-${STAMP}` },
      });
      tenantId = tenant.id;

      const member = await tx.member.create({
        data: {
          tenantId,
          name: "Pack Race Member",
          email: `pack-race-${STAMP}@test.local`,
        },
      });
      memberId = member.id;

      // Class with two instances today (no rank gate, no roster gate).
      const cls = await tx.class.create({
        data: {
          tenantId,
          name: "Pack Race Class",
          duration: 60,
          maxCapacity: 100,
        },
      });
      classId = cls.id;

      // Two distinct instances so the (memberId, classInstanceId) unique
      // constraint doesn't trip — the bug we're testing is the pack
      // decrement race, not the duplicate check-in.
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const i1 = await tx.classInstance.create({
        data: { classId: cls.id, date: today, startTime: "10:00", endTime: "11:00" },
      });
      const i2 = await tx.classInstance.create({
        data: { classId: cls.id, date: today, startTime: "11:00", endTime: "12:00" },
      });
      instance1Id = i1.id;
      instance2Id = i2.id;

      // ClassPack template (per-tenant) + MemberClassPack with exactly 1 credit.
      const pack = await tx.classPack.create({
        data: {
          tenantId,
          name: "Race Test Pack",
          totalCredits: 1,
          validityDays: 30,
          pricePence: 1000,
        },
      });
      packId = pack.id;

      const memberPack = await tx.memberClassPack.create({
        data: {
          tenantId,
          memberId,
          packId: pack.id,
          creditsRemaining: 1,
          status: "active",
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
      memberPackId = memberPack.id;
    });
  });

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.classPackRedemption.deleteMany({ where: { memberPack: { tenantId } } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.memberClassPack.deleteMany({ where: { tenantId } });
      await tx.classPack.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  it("two parallel kiosk check-ins never decrement pack below zero", async () => {
    // Fire both check-ins simultaneously. Both use the kiosk path with
    // requireCoverage=false (kiosk's lenient mode), so both record an
    // attendance regardless of pack state. Only one should successfully
    // decrement the pack.
    const [r1, r2] = await Promise.all([
      performCheckin({
        tenantId,
        memberId,
        classInstanceId: instance1Id,
        method: "kiosk",
        enforceRankGate: false,
        enforceRosterGate: false,
        enforceTimeWindow: false,
        requireCoverage: false,
      }),
      performCheckin({
        tenantId,
        memberId,
        classInstanceId: instance2Id,
        method: "kiosk",
        enforceRankGate: false,
        enforceRosterGate: false,
        enforceTimeWindow: false,
        requireCoverage: false,
      }),
    ]);

    // Both attendances should be recorded (kiosk records even when uncovered).
    expect(r1.kind).toBe("success");
    expect(r2.kind).toBe("success");

    // Pack credits must be at 0 — never negative. This is the load-bearing
    // assertion. Pre-fix code could leave it at -1.
    const finalPack = await withRlsBypass((tx) =>
      tx.memberClassPack.findUnique({ where: { id: memberPackId } }),
    );
    expect(finalPack?.creditsRemaining).toBeGreaterThanOrEqual(0);
    expect(finalPack?.creditsRemaining).toBe(0);

    // Exactly one redemption should be recorded — the race winner.
    const redemptions = await withRlsBypass((tx) =>
      tx.classPackRedemption.findMany({ where: { memberPackId } }),
    );
    expect(redemptions).toHaveLength(1);

    // Silence unused-var lint on packId / classId.
    expect(packId).toBeTruthy();
    expect(classId).toBeTruthy();
  });
});
