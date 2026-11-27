// Session cover (PR #134, round 2): what happens to a cover when the class, the session or the coach changes, and
// what members are shown, through the real route handlers on real Postgres.
//  1. Members (schedule, home, children) see only the confirmed covering coach or "Coach to be confirmed": no
//     request, no requester, no "Cover needed". A class with no coach and no request never reads as needing cover.
//  2. Deactivating a covering coach reopens their upcoming covers (reason and Activity): staff see "Cover needed",
//     members "Coach to be confirmed", never the deactivated coach as confirmed.
//  3. A deactivated user, or a user of another club, cannot be assigned.
//  4. Archiving or pausing a class closes the active covers on its upcoming sessions (reason and Activity, same
//     transaction); restoring or resuming it brings no cover back.
//  5. A weekly-slot edit that removes a session closes its cover as session_removed (a session it keeps keeps its
//     cover and is counted); a moved session needs reconfirming, which re-runs the overlap check at the new time; an
//     end-time-only change keeps the session and flags its cover to reconfirm.
// Synthetic data; skips without DATABASE_URL.
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { withRlsBypass } from "@/lib/prisma-tenant";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
const state = vi.hoisted(() => ({ tenantId: "", who: null as null | Record<string, unknown>, queue: [] as Array<{ userId: string; role: string }> }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => (state.who ? { user: state.who } : null)) }));
vi.mock("@/lib/api-authz", () => {
  const next = async () => {
    const who = state.queue.shift();
    if (!who) throw new Error("no identity queued for this request");
    return { ok: true, tenantId: state.tenantId, userId: who.userId, role: who.role, session: { user: { id: who.userId, role: who.role, tenantId: state.tenantId } } };
  };
  return { requireApiStaff: vi.fn(next), requireApiOwnerOrManager: vi.fn(next), requireApiOwner: vi.fn(next) };
});

import { loadCovers, sessionHasStarted } from "@/lib/session-cover";
import { memberCoachLabel, resolveSessionTeacher, staffCoachLabel } from "@/lib/session-coach";
import { POST as coverRoute } from "@/app/api/coach/instances/[id]/cover/route";
import { PATCH as classPATCH, DELETE as classDELETE } from "@/app/api/classes/[id]/route";
import { DELETE as staffDELETE } from "@/app/api/staff/[id]/route";
import { GET as memberSchedule } from "@/app/api/member/schedule/route";
import { GET as memberHome } from "@/app/api/member/home/route";
import { GET as memberChildren } from "@/app/api/member/me/children/route";
import { GET as coverBoard } from "@/app/api/coach/cover/route";
import { GET as coachToday } from "@/app/api/coach/today/route";
import { PATCH as instancePATCH } from "@/app/api/classes/[id]/instances/[instanceId]/route";
import { POST as classPOST } from "@/app/api/classes/route";
import { POST as undoPOST } from "@/app/api/audit-log/[id]/undo/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const thu = (n: number) => new Date(Date.UTC(2033, 2, 3 + 7 * n)); // Thursdays from 3 March 2033
const R4 = (n: number) => new Date(Date.UTC(2034, 0, 5 + 7 * n)); // Thursdays from 5 January 2034 (GMT: wall clock = UTC)
const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const TODAY = new Date(`${todayKey}T00:00:00Z`);
const NEXT_THU = (() => { const d = new Date(TODAY); const dow = d.getUTCDay(); d.setUTCDate(d.getUTCDate() + (((4 - dow + 7) % 7) || 7)); return d; })();

type Json = Record<string, unknown>;
const call = async (res: Promise<unknown>) => {
  const r = (await res) as { status: number; json: () => Promise<unknown> };
  return { status: r.status, body: (await r.json()) as Json & Json[] };
};

describe.skipIf(!HAS_DB)("session cover — class, session and coach changes; member payloads", () => {
  const ids: Record<string, string> = {};
  const ownerUser = () => ({ id: ids.owner, role: "owner", tenantId: state.tenantId });
  const owner = () => ({ userId: ids.owner, role: "owner" });
  const coverRow = (instanceId: string) => withRlsBypass((tx) => tx.sessionCover.findFirst({ where: { tenantId: state.tenantId, classInstanceId: instanceId } }));
  const rowById = (id: string) => withRlsBypass((tx) => tx.sessionCover.findFirst({ where: { tenantId: state.tenantId, id } }));
  const audits = (action: string, extra: Json = {}) => withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId: state.tenantId, action, ...extra }, select: { entityId: true, metadata: true } }));
  const cover = async (instanceId: string, who: { userId: string; role: string }, body: Json) => {
    state.queue.push(who);
    return call(coverRoute(new Request(`http://test/api/coach/instances/${instanceId}/cover`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: instanceId }) }));
  };
  const asOwner = <T>(f: () => Promise<T>) => { state.who = ownerUser(); return f(); };
  const patchClass = (id: string, body: Json) => asOwner(() => call(classPATCH(new Request(`http://test/api/classes/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })));
  const archive = (id: string) => asOwner(() => call(classDELETE(new Request(`http://test/api/classes/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) })));
  const deactivate = (id: string) => asOwner(() => call(staffDELETE(new Request(`http://test/api/staff/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) })));
  /** What staff and members are shown for one session, from the same resolver every surface uses. */
  const labels = async (instanceId: string) =>
    withRlsBypass(async (tx) => {
      const inst = await tx.classInstance.findFirst({
        where: { id: instanceId, class: { tenantId: state.tenantId } },
        select: { id: true, date: true, startTime: true, endTime: true, class: { select: { coachName: true, coachUserId: true, coachUser: { select: { id: true, name: true, deactivatedAt: true } } } } },
      });
      const covers = await loadCovers(tx, state.tenantId, [instanceId]);
      const t = resolveSessionTeacher(inst!.class, covers.get(instanceId) ?? null, { started: sessionHasStarted(inst!, "Europe/London") });
      return { staff: staffCoachLabel(t), member: memberCoachLabel(t) };
    });

  // Round 4: the real payloads. Staff: GET /api/coach/cover (the cover board and the staff timetable read it).
  // Members: GET /api/member/schedule for that date.
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const dayName = (d: Date) => new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(d);
  const flag = (who: string, cls: string, d: Date, time: string, place: string) => `Clash: ${who} is also teaching ${cls} on ${dayName(d)}, ${time}, ${place}`;
  const staffDay = async (d: Date, who: { userId: string; role: string } = owner()) => {
    state.queue.push(who);
    const r = await call(coverBoard(new Request(`http://test/api/coach/cover?from=${ymd(d)}&days=1`)));
    expect(r.status).toBe(200);
    const byId = new Map(((r.body as Json).sessions as Json[]).map((s) => [s.id as string, s]));
    return (id: string) => {
      const s = byId.get(id);
      expect(s, `session ${id} on the cover board`).toBeTruthy();
      return { coach: s!.coachLabel, clash: s!.clashLabel };
    };
  };
  const memberDay = async (d: Date) => {
    state.who = { id: `member-user-${STAMP}`, role: "member", tenantId: state.tenantId, memberId: ids.parent, name: "Parent Synthetic" };
    const r = await call(memberSchedule(new Request(`http://test/api/member/schedule?date=${ymd(d)}`)));
    state.who = null;
    expect(r.status).toBe(200);
    return (name: string) => (r.body as Json[]).find((c) => c.name === name)?.coach;
  };
  const sessionOf = (classId: string, d: Date) =>
    withRlsBypass(async (tx) => (await tx.classInstance.findFirst({ where: { classId, date: d, class: { tenantId: state.tenantId } }, select: { id: true } }))?.id ?? "");

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      state.tenantId = (await tx.tenant.create({ data: { name: `Cover life ${STAMP}`, slug: `cover-life-${STAMP}`, timezone: "Europe/London" } })).id;
      const user = async (key: string, name: string, role: string, tenantId = state.tenantId) =>
        (ids[key] = (await tx.user.create({ data: { tenantId, email: `cover-life-${key}-${STAMP}@example.test`, name, role, passwordHash: "x" } })).id);
      await user("owner", "Olive Owner", "owner");
      await user("alex", "Alex Regular", "coach");
      await user("kim", "Kim Regular", "coach");
      await user("sam", "Sam Cover", "coach");
      await user("pat", "Pat Leaving", "coach");
      await user("rio", "Rio Cover", "coach");
      ids.otherTenant = (await tx.tenant.create({ data: { name: `Cover life other ${STAMP}`, slug: `cover-life-other-${STAMP}` } })).id;
      await user("stranger", "Stranger Coach", "coach", ids.otherTenant);
      const dow = TODAY.getUTCDay();
      // Today's classes, late in the club's day, each with its weekly slot and today's session.
      const today = async (key: string, name: string, location: string, coachUserId: string | null, startTime: string, endTime: string) => {
        ids[key] = (await tx.class.create({ data: { tenantId: state.tenantId, name, location, coachUserId, duration: 45, schedules: { create: [{ dayOfWeek: dow, startTime, endTime }] } } })).id;
        ids[`${key}S`] = (await tx.classInstance.create({ data: { classId: ids[key], date: TODAY, startTime, endTime } })).id;
      };
      await today("p1", `Pay Covered ${STAMP}`, "Mat 1", ids.alex, "22:00", "22:45");
      await today("p2", `Pay Open ${STAMP}`, "Mat 2", ids.kim, "22:00", "22:45");
      await today("p3", `Pay Coachless ${STAMP}`, "Mat 3", null, "22:00", "22:45");
      await today("p4", `Pay Regular ${STAMP}`, "Mat 1", ids.alex, "21:00", "21:45");
      await today("p5", `Pay Leaving ${STAMP}`, "Mat 2", ids.kim, "21:00", "21:45");
      // A parent and their child, who follows all five.
      ids.parent = (await tx.member.create({ data: { tenantId: state.tenantId, name: "Parent Synthetic", email: `cover-life-parent-${STAMP}@example.test` } })).id;
      ids.child = (await tx.member.create({ data: { tenantId: state.tenantId, name: "Child Synthetic", email: `cover-life-child-${STAMP}@example.test`, parentMemberId: ids.parent, guardianConfirmedAt: new Date() } })).id;
      for (const k of ["p1", "p2", "p3", "p4", "p5"]) await tx.classSubscription.create({ data: { memberId: ids.child, classId: ids[k] } });
      // Far-future classes for the lifecycle cases.
      const later = async (key: string, name: string, location: string, n: number[]) => {
        ids[key] = (await tx.class.create({ data: { tenantId: state.tenantId, name, location, coachUserId: ids.alex, duration: 90 } })).id;
        for (const i of n) ids[`${key}${i}`] = (await tx.classInstance.create({ data: { classId: ids[key], date: thu(i), startTime: "19:00", endTime: "20:30" } })).id;
      };
      await later("arc", "Life Archive", "Mat 4", [0, 1]);
      await later("pau", "Life Pause", "Mat 5", [2, 3]);
      await later("dea", "Life Leaving", "Mat 6", [4]);
      const weekly = async (key: string, name: string) => {
        ids[key] = (await tx.class.create({ data: { tenantId: state.tenantId, name, location: "Mat 7", duration: 60, schedules: { create: [{ dayOfWeek: 4, startTime: "07:00", endTime: "08:00" }] } } })).id;
        ids[`${key}S`] = (await tx.classInstance.create({ data: { classId: ids[key], date: NEXT_THU, startTime: "07:00", endTime: "08:00" } })).id;
      };
      await weekly("rem", "Life Removed");
      await weekly("ret", "Life Retime");
      await weekly("mov", "Life Moved");
      // The Thursday after next of Life Removed already has a visit, so a slot edit keeps it (an orphan).
      ids.remKept = (await tx.classInstance.create({ data: { classId: ids.rem, date: new Date(NEXT_THU.getTime() + 7 * 86_400_000), startTime: "07:00", endTime: "08:00" } })).id;
      await tx.attendanceRecord.create({ data: { tenantId: state.tenantId, memberId: ids.parent, classInstanceId: ids.remKept, checkInMethod: "admin" } });
      // Rio's own class straight after Life Moved (back to back at 08:00).
      const own = (await tx.class.create({ data: { tenantId: state.tenantId, name: "Rio Own", location: "Mat 8", coachUserId: ids.rio, duration: 60 } })).id;
      await tx.classInstance.create({ data: { classId: own, date: NEXT_THU, startTime: "08:00", endTime: "09:00" } });

      // Round 3 (review of 7d7b17df).
      await user("quinn", "Quinn Leaving", "coach");
      await user("vic", "Vic Cover", "coach");
      // Blocker 1: Alex's own class and an overlapping session elsewhere, on 7 April 2033.
      await later("bus", "Life Busy", "Mat 9", [5]);
      const uncoached = async (name: string, location: string) => (await tx.class.create({ data: { tenantId: state.tenantId, name, location, duration: 90 } })).id;
      ids.busElse = (await tx.classInstance.create({ data: { classId: await uncoached("Life Elsewhere", "Mat 10"), date: thu(5), startTime: "19:30", endTime: "21:00" } })).id;
      // Nit 3: a class running all day today (already under way) and next week, both covered by Vic.
      ids.allDay = (await tx.class.create({ data: { tenantId: state.tenantId, name: `Life All Day ${STAMP}`, location: "Mat 11", coachUserId: ids.kim, duration: 60, schedules: { create: [{ dayOfWeek: dow, startTime: "00:00", endTime: "23:30" }] } } })).id;
      ids.allDayToday = (await tx.classInstance.create({ data: { classId: ids.allDay, date: TODAY, startTime: "00:00", endTime: "23:30" } })).id;
      ids.allDayNext = (await tx.classInstance.create({ data: { classId: ids.allDay, date: new Date(TODAY.getTime() + 7 * 86_400_000), startTime: "00:00", endTime: "23:30" } })).id;
      for (const s of [ids.allDayToday, ids.allDayNext]) {
        // Accepted before the class began (cover actions refuse a started session, so the row is written directly).
        await tx.sessionCover.create({ data: { tenantId: state.tenantId, classInstanceId: s, status: "covered", coverUserId: ids.vic, requestedById: ids.owner } });
      }
      // Should-fix 5: changing the regular coach. Kim teaches each of these; Vic covers a session elsewhere.
      const coached = async (key: string, name: string, n: number) => {
        ids[key] = (await tx.class.create({ data: { tenantId: state.tenantId, name, location: "Mat 12", coachUserId: ids.kim, duration: 90 } })).id;
        ids[`${key}S`] = (await tx.classInstance.create({ data: { classId: ids[key], date: thu(n), startTime: "19:00", endTime: "20:30" } })).id;
      };
      await coached("cch", "Life Coach Clash", 6);
      ids.cchElse = (await tx.classInstance.create({ data: { classId: await uncoached("Life Vic Covers", "Mat 13"), date: thu(6), startTime: "20:00", endTime: "21:00" } })).id;
      await coached("cb2b", "Life Coach Back To Back", 7);
      ids.cb2bElse = (await tx.classInstance.create({ data: { classId: await uncoached("Life Vic After", "Mat 13"), date: thu(7), startTime: "20:30", endTime: "21:30" } })).id;
      await coached("cown", "Life Coach Own Cover", 8);
      ids.cownElse = (await tx.classInstance.create({ data: { classId: await uncoached("Life Vic Same Time", "Mat 13"), date: thu(8), startTime: "19:00", endTime: "20:30" } })).id;
      // The other club holds a covered session of its own, so deactivation's tenant scope is tested.
      const otherClass = (await tx.class.create({ data: { tenantId: ids.otherTenant, name: "Other club class", location: "Mat 1", duration: 60 } })).id;
      ids.otherS = (await tx.classInstance.create({ data: { classId: otherClass, date: thu(4), startTime: "19:00", endTime: "20:00" } })).id;
      await user("otherOwner", "Other Owner", "owner", ids.otherTenant);
      await tx.sessionCover.create({ data: { tenantId: ids.otherTenant, classInstanceId: ids.otherS, status: "covered", coverUserId: ids.stranger, requestedById: ids.otherOwner } });

      // Round 4 (review of 121529e4): one person shown on two overlapping sessions, one of them a cover. Each case has
      // its own coach, so no case depends on another. Every class has its Thursday slot, so the member schedule lists it.
      for (const [key, name] of [["ada", "Ada Regular"], ["pia", "Pia Leaving"], ["cora", "Cora Move"], ["eli", "Eli Extend"], ["rhea", "Rhea Restore"], ["remy", "Remy Resume"], ["una", "Una Undo"], ["cal", "Cal Create"], ["bea", "Bea Back"], ["reg", "Reg Twice"], ["wes", "Wes Twice"], ["wyn", "Wyn Covering"], ["otto", "Otto Clubs"]]) {
        await user(key, name, "coach");
      }
      const r4 = async (key: string, name: string, location: string, coachUserId: string | null, date: Date | null, startTime: string, endTime: string, tenantId = state.tenantId, isActive = true) => {
        ids[key] = (await tx.class.create({ data: { tenantId, name, location, coachUserId, duration: 60, isActive, schedules: { create: [{ dayOfWeek: 4, startTime, endTime }] } } })).id;
        if (date) ids[`${key}S`] = (await tx.classInstance.create({ data: { classId: ids[key], date, startTime, endTime } })).id;
      };
      // Should-fix 1: Ada's Mat 1 class and the simultaneous Mat 2 session.
      await r4("sf1Own", "R4 Ada Mat 1", "Mat 1", ids.ada, R4(0), "19:00", "20:30");
      await r4("sf1Else", "R4 Ada Mat 2", "Mat 2", null, R4(0), "19:00", "20:30");
      // Should-fix 2, within the rolling window (a slot edit, a resume and a new class mint there).
      await r4("mvX", "R4 Move Own", "Mat 21", ids.cora, NEXT_THU, "19:00", "20:00");
      await r4("mvY", "R4 Move Covered", "Mat 22", null, NEXT_THU, "20:00", "21:00");
      await r4("exX", "R4 Extend Own", "Mat 23", ids.eli, NEXT_THU, "17:00", "18:00");
      await r4("exY", "R4 Extend Covered", "Mat 24", null, NEXT_THU, "18:00", "19:00");
      await r4("reX", "R4 Resume Coach Change", "Mat 27", ids.kim, null, "15:00", "16:00", state.tenantId, false);
      await r4("reX2", "R4 Resume Same Coach", "Mat 28", ids.remy, null, "15:00", "16:00", state.tenantId, false);
      await r4("reY", "R4 Resume Covered", "Mat 29", null, NEXT_THU, "15:30", "16:30");
      await r4("crY", "R4 Create Covered", "Mat 32", null, NEXT_THU, "12:00", "13:00");
      // Should-fix 2, far ahead.
      await r4("rsX", "R4 Restore Own", "Mat 25", ids.rhea, R4(1), "19:00", "20:30");
      await r4("rsY", "R4 Restore Covered", "Mat 26", null, R4(1), "19:00", "20:30");
      await r4("unX", "R4 Undo Own", "Mat 30", ids.una, R4(2), "19:00", "20:30");
      await r4("unY", "R4 Undo Covered", "Mat 31", null, R4(2), "19:00", "20:30");
      // No flag: back to back, and two classes of the same regular coach at once.
      await r4("bbX", "R4 B2B Own", "Mat 34", ids.bea, R4(3), "20:00", "21:00");
      await r4("bbY", "R4 B2B Covered", "Mat 35", null, R4(3), "19:00", "20:00");
      await r4("rrA", "R4 Twice A", "Mat 36", ids.reg, R4(4), "19:00", "20:30");
      await r4("rrB", "R4 Twice B", "Mat 37", ids.reg, R4(4), "19:00", "20:30");
      // Nit 1: Withdraw/Return on an open row.
      await r4("wdA", "R4 Withdraw Kids", "Mat 38", ids.wes, R4(5), "19:00", "20:30");
      await r4("wdB", "R4 Withdraw Adults", "Mat 39", ids.wes, R4(5), "19:00", "20:30");
      await r4("wrX", "R4 Refuse Own", "Mat 40", ids.wyn, R4(6), "19:00", "20:30");
      await r4("wrY", "R4 Refuse Covered", "Mat 41", null, R4(6), "19:00", "20:30");
      // As a deactivation leaves it (the blocker-1 state): Wyn's own class has an open request, and Wyn covers the
      // simultaneous session. Written directly: no single cover action can make it.
      await tx.sessionCover.create({ data: { tenantId: state.tenantId, classInstanceId: ids.wrXS, status: "open", requestedById: ids.owner } });
      await tx.sessionCover.create({ data: { tenantId: state.tenantId, classInstanceId: ids.wrYS, status: "covered", coverUserId: ids.wyn, requestedById: ids.owner } });
      // Another club at the same times: Otto's clash here must not reach it, and its rows must not reach Otto's views.
      await r4("ocX", "R4 Otto Own", "Mat 42", ids.otto, R4(7), "19:00", "20:30");
      await r4("ocY", "R4 Otto Covered", "Mat 43", null, R4(7), "19:00", "20:30");
      await tx.sessionCover.create({ data: { tenantId: state.tenantId, classInstanceId: ids.ocYS, status: "covered", coverUserId: ids.otto, requestedById: ids.owner } });
      await r4("ocOther", "R4 Other Club Own", "Mat 1", ids.stranger, R4(7), "19:00", "20:30", ids.otherTenant);
      // A row only an unscoped query could pick up: the other club's earlier session "covered" by Otto.
      await r4("ocTrap", "R4 Other Club Trap", "Mat 2", null, R4(7), "18:30", "19:30", ids.otherTenant);
      await tx.sessionCover.create({ data: { tenantId: ids.otherTenant, classInstanceId: ids.ocTrapS, status: "covered", coverUserId: ids.otto, requestedById: ids.otherOwner } });
    }, { timeout: 240_000 }); // ~150 inserts: past the default 15 s budget at the test branch's latency from Bali
  }, 300_000);

  afterAll(async () => {
    if (!state.tenantId) return;
    const tenantId = state.tenantId;
    await new Promise((r) => setTimeout(r, 1_500));
    const both = { in: [tenantId, ids.otherTenant] };
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: both } });
      await tx.sessionCover.deleteMany({ where: { tenantId: both } });
      await tx.classSubscription.deleteMany({ where: { class: { tenantId } } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId: both } } });
      await tx.classSchedule.deleteMany({ where: { class: { tenantId: both } } });
      await tx.class.deleteMany({ where: { tenantId: both } });
      await tx.member.deleteMany({ where: { tenantId, parentMemberId: { not: null } } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId: { in: [tenantId, ids.otherTenant] } } });
      await tx.tenant.deleteMany({ where: { id: { in: [tenantId, ids.otherTenant] } } });
      // The undo route's rate-limit hits for this club (round 4).
      await tx.rateLimitHit.deleteMany({ where: { bucket: `audit-undo:${tenantId}` } });
    });
  }, 120_000);

  it("covers are set up through the route: Sam covers Pay Covered, Pay Open needs cover, Pat covers two sessions", async () => {
    expect((await cover(ids.p1S, owner(), { action: "assign", coachUserId: ids.sam })).status).toBe(200);
    expect((await cover(ids.p2S, owner(), { action: "request" })).status).toBe(200);
    expect((await cover(ids.p5S, owner(), { action: "assign", coachUserId: ids.pat })).status).toBe(200);
    expect((await cover(ids.dea4, owner(), { action: "assign", coachUserId: ids.pat })).status).toBe(200);
  }, 120_000);

  it("deactivating Pat reopens both of Pat's covers, with an Activity row each; nobody sees Pat as confirmed", async () => {
    const r = await deactivate(ids.pat);
    expect(r.status).toBe(200);
    for (const s of [ids.p5S, ids.dea4]) expect(await coverRow(s)).toMatchObject({ status: "open", coverUserId: null, needsReconfirm: false });
    const rows = await audits("class.cover_given_up");
    expect(rows.filter((a) => (a.metadata as Json).reason === "coach_deactivated").map((a) => a.entityId).sort()).toEqual([ids.p5S, ids.dea4].sort());
    expect(await labels(ids.dea4)).toEqual({ staff: "Cover needed · Alex Regular away", member: "Coach to be confirmed" });
  }, 120_000);

  it("a deactivated user, or a user of another club, cannot be assigned", async () => {
    expect(await cover(ids.dea4, owner(), { action: "assign", coachUserId: ids.pat })).toMatchObject({ status: 400, body: { code: "NOT_ELIGIBLE" } });
    expect(await cover(ids.dea4, owner(), { action: "assign", coachUserId: ids.stranger })).toMatchObject({ status: 400, body: { code: "NOT_ELIGIBLE" } });
    expect(await coverRow(ids.dea4)).toMatchObject({ status: "open", coverUserId: null });
  }, 60_000);

  it("members see the confirmed coach or 'Coach to be confirmed', never a request or who asked; a coachless class is not 'cover needed'", async () => {
    state.who = { id: `member-user-${STAMP}`, role: "member", tenantId: state.tenantId, memberId: ids.parent, name: "Parent Synthetic" };
    const sched = await call(memberSchedule(new Request(`http://test/api/member/schedule?date=${todayKey}`)));
    const home = await call(memberHome());
    const kids = await call(memberChildren(new Request("http://test/api/member/me/children?include=timetable")));
    expect([sched.status, home.status, kids.status]).toEqual([200, 200, 200]);
    const byName = (list: Json[], name: string) => list.find((c) => c.name === name) as Json | undefined;
    const expected: Array<[string, string, string | null]> = [
      [`Pay Covered ${STAMP}`, "Sam Cover", "Sam Cover"],
      [`Pay Open ${STAMP}`, "Coach to be confirmed", "Coach to be confirmed"],
      [`Pay Coachless ${STAMP}`, "TBC", null],
      [`Pay Regular ${STAMP}`, "Alex Regular", null],
      [`Pay Leaving ${STAMP}`, "Coach to be confirmed", "Coach to be confirmed"],
    ];
    const homeSchedule = (home.body as Json).schedule as Json[];
    const timetable = ((kids.body as Json[])[0]?.timetable ?? []) as Json[];
    const homeKids = (((home.body as Json).children as Json[])[0]?.timetable ?? []) as Json[];
    for (const [name, scheduleCoach, kidCoach] of expected) {
      expect(byName(sched.body as Json[], name)?.coach, `schedule: ${name}`).toBe(scheduleCoach);
      expect(byName(homeSchedule, name)?.coach, `home: ${name}`).toBe(scheduleCoach);
      // The children's timetable shows a class's typed name, or the cover label; a linked regular coach is not named there.
      expect(timetable.find((t) => t.className === name || t.name === name)?.coach ?? null, `children: ${name}`).toBe(kidCoach);
      expect(homeKids.find((t) => t.className === name || t.name === name)?.coach ?? null, `home children: ${name}`).toBe(kidCoach);
    }
    const all = JSON.stringify([sched.body, home.body, kids.body]);
    for (const leak of ["Olive Owner", "Pat Leaving", "Cover needed", "requestedBy", "needsReconfirm", "coverUserId", "cover_requested"]) {
      expect(all.includes(leak), leak).toBe(false);
    }
    state.who = null;
  }, 180_000);

  it("archiving a class closes the active covers on its upcoming sessions; restoring it brings none back", async () => {
    expect((await cover(ids.arc0, owner(), { action: "assign", coachUserId: ids.sam })).status).toBe(200);
    expect((await cover(ids.arc1, owner(), { action: "request" })).status).toBe(200);
    const coverIds = [(await coverRow(ids.arc0))!.id, (await coverRow(ids.arc1))!.id];
    expect((await archive(ids.arc)).status).toBe(200);
    for (const id of coverIds) expect(await rowById(id)).toMatchObject({ status: "closed", closedReason: "class_archived", coverUserId: null });
    expect((await audits("class.cover_closed", { entityId: { in: [ids.arc0, ids.arc1] } })).length).toBe(2);
    expect((await patchClass(ids.arc, { isActive: true })).status).toBe(200);
    for (const id of coverIds) expect(await rowById(id)).toMatchObject({ status: "closed", coverUserId: null });
    expect(await labels(ids.arc0)).toEqual({ staff: "Alex Regular", member: "Alex Regular" });
  }, 180_000);

  it("pausing a class closes the active covers on its upcoming sessions; resuming it brings none back", async () => {
    expect((await cover(ids.pau2, owner(), { action: "assign", coachUserId: ids.sam })).status).toBe(200);
    expect((await cover(ids.pau3, owner(), { action: "request" })).status).toBe(200);
    const coverIds = [(await coverRow(ids.pau2))!.id, (await coverRow(ids.pau3))!.id];
    expect((await patchClass(ids.pau, { isActive: false })).status).toBe(200);
    for (const id of coverIds) expect(await rowById(id)).toMatchObject({ status: "closed", closedReason: "class_paused", coverUserId: null });
    expect((await audits("class.cover_closed", { entityId: { in: [ids.pau2, ids.pau3] } })).length).toBe(2);
    expect((await patchClass(ids.pau, { isActive: true })).status).toBe(200);
    for (const id of coverIds) expect(await rowById(id)).toMatchObject({ status: "closed", coverUserId: null });
    // Sam is free again: claiming an overlapping session elsewhere is no longer refused by the paused class.
    expect(await labels(ids.pau2)).toEqual({ staff: "Alex Regular", member: "Alex Regular" });
  }, 180_000);

  it("a weekly-slot edit that removes a session closes its cover as session_removed; a session it keeps keeps its cover and is counted", async () => {
    expect((await cover(ids.remS, owner(), { action: "assign", coachUserId: ids.rio })).status).toBe(200);
    expect((await cover(ids.remKept, owner(), { action: "assign", coachUserId: ids.sam })).status).toBe(200);
    const coverId = (await coverRow(ids.remS))!.id;
    const r = await patchClass(ids.rem, { name: "Life Removed", schedules: [{ dayOfWeek: 2, startTime: "07:00", endTime: "08:00" }] });
    expect(r.status).toBe(200);
    expect((r.body.scheduleChange as Json).coverClosed).toEqual([{ date: NEXT_THU.toISOString(), startTime: "07:00", closedReason: "session_removed" }]);
    expect(await rowById(coverId)).toMatchObject({ status: "closed", closedReason: "session_removed", classInstanceId: null, coverUserId: null });
    // The orphan keeps running at its old time, so its cover stays; the save message counts it.
    expect((r.body.scheduleChange as Json).instancesKept).toEqual([ids.remKept]);
    expect((r.body.scheduleChange as Json).coverKept).toBe(1);
    expect(await coverRow(ids.remKept)).toMatchObject({ status: "covered", coverUserId: ids.sam });
  }, 180_000);

  it("a moved session needs its coach to reconfirm, and reconfirming re-runs the overlap check at the new time", async () => {
    expect((await cover(ids.movS, owner(), { action: "assign", coachUserId: ids.rio })).status).toBe(200);
    const r = await patchClass(ids.mov, { name: "Life Moved", schedules: [{ dayOfWeek: 4, startTime: "07:30", endTime: "08:30" }] });
    expect(r.status).toBe(200);
    expect((r.body.scheduleChange as Json).coverMoved).toBe(1);
    const row = await withRlsBypass((tx) => tx.sessionCover.findFirst({ where: { tenantId: state.tenantId, coverUserId: ids.rio, status: "covered" }, include: { classInstance: true } }));
    expect(row).toMatchObject({ needsReconfirm: true });
    expect(row?.classInstance).toMatchObject({ startTime: "07:30", date: NEXT_THU });
    expect(await labels(row!.classInstanceId!)).toEqual({ staff: "Covered by Rio Cover · Awaiting reconfirmation", member: "Coach to be confirmed" });
    // 07:30-08:30 now runs into Rio's own 08:00 class: accepting the new time is refused by name.
    const re = await cover(row!.classInstanceId!, { userId: ids.rio, role: "coach" }, { action: "reconfirm" });
    expect(re).toMatchObject({ status: 409, body: { code: "OVERLAP" } });
    expect(String(re.body.error)).toContain("already teaching Rio Own");
    expect(await coverRow(row!.classInstanceId!)).toMatchObject({ status: "covered", needsReconfirm: true });
  }, 180_000);

  it("an end-time-only change keeps the session and flags its cover to reconfirm, with an Activity row", async () => {
    expect((await cover(ids.retS, owner(), { action: "assign", coachUserId: ids.sam })).status).toBe(200);
    const r = await patchClass(ids.ret, { name: "Life Retime", schedules: [{ dayOfWeek: 4, startTime: "07:00", endTime: "08:30" }] });
    expect(r.status).toBe(200);
    expect(await coverRow(ids.retS)).toMatchObject({ status: "covered", coverUserId: ids.sam, needsReconfirm: true });
    expect((await withRlsBypass((tx) => tx.classInstance.findFirst({ where: { id: ids.retS } })))?.endTime).toBe("08:30");
    expect((await audits("class.cover_reconfirm_flagged", { entityId: ids.retS })).length).toBe(1);
    expect(await labels(ids.retS)).toEqual({ staff: "Covered by Sam Cover · Awaiting reconfirmation", member: "Coach to be confirmed" });
  }, 180_000);

  // ── Round 3 (review of 7d7b17df) ──────────────────────────────────────────────────────────────────────────────
  it("blocker 1: after a deactivation reopens Alex's class, Withdraw and Return are refused while Alex covers an overlapping session", async () => {
    expect((await cover(ids.bus5, owner(), { action: "assign", coachUserId: ids.quinn })).status).toBe(200);
    // Quinn covers Alex's class, so Alex is free to cover Life Elsewhere at the same time.
    expect((await cover(ids.busElse, owner(), { action: "request" })).status).toBe(200);
    expect((await cover(ids.busElse, { userId: ids.alex, role: "coach" }, { action: "claim" })).status).toBe(200);
    expect((await deactivate(ids.quinn)).status).toBe(200);
    expect(await coverRow(ids.bus5)).toMatchObject({ status: "open", coverUserId: null });
    for (const action of ["withdraw", "return"]) {
      const r = await cover(ids.bus5, owner(), { action });
      expect(r, action).toMatchObject({ status: 409, body: { code: "REGULAR_COACH_BUSY", conflict: { instanceId: ids.busElse, className: "Life Elsewhere" } } });
      expect(String(r.body.error)).toMatch(/would put Alex Regular back on this class while they teach Life Elsewhere on \w+day \d+ \w+, 19:30–21:00, Mat 10\./);
    }
    // Nobody was assigned: the request stays open and visible, and Alex still covers Life Elsewhere only.
    expect(await coverRow(ids.bus5)).toMatchObject({ status: "open", coverUserId: null });
    expect(await coverRow(ids.busElse)).toMatchObject({ status: "covered", coverUserId: ids.alex });
    expect(await labels(ids.bus5)).toEqual({ staff: "Cover needed · Alex Regular away", member: "Coach to be confirmed" });
    expect((await audits("class.cover_withdrawn", { entityId: ids.bus5 })).length).toBe(0);
    expect((await audits("class.cover_returned_to_regular", { entityId: ids.bus5 })).length).toBe(0);
  }, 180_000);

  it("deactivation reaches only the owner's own club: another club's cover and coach are untouched", async () => {
    // Quinn's deactivation (above) left the other club's covered session as it was.
    expect(await withRlsBypass((tx) => tx.sessionCover.findFirst({ where: { tenantId: ids.otherTenant, classInstanceId: ids.otherS } }))).toMatchObject({ status: "covered", coverUserId: ids.stranger });
    // And this club's owner cannot deactivate the other club's coach at all.
    const r = await deactivate(ids.stranger);
    expect(r.status).not.toBe(200);
    expect((await withRlsBypass((tx) => tx.user.findFirst({ where: { id: ids.stranger }, select: { deactivatedAt: true } })))?.deactivatedAt).toBeNull();
    expect(await withRlsBypass((tx) => tx.sessionCover.findFirst({ where: { tenantId: ids.otherTenant, classInstanceId: ids.otherS } }))).toMatchObject({ status: "covered", coverUserId: ids.stranger });
    expect((await audits("class.cover_given_up", { entityId: ids.otherS })).length).toBe(0);
    expect(await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: ids.otherTenant } }))).toBe(0);
  }, 120_000);

  it("nit 3: an end-time edit during a class keeps its confirmed coach; next week's session is flagged to reconfirm", async () => {
    const r = await patchClass(ids.allDay, { name: `Life All Day ${STAMP}`, schedules: [{ dayOfWeek: TODAY.getUTCDay(), startTime: "00:00", endTime: "23:45" }] });
    expect(r.status).toBe(200);
    for (const s of [ids.allDayToday, ids.allDayNext]) expect((await withRlsBypass((tx) => tx.classInstance.findFirst({ where: { id: s } })))?.endTime).toBe("23:45");
    expect(await coverRow(ids.allDayToday)).toMatchObject({ status: "covered", coverUserId: ids.vic, needsReconfirm: false });
    expect(await labels(ids.allDayToday)).toEqual({ staff: "Covered by Vic Cover", member: "Vic Cover" });
    expect((await audits("class.cover_reconfirm_flagged", { entityId: ids.allDayToday })).length).toBe(0);
    expect(await coverRow(ids.allDayNext)).toMatchObject({ status: "covered", coverUserId: ids.vic, needsReconfirm: true });
    expect((await audits("class.cover_reconfirm_flagged", { entityId: ids.allDayNext })).length).toBe(1);
  }, 180_000);

  it("should-fix 5: making a coach the regular coach of a class that overlaps a session they cover is refused by name", async () => {
    expect((await cover(ids.cchElse, owner(), { action: "assign", coachUserId: ids.vic })).status).toBe(200);
    const r = await patchClass(ids.cch, { coachUserId: ids.vic });
    expect(r).toMatchObject({ status: 409, body: { reason: "coach_cover_clash", instanceId: ids.cchS, conflict: { instanceId: ids.cchElse, className: "Life Vic Covers" } } });
    expect(String(r.body.error)).toMatch(/^Vic Cover is covering Life Vic Covers on \w+day \d+ \w+, 20:00–21:00, Mat 13, which overlaps this class on \w+day \d+ \w+, 19:00–20:30, Mat 12\. Choose another regular coach, or give up or replace that cover first\.$/);
    expect((await withRlsBypass((tx) => tx.class.findFirst({ where: { id: ids.cch }, select: { coachUserId: true } })))?.coachUserId).toBe(ids.kim);
    // Saving the class again with its coach unchanged is not refused (the form sends the coach on every save).
    expect((await patchClass(ids.cch, { coachUserId: ids.kim, name: "Life Coach Clash" })).status).toBe(200);
  }, 180_000);

  it("should-fix 5: back to back is not an overlap, and a session someone else covers is not one the new coach would teach", async () => {
    expect((await cover(ids.cb2bElse, owner(), { action: "assign", coachUserId: ids.vic })).status).toBe(200);
    expect((await patchClass(ids.cb2b, { coachUserId: ids.vic })).status).toBe(200);
    expect((await cover(ids.cownElse, owner(), { action: "assign", coachUserId: ids.vic })).status).toBe(200);
    expect((await cover(ids.cownS, owner(), { action: "assign", coachUserId: ids.sam })).status).toBe(200);
    expect((await patchClass(ids.cown, { coachUserId: ids.vic })).status).toBe(200);
    expect(await labels(ids.cownS)).toEqual({ staff: "Covered by Sam Cover", member: "Sam Cover" });
  }, 180_000);

  // ── Round 4 (review of 121529e4) ──────────────────────────────────────────────────────────────────────────────
  // One person shown on two overlapping sessions, one of them a cover, flagged at read time however it arose. Each
  // case asserts the staff payload on BOTH sessions and what members read.
  const TBC = "Coach to be confirmed";

  it("round 4, should-fix 2: a weekly-slot move with the same coach onto a session they cover is flagged on both", async () => {
    expect((await cover(ids.mvYS, owner(), { action: "assign", coachUserId: ids.cora })).status).toBe(200); // back to back: allowed
    expect((await patchClass(ids.mvX, { name: "R4 Move Own", schedules: [{ dayOfWeek: 4, startTime: "20:00", endTime: "21:00" }] })).status).toBe(200);
    const moved = await sessionOf(ids.mvX, NEXT_THU);
    expect(moved).not.toBe("");
    const staff = await staffDay(NEXT_THU);
    expect(staff(moved)).toEqual({ coach: TBC, clash: flag("Cora Move", "R4 Move Covered", NEXT_THU, "20:00–21:00", "Mat 22") });
    expect(staff(ids.mvYS)).toEqual({ coach: "Covered by Cora Move", clash: flag("Cora Move", "R4 Move Own", NEXT_THU, "20:00–21:00", "Mat 21") });
    const member = await memberDay(NEXT_THU);
    expect([member("R4 Move Own"), member("R4 Move Covered")]).toEqual([TBC, "Cora Move"]);
  }, 240_000);

  it("round 4, should-fix 2: an end-time extension into a session the coach covers is flagged on both", async () => {
    expect((await cover(ids.exYS, owner(), { action: "assign", coachUserId: ids.eli })).status).toBe(200); // back to back: allowed
    expect((await patchClass(ids.exX, { name: "R4 Extend Own", schedules: [{ dayOfWeek: 4, startTime: "17:00", endTime: "18:30" }] })).status).toBe(200);
    const staff = await staffDay(NEXT_THU);
    expect(staff(ids.exXS)).toEqual({ coach: TBC, clash: flag("Eli Extend", "R4 Extend Covered", NEXT_THU, "18:00–19:00", "Mat 24") });
    expect(staff(ids.exYS)).toEqual({ coach: "Covered by Eli Extend", clash: flag("Eli Extend", "R4 Extend Own", NEXT_THU, "17:00–18:30", "Mat 23") });
    const member = await memberDay(NEXT_THU);
    expect([member("R4 Extend Own"), member("R4 Extend Covered")]).toEqual([TBC, "Eli Extend"]);
  }, 240_000);

  it("round 4, should-fix 2: restoring a cancelled session that overlaps a claimed cover is flagged on both", async () => {
    const inst = (isCancelled: boolean) => { state.queue.push(owner()); return call(instancePATCH(new Request(`http://test/api/classes/${ids.rsX}/instances/${ids.rsXS}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isCancelled }) }), { params: Promise.resolve({ id: ids.rsX, instanceId: ids.rsXS }) })); };
    expect((await inst(true)).status).toBe(200);
    expect((await cover(ids.rsYS, owner(), { action: "request" })).status).toBe(200);
    expect((await cover(ids.rsYS, { userId: ids.rhea, role: "coach" }, { action: "claim" })).status).toBe(200); // her own session is cancelled
    expect((await inst(false)).status).toBe(200);
    const staff = await staffDay(R4(1));
    expect(staff(ids.rsXS)).toEqual({ coach: TBC, clash: flag("Rhea Restore", "R4 Restore Covered", R4(1), "19:00–20:30", "Mat 26") });
    expect(staff(ids.rsYS)).toEqual({ coach: "Covered by Rhea Restore", clash: flag("Rhea Restore", "R4 Restore Own", R4(1), "19:00–20:30", "Mat 25") });
    const member = await memberDay(R4(1));
    expect([member("R4 Restore Own"), member("R4 Restore Covered")]).toEqual([TBC, "Rhea Restore"]);
  }, 240_000);

  it("round 4, item 2 and should-fix 2: resume with a coach change checks the sessions the resume mints; a plain resume is flagged", async () => {
    expect((await cover(ids.reYS, owner(), { action: "assign", coachUserId: ids.remy })).status).toBe(200);
    // Paused beyond the window (no sessions), resumed and given Remy in one PATCH: the minted session would overlap.
    const r = await patchClass(ids.reX, { isActive: true, coachUserId: ids.remy });
    expect(r).toMatchObject({ status: 409, body: { reason: "coach_cover_clash", conflict: { instanceId: ids.reYS, className: "R4 Resume Covered" } } });
    expect(await withRlsBypass((tx) => tx.class.findFirst({ where: { id: ids.reX }, select: { isActive: true, coachUserId: true } }))).toEqual({ isActive: false, coachUserId: ids.kim });
    expect(await withRlsBypass((tx) => tx.classInstance.count({ where: { classId: ids.reX } }))).toBe(0);
    // A class Remy already heads, resumed: allowed (the class form allows it), and flagged where it is shown.
    expect((await patchClass(ids.reX2, { isActive: true })).status).toBe(200);
    const minted = await sessionOf(ids.reX2, NEXT_THU);
    expect(minted).not.toBe("");
    const staff = await staffDay(NEXT_THU);
    expect(staff(minted)).toEqual({ coach: TBC, clash: flag("Remy Resume", "R4 Resume Covered", NEXT_THU, "15:30–16:30", "Mat 29") });
    expect(staff(ids.reYS)).toEqual({ coach: "Covered by Remy Resume", clash: flag("Remy Resume", "R4 Resume Same Coach", NEXT_THU, "15:00–16:00", "Mat 28") });
    const member = await memberDay(NEXT_THU);
    expect([member("R4 Resume Same Coach"), member("R4 Resume Covered")]).toEqual([TBC, "Remy Resume"]);
  }, 240_000);

  it("round 4, should-fix 2: an undo that puts the regular coach back while they cover an overlapping session is flagged on both", async () => {
    expect((await patchClass(ids.unX, { coachUserId: ids.kim })).status).toBe(200);
    expect((await cover(ids.unYS, owner(), { action: "assign", coachUserId: ids.una })).status).toBe(200); // no longer Una's class
    const row = await withRlsBypass((tx) => tx.auditLog.findFirst({ where: { tenantId: state.tenantId, action: "class.updated", entityId: ids.unX }, orderBy: { createdAt: "desc" }, select: { id: true } }));
    state.queue.push(owner());
    const u = await call(undoPOST(new Request(`http://test/api/audit-log/${row!.id}/undo`, { method: "POST" }), { params: Promise.resolve({ id: row!.id }) }));
    expect(u.status).toBe(200);
    expect((await withRlsBypass((tx) => tx.class.findFirst({ where: { id: ids.unX }, select: { coachUserId: true } })))?.coachUserId).toBe(ids.una);
    const staff = await staffDay(R4(2));
    expect(staff(ids.unXS)).toEqual({ coach: TBC, clash: flag("Una Undo", "R4 Undo Covered", R4(2), "19:00–20:30", "Mat 31") });
    expect(staff(ids.unYS)).toEqual({ coach: "Covered by Una Undo", clash: flag("Una Undo", "R4 Undo Own", R4(2), "19:00–20:30", "Mat 30") });
    const member = await memberDay(R4(2));
    expect([member("R4 Undo Own"), member("R4 Undo Covered")]).toEqual([TBC, "Una Undo"]);
  }, 240_000);

  it("round 4, should-fix 2: a new class whose coach covers an overlapping session is flagged on both", async () => {
    expect((await cover(ids.crYS, owner(), { action: "assign", coachUserId: ids.cal })).status).toBe(200);
    const created = await asOwner(() => call(classPOST(new Request("http://test/api/classes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "R4 Created Class", location: "Mat 33", duration: 60, coachUserId: ids.cal, schedules: [{ dayOfWeek: 4, startTime: "12:30", endTime: "13:30" }] }) }))));
    expect(created.status).toBe(201);
    const s = await sessionOf(String((created.body as Json).id), NEXT_THU);
    expect(s).not.toBe("");
    const staff = await staffDay(NEXT_THU);
    expect(staff(s)).toEqual({ coach: TBC, clash: flag("Cal Create", "R4 Create Covered", NEXT_THU, "12:00–13:00", "Mat 32") });
    expect(staff(ids.crYS)).toEqual({ coach: "Covered by Cal Create", clash: flag("Cal Create", "R4 Created Class", NEXT_THU, "12:30–13:30", "Mat 33") });
    const member = await memberDay(NEXT_THU);
    expect([member("R4 Created Class"), member("R4 Create Covered")]).toEqual([TBC, "Cal Create"]);
  }, 240_000);

  it("round 4: back to back is not flagged, nor two classes of the same regular coach at once", async () => {
    expect((await cover(ids.bbYS, owner(), { action: "assign", coachUserId: ids.bea })).status).toBe(200);
    const b2b = await staffDay(R4(3));
    expect(b2b(ids.bbXS)).toEqual({ coach: "Bea Back", clash: null });
    expect(b2b(ids.bbYS)).toEqual({ coach: "Covered by Bea Back", clash: null });
    const b2bMember = await memberDay(R4(3));
    expect([b2bMember("R4 B2B Own"), b2bMember("R4 B2B Covered")]).toEqual(["Bea Back", "Bea Back"]);
    const twice = await staffDay(R4(4));
    expect(twice(ids.rrAS)).toEqual({ coach: "Reg Twice", clash: null });
    expect(twice(ids.rrBS)).toEqual({ coach: "Reg Twice", clash: null });
    const member = await memberDay(R4(4));
    expect([member("R4 Twice A"), member("R4 Twice B")]).toEqual(["Reg Twice", "Reg Twice"]);
  }, 240_000);

  it("round 4: another club at the same times is untouched, and its rows never reach this club's flags", async () => {
    const ours = await staffDay(R4(7));
    expect(ours(ids.ocXS)).toEqual({ coach: TBC, clash: flag("Otto Clubs", "R4 Otto Covered", R4(7), "19:00–20:30", "Mat 43") });
    expect(ours(ids.ocYS)).toEqual({ coach: "Covered by Otto Clubs", clash: flag("Otto Clubs", "R4 Otto Own", R4(7), "19:00–20:30", "Mat 42") });
    const home = state.tenantId;
    state.tenantId = ids.otherTenant;
    try {
      const theirs = await staffDay(R4(7), { userId: ids.otherOwner, role: "owner" });
      expect(theirs(ids.ocOtherS)).toEqual({ coach: "Stranger Coach", clash: null });
      expect(theirs(ids.ocTrapS).clash).toBeNull();
    } finally {
      state.tenantId = home;
    }
  }, 240_000);

  it("round 4, nit 1: Withdraw and Return of an open request are allowed when the regular coach only heads a simultaneous class, refused when they cover one", async () => {
    // Wes heads both Kids and Adults at 19:00 (the class form allows it).
    for (const action of ["withdraw", "return"]) {
      expect((await cover(ids.wdAS, owner(), { action: "request" })).status, `request before ${action}`).toBe(200);
      expect((await cover(ids.wdAS, owner(), { action })).status, action).toBe(200);
      expect(await coverRow(ids.wdAS)).toMatchObject({ status: action === "withdraw" ? "withdrawn" : "closed", coverUserId: null });
    }
    // Wyn's open request while Wyn covers the simultaneous session: still refused, by name, and flagged on both.
    for (const action of ["withdraw", "return"]) {
      const r = await cover(ids.wrXS, owner(), { action });
      expect(r, action).toMatchObject({ status: 409, body: { code: "REGULAR_COACH_BUSY", conflict: { instanceId: ids.wrYS, className: "R4 Refuse Covered" } } });
    }
    expect(await coverRow(ids.wrXS)).toMatchObject({ status: "open", coverUserId: null });
    const staff = await staffDay(R4(6));
    expect(staff(ids.wrXS)).toEqual({ coach: "Cover needed · Wyn Covering away", clash: flag("Wyn Covering", "R4 Refuse Covered", R4(6), "19:00–20:30", "Mat 41") });
    expect(staff(ids.wrYS)).toEqual({ coach: "Covered by Wyn Covering", clash: flag("Wyn Covering", "R4 Refuse Own", R4(6), "19:00–20:30", "Mat 40") });
  }, 240_000);

  // Last: it moves the clock past the session's start.
  it("round 4, should-fix 1: a request reopened by a deactivation never shows its regular coach once the session starts", async () => {
    expect((await cover(ids.sf1OwnS, owner(), { action: "assign", coachUserId: ids.pia })).status).toBe(200);
    // Pia covers Ada's Mat 1, so Ada is free to cover Mat 2 at the same time.
    expect((await cover(ids.sf1ElseS, owner(), { action: "request" })).status).toBe(200);
    expect((await cover(ids.sf1ElseS, { userId: ids.ada, role: "coach" }, { action: "claim" })).status).toBe(200);
    expect((await deactivate(ids.pia)).status).toBe(200);
    expect(await coverRow(ids.sf1OwnS)).toMatchObject({ status: "open", coverUserId: null });
    const mat1 = flag("Ada Regular", "R4 Ada Mat 2", R4(0), "19:00–20:30", "Mat 2");
    const mat2 = flag("Ada Regular", "R4 Ada Mat 1", R4(0), "19:00–20:30", "Mat 1");
    // Before the start: Cover needed, flagged.
    const before = await staffDay(R4(0));
    expect(before(ids.sf1OwnS)).toEqual({ coach: "Cover needed · Ada Regular away", clash: mat1 });
    expect(before(ids.sf1ElseS)).toEqual({ coach: "Covered by Ada Regular", clash: mat2 });
    // Nobody acts. At 19:10 on that Thursday (GMT) both sessions are under way.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${ymd(R4(0))}T19:10:00Z`));
    try {
      const during = await staffDay(R4(0));
      expect(during(ids.sf1OwnS)).toEqual({ coach: TBC, clash: mat1 });
      expect(during(ids.sf1ElseS)).toEqual({ coach: "Covered by Ada Regular", clash: mat2 });
      const member = await memberDay(R4(0));
      expect([member("R4 Ada Mat 1"), member("R4 Ada Mat 2")]).toEqual([TBC, "Ada Regular"]);
      // Ada's own list (Mark attendance): both are still hers, each with the flag.
      state.queue.push({ userId: ids.ada, role: "coach" });
      const today = await call(coachToday());
      expect(today.status).toBe(200);
      const row = (id: string) => (today.body as Json[]).find((s) => s.id === id);
      expect(row(ids.sf1OwnS)).toMatchObject({ isMine: true, coachName: `${TBC} · ${mat1}` });
      expect(row(ids.sf1ElseS)).toMatchObject({ isMine: true, coachName: `Covered by Ada Regular · ${mat2}` });
    } finally {
      vi.useRealTimers();
    }
  }, 300_000);
});
