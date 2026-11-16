// Member booking no longer depends on the nightly cron (Round 9, 16 Nov 2026), against real Postgres (the Neon TEST
// branch), as both roles:
//   node .claude/skills/matflow-verify-local/scripts/db-tests.mjs tests/integration/class-horizon-self-heal-db.test.ts
// A club whose classes have schedules but no generated sessions (the horizon lapsed: the cron never ran) is read through
// the real GET /api/member/schedule: the class 30 days ahead now carries a bookable classInstanceId; a cancelled session
// stays cancelled and is not duplicated; a paused class gets nothing; another club gets nothing. Synthetic data only;
// skips without TEST_DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { GET as scheduleGET } from "@/app/api/member/schedule/route";
import { resetClassHorizonMemoForTests } from "@/lib/class-horizon";
import { ROLLING_WINDOW_DAYS } from "@/lib/class-instances";

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!HAS_DB)("the session horizon is topped up by the member read — real database", () => {
  const tenants: string[] = [];
  const ids = { A: "", B: "", live: "", cancelledClass: "", paused: "", other: "", cancelledInstance: "" };
  // A UTC club, so the club's calendar day is the UTC day.
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const target = new Date(today.getTime() + 30 * DAY);
  const targetKey = target.toISOString().slice(0, 10);
  const weekday = target.getUTCDay();

  async function klass(tenantId: string, name: string, isActive = true) {
    const c = await withRlsBypass((tx) =>
      tx.class.create({
        data: { tenantId, name, duration: 60, isActive, schedules: { create: [{ dayOfWeek: weekday, startTime: "18:00", endTime: "19:00" }] } },
        select: { id: true },
      }),
    );
    return c.id;
  }
  const instancesOf = (classId: string) =>
    withRlsBypass((tx) => tx.classInstance.findMany({ where: { classId }, select: { id: true, date: true, isCancelled: true } }));

  beforeAll(async () => {
    for (const label of ["A", "B"]) {
      const t = await withRlsBypass((tx) =>
        tx.tenant.create({ data: { name: `Synthetic horizon ${label}`, slug: `mfv-hz-${randomUUID()}`, timezone: "UTC" }, select: { id: true } }),
      );
      tenants.push(t.id);
    }
    [ids.A, ids.B] = tenants;
    ids.live = await klass(ids.A, "Live class");
    ids.cancelledClass = await klass(ids.A, "Class cancelled that day");
    ids.paused = await klass(ids.A, "Paused class", false);
    ids.other = await klass(ids.B, "Other club class");
    // The owner cancelled the target day's session of the second class before the horizon lapsed: the row is kept.
    ids.cancelledInstance = (
      await withRlsBypass((tx) =>
        tx.classInstance.create({
          data: { classId: ids.cancelledClass, date: target, startTime: "18:00", endTime: "19:00", isCancelled: true, cancellationReason: "Synthetic" },
          select: { id: true },
        }),
      )
    ).id;
    const member = await withRlsBypass((tx) =>
      tx.member.create({ data: { tenantId: ids.A, name: "Synthetic Member", email: `member-${randomUUID()}@example.test` }, select: { id: true } }),
    );
    vi.mocked(auth).mockResolvedValue({ user: { id: `synthetic-member-${member.id}`, role: "member", tenantId: ids.A, memberId: member.id } } as never);
    resetClassHorizonMemoForTests();
  });

  afterAll(async () => {
    if (tenants.length === 0) return;
    await withRlsBypass(async (tx) => {
      await tx.classInstance.deleteMany({ where: { class: { tenantId: { in: tenants } } } });
      await tx.classSchedule.deleteMany({ where: { class: { tenantId: { in: tenants } } } });
      await tx.class.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.member.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.tenant.deleteMany({ where: { id: { in: tenants } } });
    });
  });

  it("starts lapsed: no session exists for the live class", async () => {
    expect(await instancesOf(ids.live)).toHaveLength(0);
  });

  it("the member's schedule read gives the class 30 days ahead a bookable session", async () => {
    const res = await scheduleGET(new Request(`https://test.local/api/member/schedule?date=${targetKey}`));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { classId: string; classInstanceId: string | null; cancelled: boolean }[];
    const live = rows.find((r) => r.classId === ids.live);
    expect(live?.classInstanceId).toEqual(expect.any(String));
    expect(live?.cancelled).toBe(false);
  });

  it("fills the whole rolling window once per week of that weekday, from the club's today", async () => {
    const rows = await instancesOf(ids.live);
    expect(rows).toHaveLength(Math.ceil(ROLLING_WINDOW_DAYS / 7));
    expect(rows.every((r) => r.date.getTime() >= today.getTime() && r.date.getTime() < today.getTime() + ROLLING_WINDOW_DAYS * DAY)).toBe(true);
  });

  it("a cancelled session stays cancelled, is not bookable and is not duplicated", async () => {
    const res = await scheduleGET(new Request(`https://test.local/api/member/schedule?date=${targetKey}`));
    const rows = (await res.json()) as { classId: string; classInstanceId: string | null; cancelled: boolean }[];
    const c = rows.find((r) => r.classId === ids.cancelledClass);
    expect(c?.cancelled).toBe(true);
    expect(c?.classInstanceId).toBeNull();
    const onTarget = (await instancesOf(ids.cancelledClass)).filter((r) => r.date.getTime() === target.getTime());
    expect(onTarget).toEqual([{ id: ids.cancelledInstance, date: target, isCancelled: true }]);
  });

  it("a paused class gets no sessions, and another club gets none", async () => {
    expect(await instancesOf(ids.paused)).toHaveLength(0);
    expect(await instancesOf(ids.other)).toHaveLength(0);
  });
});
