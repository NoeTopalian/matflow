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

import { applyCoverAction, closeCoverOnCancel, moveCoversBeforeDelete, slotMovesOf, type CoverInput } from "@/lib/session-cover";
import { POST as coverRoute } from "@/app/api/coach/instances/[id]/cover/route";
import { PATCH as sessionRoute } from "@/app/api/classes/[id]/instances/[instanceId]/route";
import { PATCH as classRoute } from "@/app/api/classes/[id]/route";

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
    if (rows[0]) return `${rows[0].t}: ${rows[0].q.replace(/\s+/g, " ").slice(0, 200)}`;
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
    });
  }, 120_000);

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
    expect(r.blockedOn).toMatch(/FOR UPDATE OF ci/);
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
});
