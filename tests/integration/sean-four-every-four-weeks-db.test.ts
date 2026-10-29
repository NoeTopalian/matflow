// Sean's request 5 against real Postgres (acceptance, 28 Oct 2026): a plan of
// "4 classes every 4 weeks" lets a member use all four in ONE week, refuses a
// fifth anywhere in that 4-week period (at the member's own door and at the
// desk, with no override), and gives four more when the next period starts.
// Driven through performCheckin, the engine every door calls, with the desk's
// and the member's own arguments. Synthetic club; skips without DATABASE_URL
// (CI's Postgres and the Neon TEST branch run it; never production).

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { performCheckin, type PerformCheckinArgs } from "@/lib/checkin";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
// Monday 3 January 2033: period 1 is 3–30 Jan, period 2 starts Monday 31 Jan.
const ANCHOR = new Date("2033-01-03T00:00:00Z");

describe.skipIf(!HAS_DB)("Sean 5: 4 every 4 weeks, all four in one week (real database)", () => {
  let tenantId = "";
  let userId = "";
  let memberId = "";
  let classId = "";
  const day: Record<string, string> = {};

  function args(classInstanceId: string, door: "self" | "desk"): PerformCheckinArgs {
    const self = door === "self";
    return {
      tenantId, memberId, classInstanceId, method: self ? "self" : "admin",
      enforceRankGate: true, enforceTimeWindow: false, requireCoverage: self,
      enforceCapacity: self, enforceWaiverGate: self, enforceHoldGate: self, enforceKidsGate: self,
      enforceVenueGate: self, enforceClassStateGate: self, allowanceGate: "refuse",
      checkedInByUserId: self ? null : userId,
    };
  }
  const rows = () => withRlsBypass((tx) => tx.attendanceRecord.count({ where: { tenantId, memberId } }));

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: `Four in four ${STAMP}`, slug: `four-in-four-${STAMP}` } })).id;
      userId = (await tx.user.create({ data: { tenantId, email: `four-coach-${STAMP}@example.test`, name: "Coach", role: "coach", passwordHash: "x" } })).id;
      const tierId = (await tx.membershipTier.create({
        data: { tenantId, name: "4 every 4 weeks", classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: ANCHOR },
      })).id;
      memberId = (await tx.member.create({
        data: { tenantId, name: "Four Weeks", email: `four-member-${STAMP}@example.test`, membershipTierId: tierId, waiverAccepted: true, paymentStatus: "paid" },
      })).id;
      classId = (await tx.class.create({ data: { tenantId, name: "Fundamentals", duration: 60, maxCapacity: 50 } })).id;
      // Mon–Fri of the first week, the fourth week's Monday, and the next period's Monday.
      for (const [k, iso] of Object.entries({ mon: "2033-01-03", tue: "2033-01-04", wed: "2033-01-05", thu: "2033-01-06", fri: "2033-01-07", wk4: "2033-01-24", next: "2033-01-31" })) {
        day[k] = (await tx.classInstance.create({ data: { classId, date: new Date(`${iso}T00:00:00Z`), startTime: "18:00", endTime: "19:00" } })).id;
      }
    });
  }, 120_000);

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.membershipTier.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
    expect(await withRlsBypass((tx) => tx.tenant.count({ where: { slug: `four-in-four-${STAMP}` } }))).toBe(0);
  }, 120_000);

  it("all four classes in the first week are admitted (two by the member, two at the desk)", async () => {
    expect((await performCheckin(args(day.mon, "self"))).kind).toBe("success");
    expect((await performCheckin(args(day.tue, "desk"))).kind).toBe("success");
    expect((await performCheckin(args(day.wed, "self"))).kind).toBe("success");
    expect((await performCheckin(args(day.thu, "desk"))).kind).toBe("success");
    expect(await rows()).toBe(4);
  }, 120_000);

  it("a fifth class that week is refused at the member's door and at the desk, used 4 of 4, nothing recorded", async () => {
    expect(await performCheckin(args(day.fri, "self"))).toMatchObject({ kind: "allowance_reached", used: 4, limit: 4 });
    expect(await performCheckin(args(day.fri, "desk"))).toMatchObject({ kind: "allowance_reached", used: 4, limit: 4 });
    expect(await rows()).toBe(4);
  }, 120_000);

  it("a class in the fourth week of the same period is still refused", async () => {
    expect(await performCheckin(args(day.wk4, "desk"))).toMatchObject({ kind: "allowance_reached", used: 4, limit: 4 });
    expect(await rows()).toBe(4);
  }, 120_000);

  it("the next 4-week period starts fresh: its first class is admitted", async () => {
    expect((await performCheckin(args(day.next, "self"))).kind).toBe("success");
    expect(await rows()).toBe(5);
  }, 120_000);
});
