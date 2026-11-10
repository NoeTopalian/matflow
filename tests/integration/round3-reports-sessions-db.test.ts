// Round 3 (10 Nov 2026): Top classes and fill rate count every session in the
// period. The per-session groupBy in lib/reports.ts kept only the 200 busiest
// sessions (`take: 200`), so over a long period a quieter class vanished from
// Top classes and fill rates were the busiest sessions' only.
//
// One synthetic club on the Neon TEST branch: 250 sessions of a busy class
// (3 check-ins each) and 50 of a quiet class (1 each), all in last club month
// (period "last-month", so the run's time of month never matters).
// Asserted through getReportsData, the Reports page's own load. Runs as both
// roles via the matflow-verify-local db-tests.mjs runner. Fixture prefix r3s-
// (names, slugs, example.test addresses); torn down by tenant id.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: <T,>(fn: T) => fn, revalidateTag: vi.fn() }));

import { randomUUID } from "node:crypto";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { getReportsData } from "@/lib/reports";
import { clubMonthWindow } from "@/lib/club-month";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r3s-${Date.now().toString(36)}`;
const BUSY = 250;
const QUIET = 50;

describe.skipIf(!HAS_DB)("Reports counts every session in the period", () => {
  let tenantId = "";

  beforeAll(async () => {
    tenantId = await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} club`, slug: STAMP, timezone: "Europe/London" } });
      const members = await Promise.all(
        [0, 1, 2].map((i) => tx.member.create({ data: { tenantId: t.id, name: `${STAMP} m${i}`, email: `${STAMP}-m${i}@example.test` } })),
      );
      const busy = await tx.class.create({ data: { tenantId: t.id, name: `${STAMP} Busy`, duration: 60, maxCapacity: 20 } });
      const quiet = await tx.class.create({ data: { tenantId: t.id, name: `${STAMP} Quiet`, duration: 60, maxCapacity: 20 } });
      // The 11th of last club month, London: sessions on that day, check-ins that afternoon.
      const midMonth = new Date(new Date(clubMonthWindow(new Date(), "Europe/London", -1).monthStart).getTime() + 10 * 86_400_000 + 13 * 3_600_000);
      const date = new Date(Date.UTC(midMonth.getUTCFullYear(), midMonth.getUTCMonth(), midMonth.getUTCDate()));
      const time = (i: number) => `${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`;
      const instances: { id: string; classId: string; date: Date; startTime: string }[] = [];
      for (let i = 0; i < BUSY; i++) instances.push({ id: randomUUID(), classId: busy.id, date, startTime: time(i) });
      for (let i = 0; i < QUIET; i++) instances.push({ id: randomUUID(), classId: quiet.id, date, startTime: time(i) });
      await tx.classInstance.createMany({ data: instances });
      let s = 0;
      const at = () => new Date(midMonth.getTime() + 1000 * s++);
      const records = instances.flatMap((inst, n) =>
        (n < BUSY ? members : members.slice(0, 1)).map((m) => ({
          tenantId: t.id, memberId: m.id, classInstanceId: inst.id, checkInTime: at(), checkInMethod: "admin",
        })),
      );
      await tx.attendanceRecord.createMany({ data: records });
      return t.id;
    }, { maxWait: 20_000, timeout: 120_000 });
  }, 180_000);

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.tenant.delete({ where: { id: tenantId } });
    }, { maxWait: 20_000, timeout: 120_000 });
  }, 180_000);

  it("300 sessions: both classes appear, each over all its sessions, and the club fill rate covers all of them", async () => {
    const data = await getReportsData(tenantId, { attendanceRateMode: "fill-rate", period: { period: "last-month" } });
    const busy = data.topClasses.find((c) => c.name === `${STAMP} Busy`);
    const quiet = data.topClasses.find((c) => c.name === `${STAMP} Quiet`);
    expect(busy).toMatchObject({ count: BUSY * 3, sessions: BUSY, averageAttendance: 3, capacityTotal: BUSY * 20, fillRate: 15 });
    expect(quiet).toMatchObject({ count: QUIET, sessions: QUIET, averageAttendance: 1, capacityTotal: QUIET * 20, fillRate: 5 });
    expect(data.attendanceRate).toMatchObject({ mode: "fill-rate", numerator: BUSY * 3 + QUIET, denominator: (BUSY + QUIET) * 20 });
  }, 120_000);
});
