// Round 6 close-out (13 Nov 2026): the member home's check-in list is the CLUB's today.
//
// The home page asked /api/member/home for sessions on the UTC date (`toISOString()`) and listed the classes of the
// device's weekday. Whenever the club's date and the UTC date differ (every morning before UTC midnight for a club
// east of UTC; 00:00-01:00 in London in summer), today's classes were paired with another date's sessions: a self
// check-in went to that session and the door refused it, or no session was found and the app said "it may have been
// cancelled". Real route, real Postgres (Neon TEST branch), both roles. Synthetic club, torn down.
//
// The club's zone is chosen from the real hour so that the club's date and the UTC date always differ: Kiritimati
// (UTC+14) from 10:00 UTC, else Pago Pago (UTC-11). The test never depends on when it runs.
import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }) },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { clubWallClock } from "@/lib/class-time";
import { GET as homeGET } from "@/app/api/member/home/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r6h${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 180_000 });

describe.skipIf(!HAS_DB)("member home: today's check-in list is the club's day", () => {
  let tenantId = "";
  let memberId = "";
  let classId = "";
  const ZONE = new Date().getUTCHours() >= 10 ? "Pacific/Kiritimati" : "Pacific/Pago_Pago";
  const iso = (c: { year: number; month: number; day: number }) => `${c.year}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
  let club = clubWallClock(new Date(), ZONE);
  let utcDate = new Date().toISOString().slice(0, 10);
  let clubSession = "";
  let utcSession = "";

  beforeAll(async () => {
    club = clubWallClock(new Date(), ZONE);
    utcDate = new Date().toISOString().slice(0, 10);
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: `${STAMP} club`, slug: `${STAMP}-club`, timezone: ZONE } })).id;
      memberId = (await tx.member.create({ data: { tenantId, name: `${STAMP} m`, email: `${STAMP}-m@example.test`, waiverAccepted: true, paymentStatus: "paid" } })).id;
      // One class, at 18:00 on the club's weekday AND on the UTC date's weekday (the dates differ, so the days do).
      const utcDow = new Date(`${utcDate}T00:00:00.000Z`).getUTCDay();
      classId = (await tx.class.create({ data: { tenantId, name: "Club Day Gi", duration: 60 } })).id;
      await tx.classSchedule.createMany({ data: [club.dow, utcDow].map((dayOfWeek) => ({ classId, dayOfWeek, startTime: "18:00", endTime: "19:00" })) });
      clubSession = (await tx.classInstance.create({ data: { classId, date: new Date(`${iso(club)}T00:00:00.000Z`), startTime: "18:00", endTime: "19:00" } })).id;
      utcSession = (await tx.classInstance.create({ data: { classId, date: new Date(`${utcDate}T00:00:00.000Z`), startTime: "18:00", endTime: "19:00" } })).id;
    });
  }, 120_000);

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.classSchedule.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  }, 120_000);

  it("the club's date and the UTC date differ in this run (the case the bug needs)", () => {
    expect(iso(club)).not.toBe(utcDate);
  });

  it("asked with the UTC date the page sends, the answer says the club's today and pairs today's class with the club's session", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: `user-${memberId}`, memberId, tenantId, role: "member", primaryColor: "#3b82f6" } } as never);
    const res = (await homeGET(new Request(`http://test/api/member/home?date=${utcDate}`))) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
    expect(res.status).toBe(200);
    const body = await res.json();
    // The behaviour first: the club's today's class carries the club's session, never the UTC date's.
    const todays = (body.schedule as Array<{ classId: string; dayOfWeek: number; classInstanceId?: string | null }>).filter((r) => r.classId === classId && r.dayOfWeek === club.dow);
    expect(todays).toHaveLength(1);
    expect(todays[0].classInstanceId).not.toBe(utcSession);
    expect(todays[0].classInstanceId).toBe(clubSession);
    // And the page is told which day that is.
    expect(body.today).toEqual({ date: iso(club), dayOfWeek: club.dow });
  });
});
