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
  return { requireApiStaff: vi.fn(next), requireApiOwnerOrManager: vi.fn(next) };
});

import { loadCovers, sessionHasStarted } from "@/lib/session-cover";
import { memberCoachLabel, resolveSessionTeacher, staffCoachLabel } from "@/lib/session-coach";
import { POST as coverRoute } from "@/app/api/coach/instances/[id]/cover/route";
import { PATCH as classPATCH, DELETE as classDELETE } from "@/app/api/classes/[id]/route";
import { DELETE as staffDELETE } from "@/app/api/staff/[id]/route";
import { GET as memberSchedule } from "@/app/api/member/schedule/route";
import { GET as memberHome } from "@/app/api/member/home/route";
import { GET as memberChildren } from "@/app/api/member/me/children/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const thu = (n: number) => new Date(Date.UTC(2033, 2, 3 + 7 * n)); // Thursdays from 3 March 2033
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
    }, { timeout: 150_000 }); // ~100 inserts: past the default 15 s budget at the test branch's latency from Bali
  }, 240_000);

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
});
