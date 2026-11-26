// Session cover (26 Nov 2026) through the real route handlers on real Postgres.
//  1. A coach already teaching a simultaneous session on another mat is refused, and the refusal names that session.
//  2. Two coaches claiming the same open request at the same moment: exactly one succeeds; the other is told
//     "Already covered by [name]."; one covered row; one cover_claimed Activity row.
//  3. Next Thursday's session of the same class is untouched, and the weekly class keeps its coach.
//  4. One coach claiming two overlapping open requests at the same moment: exactly one succeeds (the per-coach
//     advisory lock serialises the overlap check), so nobody is double-booked.
//  5. Cancelling the session closes its cover; restoring it does not recommit the coach.
// Synthetic data; skips without DATABASE_URL.
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { withRlsBypass } from "@/lib/prisma-tenant";

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

import { POST as coverRoute } from "@/app/api/coach/instances/[id]/cover/route";
import { PATCH as sessionRoute } from "@/app/api/classes/[id]/instances/[instanceId]/route";
import { PATCH as classRoute } from "@/app/api/classes/[id]/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
// Far-future Thursdays, so no session here has started.
const THU1 = new Date(Date.UTC(2032, 11, 2)); // Thursday 2 December 2032
const THU2 = new Date(Date.UTC(2032, 11, 9));
const THU3 = new Date(Date.UTC(2032, 11, 16));
// The next Thursday after today (London), inside the rolling window a weekly-slot edit re-mints.
const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const NEXT_THU = (() => { const d = new Date(`${todayKey}T00:00:00Z`); const dow = d.getUTCDay(); d.setUTCDate(d.getUTCDate() + (((4 - dow + 7) % 7) || 7)); return d; })();

type Answer = { status: number; body: { error?: string; code?: string; cover?: { status: string; coverUserId: string | null; coverUserName: string | null } | null; conflict?: { instanceId: string } } };
async function cover(instanceId: string, who: { userId: string; role: string }, body: Record<string, unknown>): Promise<Answer> {
  state.queue.push(who);
  const res = (await coverRoute(
    new Request(`http://test/api/coach/instances/${instanceId}/cover`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: instanceId }) },
  )) as unknown as { status: number; json: () => Promise<Answer["body"]> };
  return { status: res.status, body: await res.json() };
}

describe.skipIf(!HAS_DB)("session cover — real database", () => {
  const ids = { owner: "", alex: "", kim: "", sam: "", lee: "", pat: "", adults: "", kids: "", nogi: "", wrestling: "", thu1: "", thu2: "", kidsThu1: "", nogiThu1: "", wrestlingThu1: "", alexMat1: "", openMat2: "", late: "", twice: "", alexMat1Thu3: "", openMat2Thu3: "", lateThu3: "", morning: "", evening: "", backA: "", backB: "" };
  const coach = (k: "alex" | "kim" | "sam" | "lee" | "pat") => ({ userId: ids[k], role: "coach" });
  const owner = () => ({ userId: ids.owner, role: "owner" });
  const coverRow = (instanceId: string) => withRlsBypass((tx) => tx.sessionCover.findFirst({ where: { tenantId: state.tenantId, classInstanceId: instanceId } }));
  const audits = (action: string, instanceId: string) => withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: state.tenantId, action, entityId: instanceId } }));

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      state.tenantId = (await tx.tenant.create({ data: { name: `Cover cc ${STAMP}`, slug: `cover-cc-${STAMP}`, timezone: "Europe/London" } })).id;
      const user = async (key: string, name: string, role: string) =>
        (await tx.user.create({ data: { tenantId: state.tenantId, email: `cover-cc-${key}-${STAMP}@example.test`, name, role, passwordHash: "x" } })).id;
      ids.owner = await user("owner", "Olive Owner", "owner");
      state.ownerId = ids.owner;
      ids.alex = await user("alex", "Alex Regular", "coach");
      ids.kim = await user("kim", "Kim Kids", "coach");
      ids.sam = await user("sam", "Sam Cover", "coach");
      ids.lee = await user("lee", "Lee Cover", "coach");
      ids.pat = await user("pat", "Pat Spare", "coach");
      const klass = async (name: string, location: string, coachUserId: string | null) =>
        (await tx.class.create({ data: { tenantId: state.tenantId, name, location, coachUserId, duration: 90, maxCapacity: 30 } })).id;
      ids.adults = await klass("Adults Gi", "Mat 2", ids.alex);
      ids.kids = await klass("Kids BJJ", "Mat 1", ids.kim);
      ids.nogi = await klass("Nogi", "Mat 3", null);
      ids.wrestling = await klass("Wrestling", "Mat 4", null);
      const inst = async (classId: string, date: Date, startTime: string, endTime: string) => (await tx.classInstance.create({ data: { classId, date, startTime, endTime } })).id;
      ids.thu1 = await inst(ids.adults, THU1, "19:00", "20:30");
      ids.thu2 = await inst(ids.adults, THU2, "19:00", "20:30");
      ids.kidsThu1 = await inst(ids.kids, THU1, "19:00", "20:30");
      ids.nogiThu1 = await inst(ids.nogi, THU1, "21:00", "22:00");
      ids.wrestlingThu1 = await inst(ids.wrestling, THU1, "21:30", "22:30");
      // Correction 2 (who is actually teaching): Alex's own Mat 1 class, an uncoached Mat 2 class at the same time, and
      // a Mat 3 class starting as they end (back to back), on a third Thursday.
      ids.alexMat1 = await klass("Alex Mat 1", "Mat 1", ids.alex);
      ids.openMat2 = await klass("Open Mat 2", "Mat 2", null);
      ids.late = await klass("Late Mat 3", "Mat 3", null);
      ids.alexMat1Thu3 = await inst(ids.alexMat1, THU3, "19:00", "20:30");
      ids.openMat2Thu3 = await inst(ids.openMat2, THU3, "19:00", "20:30");
      ids.lateThu3 = await inst(ids.late, THU3, "20:30", "21:30");
      // Correction 1 (same date is not same session): one class twice on the next Thursday.
      ids.twice = (await tx.class.create({ data: { tenantId: state.tenantId, name: "Twice Thursday", location: "Mat 4", duration: 60, schedules: { create: [{ dayOfWeek: 4, startTime: "07:00", endTime: "08:00" }, { dayOfWeek: 4, startTime: "19:00", endTime: "20:00" }] } } })).id;
      ids.morning = await inst(ids.twice, NEXT_THU, "07:00", "08:00");
      // Back to back on the second Thursday (Mats 5 and 6): one ends at 19:00 as the other starts.
      ids.backA = await inst(await klass("Back A", "Mat 5", null), THU2, "18:00", "19:00");
      ids.backB = await inst(await klass("Back B", "Mat 6", null), THU2, "19:00", "20:00");
      ids.evening = await inst(ids.twice, NEXT_THU, "19:00", "20:00");
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

  it("the owner asks for cover on the first Thursday", async () => {
    const a = await cover(ids.thu1, owner(), { action: "request" });
    expect(a.status).toBe(200);
    expect(a.body.cover).toMatchObject({ status: "open", coverUserId: null });
    expect(await audits("class.cover_requested", ids.thu1)).toBe(1);
  }, 60_000);

  it("a coach already teaching a simultaneous session on another mat is refused, naming that session", async () => {
    const a = await cover(ids.thu1, coach("kim"), { action: "claim" });
    expect(a.status).toBe(409);
    expect(a.body.code).toBe("OVERLAP");
    expect(a.body.error).toBe("You're already teaching Kids BJJ on Thursday 2 December, 19:00–20:30, Mat 1.");
    expect(a.body.conflict?.instanceId).toBe(ids.kidsThu1);
    expect(await coverRow(ids.thu1)).toMatchObject({ status: "open", coverUserId: null });
  }, 60_000);

  it("two coaches claim at the same moment: exactly one wins, the other is told who has it", async () => {
    const [a, b] = await Promise.all([cover(ids.thu1, coach("sam"), { action: "claim" }), cover(ids.thu1, coach("lee"), { action: "claim" })]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    const winnerName = winner.body.cover?.coverUserName;
    expect(["Sam Cover", "Lee Cover"]).toContain(winnerName);
    expect(loser.body.code).toBe("ALREADY_COVERED");
    expect(loser.body.error).toBe(`Already covered by ${winnerName}.`);
    const row = await coverRow(ids.thu1);
    expect(row).toMatchObject({ status: "covered", coverUserId: winnerName === "Sam Cover" ? ids.sam : ids.lee });
    expect(await withRlsBypass((tx) => tx.sessionCover.count({ where: { tenantId: state.tenantId, classInstanceId: ids.thu1 } }))).toBe(1);
    expect(await audits("class.cover_claimed", ids.thu1)).toBe(1);
  }, 120_000);

  it("next Thursday is untouched and the weekly class keeps its coach", async () => {
    expect(await coverRow(ids.thu2)).toBeNull();
    const cls = await withRlsBypass((tx) => tx.class.findFirst({ where: { id: ids.adults, tenantId: state.tenantId }, select: { coachUserId: true, coachName: true } }));
    expect(cls).toEqual({ coachUserId: ids.alex, coachName: null });
  }, 60_000);

  it("one coach claiming two overlapping requests at the same moment gets exactly one", async () => {
    expect((await cover(ids.nogiThu1, owner(), { action: "request" })).status).toBe(200);
    expect((await cover(ids.wrestlingThu1, owner(), { action: "request" })).status).toBe(200);
    const [a, b] = await Promise.all([cover(ids.nogiThu1, coach("pat"), { action: "claim" }), cover(ids.wrestlingThu1, coach("pat"), { action: "claim" })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const refused = a.status === 409 ? a : b;
    expect(refused.body.code).toBe("OVERLAP");
    const patCovers = await withRlsBypass((tx) => tx.sessionCover.count({ where: { tenantId: state.tenantId, coverUserId: ids.pat, status: "covered" } }));
    expect(patCovers).toBe(1);
  }, 120_000);

  it("one coach claiming two back-to-back requests at the same moment gets both", async () => {
    expect((await cover(ids.backA, owner(), { action: "request" })).status).toBe(200);
    expect((await cover(ids.backB, owner(), { action: "request" })).status).toBe(200);
    const [a, b] = await Promise.all([cover(ids.backA, coach("pat"), { action: "claim" }), cover(ids.backB, coach("pat"), { action: "claim" })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await coverRow(ids.backA)).toMatchObject({ status: "covered", coverUserId: ids.pat });
    expect(await coverRow(ids.backB)).toMatchObject({ status: "covered", coverUserId: ids.pat });
  }, 120_000);

  it("cancelling the session closes its cover; restoring it does not recommit the coach", async () => {
    const patch = async (isCancelled: boolean) => {
      state.queue.push(owner());
      const res = (await sessionRoute(
        new Request(`http://test/api/classes/${ids.adults}/instances/${ids.thu1}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isCancelled }) }),
        { params: Promise.resolve({ id: ids.adults, instanceId: ids.thu1 }) },
      )) as unknown as { status: number };
      return res.status;
    };
    expect(await patch(true)).toBe(200);
    expect(await coverRow(ids.thu1)).toMatchObject({ status: "closed", closedReason: "session_cancelled", coverUserId: null });
    expect(await audits("class.cover_closed", ids.thu1)).toBe(1);
    expect(await patch(false)).toBe(200);
    expect(await coverRow(ids.thu1)).toMatchObject({ status: "closed", coverUserId: null });
    // And nobody can claim it now: there is no open request.
    expect((await cover(ids.thu1, coach("sam"), { action: "claim" })).body.code).toBe("NOT_OPEN");
  }, 120_000);

  it("who is actually teaching: an open request does not release Alex; Sam's confirmed cover does; back to back is allowed", async () => {
    expect((await cover(ids.alexMat1Thu3, owner(), { action: "request" })).status).toBe(200);
    expect((await cover(ids.openMat2Thu3, owner(), { action: "request" })).status).toBe(200);
    expect((await cover(ids.lateThu3, owner(), { action: "request" })).status).toBe(200);
    // Only requested: Alex still teaches his Mat 1 session.
    const early = await cover(ids.openMat2Thu3, coach("alex"), { action: "claim" });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("OVERLAP");
    expect(early.body.error).toBe("You're already teaching Alex Mat 1 on Thursday 16 December, 19:00–20:30, Mat 1.");
    // The owner cannot assign him there either.
    expect((await cover(ids.openMat2Thu3, owner(), { action: "assign", coachUserId: ids.alex })).body.code).toBe("OVERLAP");
    // Sam is confirmed on Alex's Mat 1 session: Alex is free, and Sam is the busy one.
    expect((await cover(ids.alexMat1Thu3, coach("sam"), { action: "claim" })).status).toBe(200);
    expect((await cover(ids.openMat2Thu3, coach("sam"), { action: "claim" })).body.code).toBe("OVERLAP");
    expect((await cover(ids.openMat2Thu3, coach("alex"), { action: "claim" })).status).toBe(200);
    // Back to back: Mat 2 ends at 20:30 as Mat 3 starts.
    expect((await cover(ids.lateThu3, coach("alex"), { action: "claim" })).status).toBe(200);
  }, 180_000);

  it("withdrawing, returning or giving up Sam's cover would double-book Alex: refused by name, nothing changes", async () => {
    for (const [action, who] of [["withdraw", owner()], ["return", owner()], ["give_up", coach("sam")]] as const) {
      const a = await cover(ids.alexMat1Thu3, who, { action });
      expect(a.status, action).toBe(409);
      expect(a.body.code, action).toBe("REGULAR_COACH_BUSY");
      expect(a.body.error, action).toContain("would put Alex Regular back on this class while they teach Open Mat 2 on Thursday 16 December, 19:00–20:30, Mat 2.");
      expect(await coverRow(ids.alexMat1Thu3)).toMatchObject({ status: "covered", coverUserId: ids.sam });
    }
    // Once Alex gives up Mat 2, Sam's cover can be withdrawn and Alex teaches his own class again.
    expect((await cover(ids.openMat2Thu3, coach("alex"), { action: "give_up" })).status).toBe(200);
    expect((await cover(ids.alexMat1Thu3, owner(), { action: "withdraw" })).status).toBe(200);
    expect(await coverRow(ids.alexMat1Thu3)).toMatchObject({ status: "withdrawn", coverUserId: null });
  }, 180_000);

  it("same date is not same session: a class twice on Thursday keeps each cover on its own session through a slot edit", async () => {
    expect((await cover(ids.morning, owner(), { action: "assign", coachUserId: ids.lee })).status).toBe(200);
    expect((await cover(ids.evening, owner(), { action: "request" })).status).toBe(200);
    type Change = { coverMoved?: number; coverClosed?: Array<{ startTime: string; closedReason: string }> };
    const edit = async (schedules: Array<{ dayOfWeek: number; startTime: string; endTime: string }>) => {
      const res = (await classRoute(
        new Request(`http://test/api/classes/${ids.twice}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Twice Thursday", schedules }) }),
        { params: Promise.resolve({ id: ids.twice }) },
      )) as unknown as { status: number; json: () => Promise<{ scheduleChange: Change }> };
      return { status: res.status, body: await res.json() };
    };
    // The morning slot moves from 07:00 to 07:30; the evening slot is unchanged.
    const one = await edit([{ dayOfWeek: 4, startTime: "07:30", endTime: "08:30" }, { dayOfWeek: 4, startTime: "19:00", endTime: "20:00" }]);
    expect(one.status).toBe(200);
    expect(one.body.scheduleChange.coverMoved).toBe(1);
    const morningRow = await withRlsBypass((tx) => tx.sessionCover.findFirst({ where: { tenantId: state.tenantId, coverUserId: ids.lee }, include: { classInstance: true } }));
    expect(morningRow).toMatchObject({ status: "covered", needsReconfirm: true });
    expect(morningRow?.classInstance?.startTime).toBe("07:30");
    expect(morningRow?.classInstance?.date.toISOString()).toBe(NEXT_THU.toISOString());
    expect(await coverRow(ids.evening)).toMatchObject({ status: "open", coverUserId: null, needsReconfirm: false });
    expect(await audits("class.cover_reconfirm_flagged", morningRow!.classInstanceId!)).toBe(1);
    // The covering coach accepts the new time.
    expect((await cover(morningRow!.classInstanceId!, coach("lee"), { action: "reconfirm" })).status).toBe(200);
    expect(await coverRow(morningRow!.classInstanceId!)).toMatchObject({ needsReconfirm: false });
    // Both slots change at once: no one-to-one match, so both requests are closed with the reason, never moved.
    const two = await edit([{ dayOfWeek: 4, startTime: "08:00", endTime: "09:00" }, { dayOfWeek: 4, startTime: "19:30", endTime: "20:30" }]);
    expect(two.status).toBe(200);
    expect(two.body.scheduleChange.coverClosed?.map((c) => [c.startTime, c.closedReason]).sort()).toEqual([["07:30", "replacement_ambiguous"], ["19:00", "replacement_ambiguous"]]);
    const ambiguous = await withRlsBypass((tx) => tx.sessionCover.findMany({ where: { tenantId: state.tenantId, closedReason: "replacement_ambiguous" } }));
    expect(ambiguous.length).toBe(2);
    expect(ambiguous.every((r) => r.status === "closed" && r.classInstanceId === null && r.coverUserId === null)).toBe(true);
    expect(await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: state.tenantId, action: "class.cover_closed", metadata: { path: ["closedReason"], equals: "replacement_ambiguous" } } }))).toBe(2);
  }, 240_000);

  it("a session with an active cover row cannot be deleted behind its back (RESTRICT)", async () => {
    await expect(withRlsBypass((tx) => tx.classInstance.deleteMany({ where: { id: ids.lateThu3 } }))).rejects.toThrow();
    expect(await coverRow(ids.lateThu3)).toMatchObject({ status: "covered", coverUserId: ids.alex });
  }, 60_000);

  it("the cover table is tenant-scoped: another club's id is a bare 404", async () => {
    const other = await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `Cover other ${STAMP}`, slug: `cover-other-${STAMP}` } });
      return t.id;
    });
    try {
      const saved = state.tenantId;
      state.tenantId = other;
      const a = await cover(ids.thu2, { userId: ids.owner, role: "owner" }, { action: "request" });
      state.tenantId = saved;
      expect(a.status).toBe(404);
      expect(await coverRow(ids.thu2)).toBeNull();
    } finally {
      await withRlsBypass((tx) => tx.tenant.deleteMany({ where: { id: other } }));
    }
  }, 60_000);
});

