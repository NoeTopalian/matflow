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
      const inst = await tx.classInstance.create({
        data: {
          classId: cls.id,
          date: new Date(),
          startTime: (() => {
            const d = new Date();
            d.setMinutes(d.getMinutes() + 30);
            return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
          })(),
          endTime: "23:59",
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
