import { describe, it, beforeAll, afterAll, expect } from "vitest";

import { withRlsBypass } from "@/lib/prisma-tenant";
import { performCheckin } from "@/lib/checkin";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

describe.skipIf(!HAS_DB)("Per-tenant check-in window", () => {
  let tenantId: string;
  let memberId: string;
  let classInstanceId: string;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({
        data: {
          name: "CW-Tenant",
          slug: `cw-tenant-${STAMP}`,
          checkinWindowBeforeMin: 5,
          checkinWindowAfterMin: 5,
        },
      });
      tenantId = t.id;
      const m = await tx.member.create({
        data: { tenantId, name: "Tester", email: `t-${STAMP}@cw.test` },
      });
      memberId = m.id;
      const cls = await tx.class.create({
        data: { tenantId, name: "CW Class", duration: 60 },
      });
      // Seed a class 7 days in the future at a fixed time so the test is
      // independent of wall-clock (no midnight-rollover flakiness). The
      // tenant's 5/5 window means check-in is only valid within ±5 min of
      // 12:00 on that future date — comfortably outside it.
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);
      futureDate.setHours(0, 0, 0, 0);
      const inst = await tx.classInstance.create({
        data: {
          classId: cls.id,
          date: futureDate,
          startTime: "12:00",
          endTime: "13:00",
        },
      });
      classInstanceId = inst.id;
    });
  });

  afterAll(async () => {
    await withRlsBypass((tx) => tx.attendanceRecord.deleteMany({ where: { memberId } }));
    await withRlsBypass((tx) => tx.classInstance.deleteMany({ where: { class: { tenantId } } }));
    await withRlsBypass((tx) => tx.class.deleteMany({ where: { tenantId } }));
    await withRlsBypass((tx) => tx.member.deleteMany({ where: { tenantId } }));
    await withRlsBypass((tx) => tx.tenant.deleteMany({ where: { id: tenantId } }));
  });

  it("rejects check-in 30 min before class when tenant window is 5/5", async () => {
    const result = await performCheckin({
      tenantId,
      memberId,
      classInstanceId,
      method: "self",
      enforceRankGate: false,
      enforceRosterGate: false,
      enforceTimeWindow: true,
      requireCoverage: false,
    });
    expect(result.kind).toBe("outside_window");
  });
});
