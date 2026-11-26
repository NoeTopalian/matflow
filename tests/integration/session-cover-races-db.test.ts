// Session cover (PR #134, round 2): competing actions with the bad interleaving FORCED, on real Postgres.
//
// Each case parks one side inside an open transaction right after it has made its change (the real library
// function, holding whatever locks it took), starts the other side through the real route handler, waits until
// that request is seen blocked on a lock in pg_stat_activity (like tests/integration/lock-order-contention-db.test.ts),
// then lets the parked side commit. Whatever the build does, the end state must be one of the two serial orders:
//
//  A. claim parked, then cancel        -> the cancel closes the cover; Activity: claimed 1, closed 1
//  B. cancel parked, then claim        -> "This session is cancelled"; nothing claimed
//  C. cancel parked, then assign       -> "This session is cancelled"; no cover row is created
//  D. assign parked (new row), cancel  -> the cancel closes the new row; restoring does not bring it back
//  E. request parked, then request     -> "Cover has already been requested" (409), never a save error
//  F. request parked, then assign      -> the assignment fills the request (one row, covered)
//  G. claim parked, then slot edit     -> the edit carries the covered row to the new time, flagged to reconfirm
//  H. slot edit parked, then claim     -> "This session is no longer on the timetable"; the request moved, unclaimed
//  I. two coaches, one session         -> one covers; the other is told who
//  J. one coach, two overlapping       -> one covered; the other refused, naming the first
//
// Before this file the build failed A, C, D (an active cover on a cancelled session, and a false Activity row in A),
// E and F (500), G (500 from the RESTRICT key) and H (claimed at the new time with no overlap check); B, I and J are
// shown to fail by mutation (round-2 report). Synthetic data; skips without DATABASE_URL.
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: state.ownerId, role: "owner", tenantId: state.tenantId } })) }));
const state = vi.hoisted(() => ({ tenantId: "", ownerId: "", queue: [] as Array<{ userId: string; role: string }> }));
vi.mock("@/lib/api-authz", () => {
  const next = async () => {
    const who = state.queue.shift();
    if (!who) throw new Error("no identity queued for this request");
    return { ok: true, tenantId: state.tenantId, userId: who.userId, role: who.role, session: { user: { id: who.userId, role: who.role, tenantId: state.tenantId } } };
  };
  return { requireApiStaff: vi.fn(next), requireApiOwnerOrManager: vi.fn(next) };
});

import {
  applyCoverAction, closeCoverOnCancel, closeCoversForClass, lockCoachCover, moveCoversBeforeDelete, regularCoachCoverClash, reopenCoversOfDeactivatedCoach, slotMovesOf, type CoverInput,
} from "@/lib/session-cover";
import { POST as coverRoute } from "@/app/api/coach/instances/[id]/cover/route";
import { PATCH as sessionRoute } from "@/app/api/classes/[id]/instances/[instanceId]/route";
import { PATCH as classRoute, DELETE as classDeleteRoute } from "@/app/api/classes/[id]/route";
import { DELETE as staffDeleteRoute } from "@/app/api/staff/[id]/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const thu = (n: number) => new Date(Date.UTC(2033, 0, 6 + 7 * n)); // Thursdays from 6 January 2033: nothing here has started
const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const NEXT_THU = (() => { const d = new Date(`${todayKey}T00:00:00Z`); const dow = d.getUTCDay(); d.setUTCDate(d.getUTCDate() + (((4 - dow + 7) % 7) || 7)); return d; })();

type Who = { userId: string; role: string };
type Body = { error?: string; code?: string; cover?: { status: string; coverUserId: string | null; coverUserName: string | null } | null; scheduleChange?: { coverMoved?: number } };

async function cover(instanceId: string, who: Who, body: Record<string, unknown>) {
  state.queue.push(who);
  const res = (await coverRoute(
    new Request(`http://test/api/coach/instances/${instanceId}/cover`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: instanceId }) },
  )) as unknown as { status: number; json: () => Promise<Body> };
  return { status: res.status, body: await res.json() };
}

async function cancelRoute(classId: string, instanceId: string, isCancelled: boolean, who: Who) {
  state.queue.push(who);
  const res = (await sessionRoute(
    new Request(`http://test/api/classes/${classId}/instances/${instanceId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isCancelled }) }),
    { params: Promise.resolve({ id: classId, instanceId }) },
  )) as unknown as { status: number; json: () => Promise<Body> };
  return { status: res.status, body: await res.json() };
}

async function slotEdit(classId: string, name: string, schedules: Array<{ dayOfWeek: number; startTime: string; endTime: string }>) {
  const res = (await classRoute(
    new Request(`http://test/api/classes/${classId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, schedules }) }),
    { params: Promise.resolve({ id: classId }) },
  )) as unknown as { status: number; json: () => Promise<Body> };
  return { status: res.status, body: await res.json() };
}

async function patchClass(classId: string, body: Record<string, unknown>) {
  const res = (await classRoute(
    new Request(`http://test/api/classes/${classId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: classId }) },
  )) as unknown as { status: number; json: () => Promise<Body & { reason?: string; conflict?: { instanceId: string; className: string; label: string } }> };
  return { status: res.status, body: await res.json() };
}

async function archiveClass(classId: string) {
  const res = (await classDeleteRoute(new Request(`http://test/api/classes/${classId}`, { method: "DELETE" }), { params: Promise.resolve({ id: classId }) })) as unknown as { status: number; json: () => Promise<Body> };
  return { status: res.status, body: await res.json() };
}

async function deactivateStaff(userId: string) {
  const res = (await staffDeleteRoute(new Request(`http://test/api/staff/${userId}`, { method: "DELETE" }), { params: Promise.resolve({ id: userId }) })) as unknown as { status: number; json: () => Promise<Body> };
  return { status: res.status, body: await res.json() };
}

/** Runs `work` in a tenant transaction and holds it open (locks and uncommitted writes included) until released. */
function park<T>(work: (tx: Parameters<Parameters<typeof withTenantContext>[1]>[0]) => Promise<T>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ready!: (v: T) => void;
  let failed!: (e: unknown) => void;
  const parked = new Promise<T>((res, rej) => { ready = res; failed = rej; });
  const done = withTenantContext(state.tenantId, async (tx) => {
    const r = await work(tx);
    ready(r);
    await gate;
    return r;
  }, { timeout: 60_000 }).catch((e) => { failed(e); throw e; });
  return { parked, done, release };
}

/**
 * "<lock type>: <query>" of a backend now waiting on a lock in this database, or null if none appears in time. The other side's
 * lock_timeout is 10 s, so this gives up well before it; a build that never blocks simply runs on.
 */
async function blockedQuery(timeoutMs = 7_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ q: string; t: string }[]>`
      SELECT a.query AS q, l.locktype AS t FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
       WHERE a.wait_event_type = 'Lock' AND a.datname = current_database() AND a.pid <> pg_backend_pid() AND a.query NOT LIKE '%pg_stat_activity%'
       LIMIT 1`;
    if (rows[0]) return `${rows[0].t}: ${rows[0].q.replace(/\s+/g, " ").slice(0, 400)}`;
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
}

/** Park `first`, start `second`, wait for it to block, release, and return both results plus what it blocked on. */
async function interleave<A, B>(first: (tx: Parameters<Parameters<typeof withTenantContext>[1]>[0]) => Promise<A>, second: () => Promise<B>) {
  const p = park(first);
  const a = await p.parked;
  const b = second();
  const blockedOn = await blockedQuery();
  console.log(`[interleave] the second side ${blockedOn ? `waited on ${blockedOn}` : "never waited on a lock"}`);
  p.release();
  const [, bResult] = await Promise.all([p.done, b]);
  return { a, b: bResult, blockedOn };
}

describe.skipIf(!HAS_DB)("session cover — forced interleavings on a real database", () => {
  const ids: Record<string, string> = {};
  const owner = (): Who => ({ userId: ids.owner, role: "owner" });
  const coach = (k: string): Who => ({ userId: ids[k], role: "coach" });
  const actor = (w: Who) => ({ tenantId: state.tenantId, userId: w.userId, role: w.role });
  const act = (w: Who, instanceId: string, input: CoverInput) => (tx: Parameters<Parameters<typeof withTenantContext>[1]>[0]) => applyCoverAction(tx, actor(w), instanceId, input);
  const coverRow = (instanceId: string) => withRlsBypass((tx) => tx.sessionCover.findFirst({ where: { tenantId: state.tenantId, classInstanceId: instanceId } }));
  const audits = (action: string, instanceId: string) => withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: state.tenantId, action, entityId: instanceId } }));
  /** The cancel route's own write, parked: the session flips to cancelled and its cover closes, uncommitted. */
  const parkedCancel = (classId: string, instanceId: string, date: Date) => async (tx: Parameters<Parameters<typeof withTenantContext>[1]>[0]) => {
    await tx.classInstance.updateMany({ where: { id: instanceId, classId, class: { tenantId: state.tenantId } }, data: { isCancelled: true } });
    return closeCoverOnCancel(tx, state.tenantId, ids.owner, { id: instanceId, classId, date, startTime: "19:00", endTime: "20:30" });
  };

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      state.tenantId = (await tx.tenant.create({ data: { name: `Cover races ${STAMP}`, slug: `cover-races-${STAMP}`, timezone: "Europe/London" } })).id;
      const user = async (key: string, name: string, role: string) =>
        (ids[key] = (await tx.user.create({ data: { tenantId: state.tenantId, email: `cover-races-${key}-${STAMP}@example.test`, name, role, passwordHash: "x" } })).id);
      await user("owner", "Olive Owner", "owner");
      state.ownerId = ids.owner;
      await user("alex", "Alex Regular", "coach");
      await user("sam", "Sam Cover", "coach");
      await user("lee", "Lee Cover", "coach");
      await user("pat", "Pat Spare", "coach");
      ids.gi = (await tx.class.create({ data: { tenantId: state.tenantId, name: "Race Gi", location: "Mat 2", coachUserId: ids.alex, duration: 90 } })).id;
      for (const [k, n] of [["a", 0], ["b", 1], ["c", 2], ["d", 3], ["e", 4], ["f", 5], ["i", 6]] as const) {
        ids[k] = (await tx.classInstance.create({ data: { classId: ids.gi, date: thu(n), startTime: "19:00", endTime: "20:30" } })).id;
      }
      const uncoached = async (name: string, location: string) => (await tx.class.create({ data: { tenantId: state.tenantId, name, location, duration: 90 } })).id;
      ids.overA = (await tx.classInstance.create({ data: { classId: await uncoached("Over A", "Mat 5"), date: thu(7), startTime: "19:00", endTime: "20:30" } })).id;
      ids.overB = (await tx.classInstance.create({ data: { classId: await uncoached("Over B", "Mat 6"), date: thu(7), startTime: "19:30", endTime: "21:00" } })).id;
      // Weekly classes on Thursday 07:00 for the slot-edit cases; their next Thursday is inside the rolling window.
      const weekly = async (name: string) =>
        (await tx.class.create({ data: { tenantId: state.tenantId, name, location: "Mat 7", duration: 60, schedules: { create: [{ dayOfWeek: 4, startTime: "07:00", endTime: "08:00" }] } } })).id;
      ids.editG = await weekly("Edit G");
      ids.g = (await tx.classInstance.create({ data: { classId: ids.editG, date: NEXT_THU, startTime: "07:00", endTime: "08:00" } })).id;
      ids.editH = await weekly("Edit H");
      ids.h = (await tx.classInstance.create({ data: { classId: ids.editH, date: NEXT_THU, startTime: "07:00", endTime: "08:00" } })).id;
      ids.hNew = (await tx.classInstance.create({ data: { classId: ids.editH, date: NEXT_THU, startTime: "07:30", endTime: "08:30" } })).id;

      // Round 3 (review of 7d7b17df). Coaches of their own, so no earlier case's cover makes them busy.
      for (const [k, n] of [["gus", "Gus Assign"], ["cara", "Cara Claim"], ["dan", "Dan Claim"], ["eve", "Eve Leaving"], ["fay", "Fay Leaving"], ["rex", "Rex Reconfirm"]] as const) await user(k, n, "coach");
      // Archive and pause against Request and Assign: one class per case, each with two upcoming sessions (the case
      // acts on the SECOND, which has no cover row before the race: the session the round-2 archive never locked).
      const twoSessions = async (key: string, name: string, n: number) => {
        ids[key] = (await tx.class.create({ data: { tenantId: state.tenantId, name, location: "Mat 3", coachUserId: ids.alex, duration: 90 } })).id;
        ids[`${key}1`] = (await tx.classInstance.create({ data: { classId: ids[key], date: thu(n), startTime: "19:00", endTime: "20:30" } })).id;
        ids[`${key}2`] = (await tx.classInstance.create({ data: { classId: ids[key], date: thu(n + 1), startTime: "19:00", endTime: "20:30" } })).id;
      };
      await twoSessions("arcReqP", "Arc Req parked", 10);
      await twoSessions("arcReqA", "Arc Req archive parked", 12);
      await twoSessions("arcAsgP", "Arc Asg parked", 14);
      await twoSessions("arcAsgA", "Arc Asg archive parked", 16);
      await twoSessions("pauReqP", "Pau Req parked", 18);
      await twoSessions("pauReqA", "Pau Req pause parked", 20);
      await twoSessions("pauAsgP", "Pau Asg parked", 22);
      await twoSessions("pauAsgA", "Pau Asg pause parked", 24);
      // Coach change against a claim: the class whose regular coach changes, and an overlapping session elsewhere
      // with an open request that the new coach claims.
      const pair = async (key: string, n: number) => {
        ids[key] = (await tx.class.create({ data: { tenantId: state.tenantId, name: `Coach change ${key}`, location: "Mat 4", coachUserId: ids.alex, duration: 90 } })).id;
        ids[`${key}S`] = (await tx.classInstance.create({ data: { classId: ids[key], date: thu(n), startTime: "19:00", endTime: "20:30" } })).id;
        ids[`${key}X`] = (await tx.classInstance.create({ data: { classId: await uncoached(`Elsewhere ${key}`, "Mat 8"), date: thu(n), startTime: "19:30", endTime: "21:00" } })).id;
      };
      await pair("ccA", 26);
      await pair("ccB", 27);
      // Deactivation against a claim.
      ids.de1 = (await tx.classInstance.create({ data: { classId: await uncoached("Deact one", "Mat 9"), date: thu(28), startTime: "19:00", endTime: "20:30" } })).id;
      ids.de2 = (await tx.classInstance.create({ data: { classId: await uncoached("Deact two", "Mat 9"), date: thu(29), startTime: "19:00", endTime: "20:30" } })).id;
      // Reconfirm against a weekly-slot edit: Thursday 07:00 classes whose next session Rex covers, awaiting reconfirmation.
      ids.editR = await weekly("Edit R");
      ids.r = (await tx.classInstance.create({ data: { classId: ids.editR, date: NEXT_THU, startTime: "07:00", endTime: "08:00" } })).id;
      ids.editR2 = await weekly("Edit R2");
      ids.r2 = (await tx.classInstance.create({ data: { classId: ids.editR2, date: NEXT_THU, startTime: "09:00", endTime: "10:00" } })).id;
      await tx.classSchedule.updateMany({ where: { classId: ids.editR2 }, data: { startTime: "09:00", endTime: "10:00" } });
      ids.r2New = (await tx.classInstance.create({ data: { classId: ids.editR2, date: NEXT_THU, startTime: "09:30", endTime: "10:30" } })).id;
      for (const s of [ids.r, ids.r2]) {
        await tx.sessionCover.create({ data: { tenantId: state.tenantId, classInstanceId: s, status: "covered", coverUserId: ids.rex, requestedById: ids.owner, needsReconfirm: true } });
      }
      // Nit 1: a weekly-slot edit carrying a cover to a replacement session that already exists, while that session
      // is being asked for cover.
      ids.editN = await weekly("Edit N");
      ids.n = (await tx.classInstance.create({ data: { classId: ids.editN, date: NEXT_THU, startTime: "07:00", endTime: "08:00" } })).id;
      ids.nTo = (await tx.classInstance.create({ data: { classId: ids.editN, date: NEXT_THU, startTime: "07:30", endTime: "08:30" } })).id;
    });
  }, 180_000);

  afterAll(async () => {
    if (!state.tenantId) return;
    const tenantId = state.tenantId;
    await new Promise((r) => setTimeout(r, 1_500)); // the session route's best-effort audit rows still landing
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.sessionCover.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.classSchedule.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  }, 120_000);

  it("A. a claim parked, then a cancel: the cancel waits, then closes the cover; restoring does not bring it back", async () => {
    expect((await cover(ids.a, owner(), { action: "request" })).status).toBe(200);
    const r = await interleave(act(coach("sam"), ids.a, { action: "claim" }), () => cancelRoute(ids.gi, ids.a, true, owner()));
    expect(r.a).toMatchObject({ ok: true });
    expect(r.b.status).toBe(200);
    expect(await coverRow(ids.a)).toMatchObject({ status: "closed", closedReason: "session_cancelled", coverUserId: null });
    expect(await audits("class.cover_claimed", ids.a)).toBe(1);
    expect(await audits("class.cover_closed", ids.a)).toBe(1);
    expect((await cancelRoute(ids.gi, ids.a, false, owner())).status).toBe(200);
    expect(await coverRow(ids.a)).toMatchObject({ status: "closed", coverUserId: null });
    expect(r.blockedOn).toMatch(/"ClassInstance"/);
  }, 120_000);

  it("B. a cancel parked, then a claim: the claim waits, then is told the session is cancelled", async () => {
    expect((await cover(ids.b, owner(), { action: "request" })).status).toBe(200);
    const r = await interleave(parkedCancel(ids.gi, ids.b, thu(1)), () => cover(ids.b, coach("sam"), { action: "claim" }));
    expect(r.a).toBe(true);
    expect(r.b).toMatchObject({ status: 409, body: { code: "SESSION_CANCELLED", error: "This session is cancelled, so its cover cannot change." } });
    expect(await coverRow(ids.b)).toMatchObject({ status: "closed", closedReason: "session_cancelled", coverUserId: null });
    expect(await audits("class.cover_claimed", ids.b)).toBe(0);
    expect(r.blockedOn).toMatch(/FOR NO KEY UPDATE OF ci/);
  }, 120_000);

  it("C. a cancel parked (no cover yet), then an assign: no cover is created on the cancelled session", async () => {
    const r = await interleave(parkedCancel(ids.gi, ids.c, thu(2)), () => cover(ids.c, owner(), { action: "assign", coachUserId: ids.sam }));
    expect(r.a).toBe(false);
    expect(r.b).toMatchObject({ status: 409, body: { code: "SESSION_CANCELLED" } });
    expect(await coverRow(ids.c)).toBeNull();
    expect(await audits("class.cover_assigned", ids.c)).toBe(0);
    expect(await audits("class.cover_closed", ids.c)).toBe(0);
    expect(r.blockedOn).toMatch(/FOR NO KEY UPDATE OF ci/);
  }, 120_000);

  it("D. an assign parked (a new row), then a cancel: the cancel closes it; restoring does not recommit the coach", async () => {
    const r = await interleave(act(owner(), ids.d, { action: "assign", coachUserId: ids.lee }), () => cancelRoute(ids.gi, ids.d, true, owner()));
    expect(r.a).toMatchObject({ ok: true });
    expect(r.b.status).toBe(200);
    expect(await coverRow(ids.d)).toMatchObject({ status: "closed", closedReason: "session_cancelled", coverUserId: null });
    expect(await audits("class.cover_assigned", ids.d)).toBe(1);
    expect(await audits("class.cover_closed", ids.d)).toBe(1);
    expect((await cancelRoute(ids.gi, ids.d, false, owner())).status).toBe(200);
    expect(await coverRow(ids.d)).toMatchObject({ status: "closed", coverUserId: null });
    expect(r.blockedOn).toMatch(/"ClassInstance"/);
  }, 120_000);

  it("E. a request parked, then another request: the second is told cover is already requested, never a save error", async () => {
    const r = await interleave(act(owner(), ids.e, { action: "request" }), () => cover(ids.e, coach("alex"), { action: "request" }));
    expect(r.a).toMatchObject({ ok: true });
    expect(r.b).toMatchObject({ status: 409, body: { code: "ALREADY_REQUESTED", error: "Cover has already been requested for this session." } });
    expect(await coverRow(ids.e)).toMatchObject({ status: "open" });
    expect(await audits("class.cover_requested", ids.e)).toBe(1);
    expect(r.blockedOn).toMatch(/FOR NO KEY UPDATE OF ci/);
  }, 120_000);

  it("F. a request parked, then an assign: the assignment fills the request", async () => {
    const r = await interleave(act(owner(), ids.f, { action: "request" }), () => cover(ids.f, owner(), { action: "assign", coachUserId: ids.sam }));
    expect(r.a).toMatchObject({ ok: true });
    expect(r.b).toMatchObject({ status: 200, body: { cover: { status: "covered", coverUserId: ids.sam } } });
    expect(await withRlsBypass((tx) => tx.sessionCover.count({ where: { tenantId: state.tenantId, classInstanceId: ids.f } }))).toBe(1);
    expect(await audits("class.cover_requested", ids.f)).toBe(1);
    expect(await audits("class.cover_assigned", ids.f)).toBe(1);
    expect(r.blockedOn).toMatch(/FOR NO KEY UPDATE OF ci/);
  }, 120_000);

  it("G. a claim parked, then a weekly-slot edit: the edit waits, then carries the covered row to the new time to reconfirm", async () => {
    expect((await cover(ids.g, owner(), { action: "request" })).status).toBe(200);
    const r = await interleave(act(coach("pat"), ids.g, { action: "claim" }), () => slotEdit(ids.editG, "Edit G", [{ dayOfWeek: 4, startTime: "07:30", endTime: "08:30" }]));
    expect(r.a).toMatchObject({ ok: true });
    expect(r.b.status).toBe(200);
    expect(r.b.body.scheduleChange?.coverMoved).toBe(1);
    const row = await withRlsBypass((tx) => tx.sessionCover.findFirst({ where: { tenantId: state.tenantId, coverUserId: ids.pat, classInstance: { classId: ids.editG } }, include: { classInstance: true } }));
    expect(row).toMatchObject({ status: "covered", needsReconfirm: true });
    expect(row?.classInstance).toMatchObject({ startTime: "07:30", date: NEXT_THU });
    expect(await audits("class.cover_reconfirm_flagged", row!.classInstanceId!)).toBe(1);
    // Round 3: the edit now waits on its class-wide session lock (FOR NO KEY UPDATE, id order) before the delete lock.
    expect(r.blockedOn).toMatch(/ORDER BY ci\.id FOR (NO KEY )?UPDATE OF ci/);
  }, 180_000);

  it("H. a weekly-slot edit parked, then a claim on the old session: refused as gone; the request moved and is still open", async () => {
    expect((await cover(ids.h, owner(), { action: "request" })).status).toBe(200);
    const moves = slotMovesOf([{ dayOfWeek: 4, startTime: "07:00" }], [{ dayOfWeek: 4, startTime: "07:30" }]);
    const r = await interleave(
      async (tx) => {
        const report = await moveCoversBeforeDelete(tx, state.tenantId, ids.owner, ids.editH, [ids.h], moves, "Europe/London");
        await tx.classInstance.deleteMany({ where: { id: ids.h } });
        return report;
      },
      () => cover(ids.h, coach("pat"), { action: "claim" }),
    );
    expect(r.a).toMatchObject({ moved: 1 });
    expect(r.b).toMatchObject({ status: 409, body: { code: "SESSION_GONE" } });
    expect(await coverRow(ids.hNew)).toMatchObject({ status: "open", coverUserId: null, needsReconfirm: false });
    expect(await audits("class.cover_claimed", ids.hNew)).toBe(0);
    expect(r.blockedOn).toMatch(/FOR NO KEY UPDATE OF ci/);
  }, 120_000);

  it("I. two coaches claim one session: the second waits, then is told who has it", async () => {
    expect((await cover(ids.i, owner(), { action: "request" })).status).toBe(200);
    const r = await interleave(act(coach("sam"), ids.i, { action: "claim" }), () => cover(ids.i, coach("lee"), { action: "claim" }));
    expect(r.a).toMatchObject({ ok: true });
    expect(r.b).toMatchObject({ status: 409, body: { code: "ALREADY_COVERED", error: "Already covered by Sam Cover." } });
    expect(await coverRow(ids.i)).toMatchObject({ status: "covered", coverUserId: ids.sam });
    expect(await audits("class.cover_claimed", ids.i)).toBe(1);
    expect(r.blockedOn).toMatch(/FOR NO KEY UPDATE OF ci/);
  }, 120_000);

  it("J. one coach claims two overlapping sessions: the second waits on the coach's lock, then is refused by name", async () => {
    expect((await cover(ids.overA, owner(), { action: "request" })).status).toBe(200);
    expect((await cover(ids.overB, owner(), { action: "request" })).status).toBe(200);
    const r = await interleave(act(coach("pat"), ids.overA, { action: "claim" }), () => cover(ids.overB, coach("pat"), { action: "claim" }));
    expect(r.a).toMatchObject({ ok: true });
    expect(r.b).toMatchObject({ status: 409, body: { code: "OVERLAP" } });
    expect(r.b.body.error).toContain("already teaching Over A");
    expect(await withRlsBypass((tx) => tx.sessionCover.count({ where: { tenantId: state.tenantId, coverUserId: ids.pat, status: "covered", classInstanceId: { in: [ids.overA, ids.overB] } } }))).toBe(1);
    expect(r.blockedOn).toMatch(/^advisory: /);
  }, 120_000);

  // ── Round 3 (review of 7d7b17df) ────────────────────────────────────────────────────────────────────────────────
  const activeRows = (classId: string) => withRlsBypass((tx) => tx.sessionCover.count({ where: { tenantId: state.tenantId, status: { in: ["open", "covered"] }, classInstance: { classId } } }));
  /** The archive route's own transaction, parked: the class archived and its upcoming covers closed, uncommitted. */
  const parkedArchive = (classId: string) => async (tx: Parameters<Parameters<typeof withTenantContext>[1]>[0]) => {
    await tx.class.updateMany({ where: { id: classId, tenantId: state.tenantId, deletedAt: null }, data: { isActive: false, deletedAt: new Date() } });
    return closeCoversForClass(tx, state.tenantId, ids.owner, classId, "class_archived", "Europe/London");
  };
  /** The class PATCH's pause, parked: Class row locked, paused, its upcoming covers closed, uncommitted. */
  const parkedPause = (classId: string) => async (tx: Parameters<Parameters<typeof withTenantContext>[1]>[0]) => {
    await tx.$queryRaw`SELECT "id" FROM "Class" WHERE "id" = ${classId} AND "tenantId" = ${state.tenantId} FOR UPDATE`;
    await tx.class.updateMany({ where: { id: classId, tenantId: state.tenantId }, data: { isActive: false } });
    return closeCoversForClass(tx, state.tenantId, ids.owner, classId, "class_paused", "Europe/London");
  };
  /** After the race: bring the class back and prove no cover came back with it. */
  const restoredWithNoCover = async (classId: string) => {
    expect((await patchClass(classId, { isActive: true })).status).toBe(200);
    expect(await activeRows(classId)).toBe(0);
  };

  it("K1. a Request parked on a session with no cover, then an archive: the archive waits, then closes it; restoring brings none back", async () => {
    const r = await interleave(act(owner(), ids.arcReqP2, { action: "request" }), () => archiveClass(ids.arcReqP));
    expect(r.a).toMatchObject({ ok: true });
    expect(r.b.status).toBe(200);
    expect(await coverRow(ids.arcReqP2)).toMatchObject({ status: "closed", closedReason: "class_archived" });
    expect(await audits("class.cover_closed", ids.arcReqP2)).toBe(1);
    expect(r.blockedOn).toMatch(/ORDER BY ci\.id FOR NO KEY UPDATE OF ci/);
    await restoredWithNoCover(ids.arcReqP);
  }, 180_000);

  it("K2. an archive parked, then a Request on a session with no cover: the request waits, then is refused; no row", async () => {
    const r = await interleave(parkedArchive(ids.arcReqA), () => cover(ids.arcReqA2, owner(), { action: "request" }));
    expect(r.a).toBe(0);
    expect(r.b).toMatchObject({ status: 409, body: { code: "CLASS_NOT_LIVE" } });
    expect(await coverRow(ids.arcReqA2)).toBeNull();
    expect(r.blockedOn).toMatch(/FOR NO KEY UPDATE OF ci/);
    await restoredWithNoCover(ids.arcReqA);
  }, 180_000);

  it("K3. an Assign parked on a session with no cover, then an archive: the archive waits, then closes it; restoring brings none back", async () => {
    const r = await interleave(act(owner(), ids.arcAsgP2, { action: "assign", coachUserId: ids.gus }), () => archiveClass(ids.arcAsgP));
    expect(r.a).toMatchObject({ ok: true });
    expect(r.b.status).toBe(200);
    expect(await coverRow(ids.arcAsgP2)).toMatchObject({ status: "closed", closedReason: "class_archived", coverUserId: null });
    expect(r.blockedOn).toMatch(/ORDER BY ci\.id FOR NO KEY UPDATE OF ci/);
    await restoredWithNoCover(ids.arcAsgP);
  }, 180_000);

  it("K4. an archive parked, then an Assign on a session with no cover: the assignment waits, then is refused; no row", async () => {
    const r = await interleave(parkedArchive(ids.arcAsgA), () => cover(ids.arcAsgA2, owner(), { action: "assign", coachUserId: ids.gus }));
    expect(r.b).toMatchObject({ status: 409, body: { code: "CLASS_NOT_LIVE" } });
    expect(await coverRow(ids.arcAsgA2)).toBeNull();
    expect(r.blockedOn).toMatch(/FOR NO KEY UPDATE OF ci/);
    await restoredWithNoCover(ids.arcAsgA);
  }, 180_000);

  it("K5. a Request parked, then a pause: the pause waits, then closes it; resuming brings none back", async () => {
    const r = await interleave(act(owner(), ids.pauReqP2, { action: "request" }), () => patchClass(ids.pauReqP, { isActive: false }));
    expect(r.a).toMatchObject({ ok: true });
    expect(r.b.status).toBe(200);
    expect(await coverRow(ids.pauReqP2)).toMatchObject({ status: "closed", closedReason: "class_paused" });
    expect(r.blockedOn).toMatch(/ORDER BY ci\.id FOR NO KEY UPDATE OF ci/);
    await restoredWithNoCover(ids.pauReqP);
  }, 180_000);

  it("K6. a pause parked, then a Request: the request waits, then is refused; no row", async () => {
    const r = await interleave(parkedPause(ids.pauReqA), () => cover(ids.pauReqA2, owner(), { action: "request" }));
    expect(r.b).toMatchObject({ status: 409, body: { code: "CLASS_NOT_LIVE" } });
    expect(await coverRow(ids.pauReqA2)).toBeNull();
    expect(r.blockedOn).toMatch(/FOR NO KEY UPDATE OF ci/);
    await restoredWithNoCover(ids.pauReqA);
  }, 180_000);

  it("K7. an Assign parked, then a pause: the pause waits, then closes it; resuming brings none back", async () => {
    const r = await interleave(act(owner(), ids.pauAsgP2, { action: "assign", coachUserId: ids.gus }), () => patchClass(ids.pauAsgP, { isActive: false }));
    expect(r.a).toMatchObject({ ok: true });
    expect(r.b.status).toBe(200);
    expect(await coverRow(ids.pauAsgP2)).toMatchObject({ status: "closed", closedReason: "class_paused", coverUserId: null });
    expect(r.blockedOn).toMatch(/ORDER BY ci\.id FOR NO KEY UPDATE OF ci/);
    await restoredWithNoCover(ids.pauAsgP);
  }, 180_000);

  it("K8. a pause parked, then an Assign: the assignment waits, then is refused; no row", async () => {
    const r = await interleave(parkedPause(ids.pauAsgA), () => cover(ids.pauAsgA2, owner(), { action: "assign", coachUserId: ids.gus }));
    expect(r.b).toMatchObject({ status: 409, body: { code: "CLASS_NOT_LIVE" } });
    expect(await coverRow(ids.pauAsgA2)).toBeNull();
    expect(r.blockedOn).toMatch(/FOR NO KEY UPDATE OF ci/);
    await restoredWithNoCover(ids.pauAsgA);
  }, 180_000);

  it("L1. a claim parked, then making that coach the regular coach of an overlapping class: the change waits, then is refused by name", async () => {
    expect((await cover(ids.ccAX, owner(), { action: "request" })).status).toBe(200);
    const r = await interleave(act(coach("cara"), ids.ccAX, { action: "claim" }), () => patchClass(ids.ccA, { coachUserId: ids.cara }));
    expect(r.a).toMatchObject({ ok: true });
    expect(r.b).toMatchObject({ status: 409, body: { reason: "coach_cover_clash", conflict: { instanceId: ids.ccAX, className: "Elsewhere ccA" } } });
    expect(r.b.body.error).toMatch(/^Cara Claim is covering Elsewhere ccA on \w+day \d+ \w+, 19:30–21:00, Mat 8, which overlaps this class on \w+day \d+ \w+, 19:00–20:30, Mat 4\./);
    expect((await withRlsBypass((tx) => tx.class.findFirst({ where: { id: ids.ccA }, select: { coachUserId: true } })))?.coachUserId).toBe(ids.alex);
    expect(r.blockedOn).toMatch(/^advisory: /);
  }, 180_000);

  it("L2. a change of regular coach parked, then that coach claims an overlapping session: the claim waits, then is refused by name", async () => {
    expect((await cover(ids.ccBX, owner(), { action: "request" })).status).toBe(200);
    const r = await interleave(
      async (tx) => {
        // The class PATCH's order: the new coach's COVR key, the Class row, the write, then the check under the class-wide lock.
        await lockCoachCover(tx, state.tenantId, ids.dan);
        await tx.$queryRaw`SELECT "id" FROM "Class" WHERE "id" = ${ids.ccB} AND "tenantId" = ${state.tenantId} FOR UPDATE`;
        await tx.class.updateMany({ where: { id: ids.ccB, tenantId: state.tenantId }, data: { coachUserId: ids.dan } });
        return regularCoachCoverClash(tx, state.tenantId, ids.ccB, ids.dan, "Europe/London");
      },
      () => cover(ids.ccBX, coach("dan"), { action: "claim" }),
    );
    expect(r.a).toBeNull();
    expect(r.b).toMatchObject({ status: 409, body: { code: "OVERLAP" } });
    expect(r.b.body.error).toContain("already teaching Coach change ccB");
    expect(await coverRow(ids.ccBX)).toMatchObject({ status: "open", coverUserId: null });
    expect(r.blockedOn).toMatch(/^advisory: /);
  }, 180_000);

  it("L3. a claim parked, then deactivating that coach: the deactivation waits, then reopens the cover", async () => {
    expect((await cover(ids.de1, owner(), { action: "request" })).status).toBe(200);
    const r = await interleave(act(coach("eve"), ids.de1, { action: "claim" }), () => deactivateStaff(ids.eve));
    expect(r.a).toMatchObject({ ok: true });
    expect(r.b.status).toBe(200);
    expect(await coverRow(ids.de1)).toMatchObject({ status: "open", coverUserId: null });
    expect(await audits("class.cover_given_up", ids.de1)).toBe(1);
    expect(r.blockedOn).toMatch(/^advisory: /);
  }, 180_000);

  it("L4. a deactivation parked, then that coach claims: the claim waits, then is refused; nothing claimed", async () => {
    expect((await cover(ids.de2, owner(), { action: "request" })).status).toBe(200);
    const r = await interleave(
      async (tx) => {
        await lockCoachCover(tx, state.tenantId, ids.fay);
        await tx.user.updateMany({ where: { id: ids.fay, tenantId: state.tenantId }, data: { deactivatedAt: new Date() } });
        return reopenCoversOfDeactivatedCoach(tx, state.tenantId, ids.owner, ids.fay, "Europe/London");
      },
      () => cover(ids.de2, coach("fay"), { action: "claim" }),
    );
    expect(r.b).toMatchObject({ status: 403, body: { code: "NOT_ELIGIBLE" } });
    expect(await coverRow(ids.de2)).toMatchObject({ status: "open", coverUserId: null });
    expect(r.blockedOn).toMatch(/^advisory: /);
  }, 180_000);

  it("L5. a reconfirm parked, then a weekly-slot edit moving that session: the edit waits, then carries the cover on and flags it again", async () => {
    const r = await interleave(act(coach("rex"), ids.r, { action: "reconfirm" }), () => slotEdit(ids.editR, "Edit R", [{ dayOfWeek: 4, startTime: "07:30", endTime: "08:30" }]));
    expect(r.a).toMatchObject({ ok: true, cover: { needsReconfirm: false } });
    expect(r.b.status).toBe(200);
    expect(r.b.body.scheduleChange?.coverMoved).toBe(1);
    const row = await withRlsBypass((tx) => tx.sessionCover.findFirst({ where: { tenantId: state.tenantId, coverUserId: ids.rex, classInstance: { classId: ids.editR } }, include: { classInstance: true } }));
    expect(row).toMatchObject({ status: "covered", needsReconfirm: true });
    expect(row?.classInstance).toMatchObject({ startTime: "07:30" });
    expect(await audits("class.cover_reconfirmed", ids.r)).toBe(1);
    expect(r.blockedOn).toMatch(/ORDER BY ci\.id FOR NO KEY UPDATE OF ci/);
  }, 180_000);

  it("L6. a weekly-slot edit parked, then a reconfirm of the session it moves: refused as gone; the cover still awaits reconfirmation", async () => {
    const moves = slotMovesOf([{ dayOfWeek: 4, startTime: "09:00" }], [{ dayOfWeek: 4, startTime: "09:30" }]);
    const r = await interleave(
      async (tx) => {
        const report = await moveCoversBeforeDelete(tx, state.tenantId, ids.owner, ids.editR2, [ids.r2], moves, "Europe/London");
        await tx.classInstance.deleteMany({ where: { id: ids.r2 } });
        return report;
      },
      () => cover(ids.r2, coach("rex"), { action: "reconfirm" }),
    );
    expect(r.a).toMatchObject({ moved: 1 });
    expect(r.b).toMatchObject({ status: 409, body: { code: "SESSION_GONE" } });
    expect(await coverRow(ids.r2New)).toMatchObject({ status: "covered", coverUserId: ids.rex, needsReconfirm: true });
    expect(r.blockedOn).toMatch(/FOR (NO KEY )?UPDATE OF ci/);
  }, 180_000);

  it("M. a Request parked on the session a slot edit carries a cover to: the edit waits, then answers (no 500); one row per session", async () => {
    expect((await cover(ids.n, owner(), { action: "request" })).status).toBe(200);
    const r = await interleave(act(owner(), ids.nTo, { action: "request" }), () => slotEdit(ids.editN, "Edit N", [{ dayOfWeek: 4, startTime: "07:30", endTime: "08:30" }]));
    expect(r.a).toMatchObject({ ok: true });
    expect(r.b.status).toBe(200);
    // The replacement already has its own request, so the old one is not carried onto it: it is closed with its reason.
    expect(await coverRow(ids.nTo)).toMatchObject({ status: "open" });
    const old = await withRlsBypass((tx) => tx.sessionCover.findMany({ where: { tenantId: state.tenantId, classInstanceId: null, status: "closed", closedReason: "replacement_ambiguous" } }));
    expect(old.length).toBe(1);
    expect(r.blockedOn).toMatch(/ORDER BY ci\.id FOR NO KEY UPDATE OF ci/);
  }, 180_000);
});
