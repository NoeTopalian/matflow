// Round 6 (13 Nov 2026): bookings and check-in under real concurrency, against real Postgres (Neon TEST branch),
// both database roles (db-tests.mjs). Real route handlers; every race is concurrent requests (Promise.all), not
// sequential calls. Each case asserts the database state, not just the HTTP answer. Synthetic clubs only (r6b-),
// torn down here.
//
// Rules preserved (programme brief §5, Sean's acceptance record 21 Oct): a booking is a standing place
// (ClassSubscription); the interim capacity rule counts every non-archived booking, including one kept after its
// member stopped being eligible (no released capacity); kept bookings are explained to the member and recorded
// durably; a paused class takes no new bookings; check-in capacity is enforced at the member-decided doors.
import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }) },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as bookPOST, GET as bookingGET } from "@/app/api/member/class-subscriptions/[classId]/route";
import { clubWallClock } from "@/lib/class-time";
import { PATCH as classPATCH } from "@/app/api/classes/[id]/route";
import { GET as scheduleGET } from "@/app/api/member/schedule/route";
import { performCheckin } from "@/lib/checkin";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r6b${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 180_000 });

type Res = { status: number; body: Record<string, unknown> };

describe.skipIf(!HAS_DB)("Round 6: bookings and check-in under concurrency", () => {
  let tenantId = "";
  let ownerId = "";
  let tierA = "";
  let tierB = "";
  const members: string[] = [];

  const asMember = (memberId: string) => ({ user: { id: `user-${memberId}`, memberId, tenantId, role: "member" } });
  const asOwner = () => ({ user: { id: ownerId, tenantId, role: "owner" } });
  // Each concurrent request carries its own session (whatever order the handlers call auth() in).
  const who = new AsyncLocalStorage<unknown>();
  mockAuth.mockImplementation((async () => who.getStore() ?? null) as never);
  type Handler = () => Promise<unknown>;
  const answer = async (session: unknown, call: Handler): Promise<Res> => {
    const r = (await who.run(session, call)) as { status: number; json: () => Promise<Record<string, unknown>> };
    return { status: r.status, body: await r.json() };
  };
  const book = (classId: string, memberId: string) =>
    answer(asMember(memberId), () => bookPOST(new Request(`http://test/api/member/class-subscriptions/${classId}`, { method: "POST" }), { params: Promise.resolve({ classId }) }));
  const patch = (classId: string, body: unknown) =>
    answer(asOwner(), () => classPATCH(new Request(`http://test/api/classes/${classId}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: classId }) }));
  const newClass = (name: string, maxCapacity: number | null) =>
    withRlsBypass(async (tx) => (await tx.class.create({ data: { tenantId, name, duration: 60, maxCapacity } })).id);
  const bookingsOf = (classId: string) =>
    withRlsBypass(async (tx) => (await tx.classSubscription.findMany({ where: { classId }, select: { memberId: true } })).map((s) => s.memberId).sort());
  const session = (classId: string) =>
    withRlsBypass(async (tx) => (await tx.classInstance.create({ data: { classId, date: new Date("2031-03-03T00:00:00.000Z"), startTime: "18:00", endTime: "19:00" } })).id);
  const attendanceOf = (instanceId: string) =>
    withRlsBypass(async (tx) => (await tx.attendanceRecord.findMany({ where: { classInstanceId: instanceId }, select: { memberId: true } })).map((a) => a.memberId).sort());
  const selfCheckin = (memberId: string, classInstanceId: string) =>
    performCheckin({
      tenantId, memberId, classInstanceId, method: "self",
      enforceRankGate: true, enforceTimeWindow: false, requireCoverage: false, enforceCapacity: true, enforceWaiverGate: true,
      enforceHoldGate: true, enforceKidsGate: true, enforceClassStateGate: true,
    });

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: `${STAMP} club`, slug: `${STAMP}-club` } })).id;
      ownerId = (await tx.user.create({ data: { tenantId, email: `${STAMP}-owner@example.test`, name: "Owner", role: "owner", passwordHash: "x" } })).id;
      tierA = (await tx.membershipTier.create({ data: { tenantId, name: "Adults" } })).id;
      tierB = (await tx.membershipTier.create({ data: { tenantId, name: "Juniors" } })).id;
      for (let n = 0; n < 8; n++) {
        members.push((await tx.member.create({
          data: { tenantId, name: `${STAMP} m${n}`, email: `${STAMP}-m${n}@example.test`, membershipTierId: n === 0 ? tierB : tierA, waiverAccepted: true, paymentStatus: "paid" },
        })).id);
      }
    });
  }, 120_000);

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.classSubscription.deleteMany({ where: { class: { tenantId } } });
      await tx.classMembershipTier.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.classSchedule.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.membershipTier.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  }, 120_000);

  it("two members book the last place at once, three rounds: exactly one booked, the other told it is full; one booking row", async () => {
    for (let round = 0; round < 3; round++) {
      const c = await newClass(`Last place ${round}`, 1);
      const [a, b] = [members[1 + round * 2], members[2 + round * 2]];
      const results = await Promise.all([book(c, a), book(c, b)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const full = results.find((r) => r.status === 409)!;
      expect(String(full.body.error)).toMatch(/full/i);
      const winner = results[0].status === 201 ? a : b;
      expect(await bookingsOf(c)).toEqual([winner]);
    }
  });

  it("one member's double submit at once: both answered as booked, one booking row", async () => {
    const c = await newClass("Double submit", 5);
    const results = await Promise.all([book(c, members[1]), book(c, members[1])]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(await bookingsOf(c)).toEqual([members[1]]);
  });

  it("a retry after a lost reply, on a class it filled: still booked, not told it is full; one booking row", async () => {
    const c = await newClass("Lost reply", 1);
    expect((await book(c, members[2])).status).toBe(201); // the reply the client never saw
    expect((await book(c, members[2])).status).toBe(201); // its retry
    expect(await bookingsOf(c)).toEqual([members[2]]);
    // Someone else is still refused: the place is taken once, not twice.
    expect((await book(c, members[3])).status).toBe(409);
  });

  it("a booking kept after its member lost eligibility still holds its place, is explained to them, and is recorded durably", async () => {
    const c = await newClass("Kept place", 1);
    // A timetable slot, so the class is on the member's schedule.
    await withRlsBypass((tx) => tx.classSchedule.create({ data: { classId: c, dayOfWeek: 1, startTime: "18:40", endTime: "19:30" } }));
    expect((await book(c, members[0])).status).toBe(201); // Juniors
    // The club narrows the class to Adults: the Juniors booking is kept (D2), not deleted.
    expect((await patch(c, { allowedTierIds: [tierA] })).status).toBe(200);
    expect(await bookingsOf(c)).toEqual([members[0]]);
    const kept = await withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId, action: "class.bookings.kept_ineligible", entityId: c } }));
    expect(kept.map((r) => r.metadata)).toEqual([expect.objectContaining({ trigger: "membership", memberIds: [members[0]], bookingsKept: true })]);
    // Interim capacity rule: the kept booking still holds the only place.
    const other = await book(c, members[4]);
    expect(other.status).toBe(409);
    expect(await bookingsOf(c)).toEqual([members[0]]);
    // The member sees the class with the door's own sentence, not a silent booking.
    const res = await answer(asMember(members[0]), () => scheduleGET(new Request("http://test/api/member/schedule")));
    expect(res.status).toBe(200);
    const rows = res.body as unknown as Array<{ classId: string; bookedIneligible?: { reason: string; sentence: string } | null }>;
    const mine = rows.filter((r) => r.classId === c);
    expect(mine).toHaveLength(1);
    expect(mine[0].bookedIneligible).toMatchObject({ reason: "tier_not_included" });
    expect(mine[0].bookedIneligible!.sentence.length).toBeGreaterThan(0);
  });

  it("two members check in to the last place of a session at once, three rounds: exactly one attendance row", async () => {
    for (let round = 0; round < 3; round++) {
      const c = await newClass(`Door last place ${round}`, 1);
      const s = await session(c);
      const [a, b] = [members[1 + round * 2], members[2 + round * 2]];
      const results = await Promise.all([selfCheckin(a, s), selfCheckin(b, s)]);
      const kinds = results.map((r) => r.kind).sort();
      expect(kinds).toEqual(["class_full", "success"].sort());
      expect(await attendanceOf(s)).toHaveLength(1);
    }
  });

  it("GET (read-only): a member's own booking and its allowance notice, read back as POST would say it; nothing written; another club's member learns nothing", async () => {
    // A "1 each week" plan, already used today, and a later session of the class today (London, the default zone).
    const c = await newClass("Notice read", 20);
    const club = clubWallClock(new Date(), "Europe/London");
    const day = new Date(Date.UTC(club.year, club.month - 1, club.day));
    const { member, other } = await withRlsBypass(async (tx) => {
      const limited = (await tx.membershipTier.create({ data: { tenantId, name: "Limited W", classLimit: 1, classLimitBasis: "week", maxClassesPerWeek: 1 } })).id;
      const member = (await tx.member.create({ data: { tenantId, name: `${STAMP} limited`, email: `${STAMP}-limited@example.test`, membershipTierId: limited, waiverAccepted: true, paymentStatus: "paid" } })).id;
      const used = await tx.classInstance.create({ data: { classId: c, date: day, startTime: "00:00", endTime: "00:30" } });
      await tx.classInstance.create({ data: { classId: c, date: day, startTime: "23:59", endTime: "23:59" } });
      await tx.attendanceRecord.create({ data: { tenantId, memberId: member, classInstanceId: used.id, checkInMethod: "admin" } });
      const otherClub = (await tx.tenant.create({ data: { name: `${STAMP} other`, slug: `${STAMP}-other` } })).id;
      const other = (await tx.member.create({ data: { tenantId: otherClub, name: `${STAMP} other`, email: `${STAMP}-other@example.test` } })).id;
      return { member, other: { id: other, tenantId: otherClub } };
    });
    const read = (session: unknown) => answer(session, () => bookingGET(new Request(`http://test/api/member/class-subscriptions/${c}`), { params: Promise.resolve({ classId: c }) }));
    const rowsBefore = await bookingsOf(c);

    // Not booked: says so, no notice.
    expect((await read(asMember(member))).body).toEqual({ booked: false, allowanceNotice: null });
    // Booked by POST: the POST's notice, and GET reads back the same notice.
    const posted = await book(c, member);
    expect(posted.status).toBe(201);
    const got = await read(asMember(member));
    expect(got.status).toBe(200);
    expect(got.body.booked).toBe(true);
    expect(typeof got.body.allowanceNotice).toBe("string");
    expect(got.body.allowanceNotice).toBe(posted.body.allowanceNotice);
    // Reading changed nothing: still exactly one booking for this member, the others as they were.
    expect(await bookingsOf(c)).toEqual([...rowsBefore, member].sort());
    // Another club's member, same class id: told nothing about this club's booking.
    expect((await read({ user: { id: `user-${other.id}`, memberId: other.id, tenantId: other.tenantId, role: "member" } })).body).toEqual({ booked: false, allowanceNotice: null });

    await withRlsBypass(async (tx) => {
      await tx.member.deleteMany({ where: { tenantId: other.tenantId } });
      await tx.tenant.deleteMany({ where: { id: other.tenantId } });
    });
  });

  // Ordering itself (a booking either commits before the pause or is refused) comes from the Class FOR UPDATE and the
  // lifecycle read after it (route); this case checks the answers against the rows and a booking after the pause.
  it("a booking racing a pause, five rounds: the answer always matches the database, and once the pause has committed a booking is refused", async () => {
    for (let round = 0; round < 5; round++) {
      const c = await newClass(`Pause race ${round}`, 10);
      const [booked, paused] = await Promise.all([book(c, members[5]), patch(c, { isActive: false })]);
      expect(paused.status).toBe(200);
      const rows = await bookingsOf(c);
      if (booked.status === 201) {
        expect(rows).toEqual([members[5]]); // booked first; the pause keeps it
      } else {
        expect(booked.status).toBe(409);
        expect(booked.body.reason).toBe("class_paused");
        expect(rows).toEqual([]);
      }
      // After the pause has committed, a new booking is always refused.
      const late = await book(c, members[6]);
      expect(late.status).toBe(409);
      expect((await bookingsOf(c)).includes(members[6])).toBe(false);
    }
  });
});
