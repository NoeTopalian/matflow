// Session cover (26 Nov 2026): who may do what to a dated session's cover, the first-claim-wins and overlap
// refusals as the server applies them, and what cancelling or re-timing a session does to its cover.
// A small in-memory stand-in for the transaction; the database version of the race is
// tests/integration/session-cover-concurrency-db.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

const audits = vi.hoisted(() => [] as Array<{ action: string; userId: string | null; entityId: string; metadata: Record<string, unknown> }>);
vi.mock("@/lib/audit-log", () => ({
  logAuditStrict: vi.fn(async (_tx: unknown, args: { action: string; userId: string | null; entityId: string; metadata: Record<string, unknown> }) => {
    audits.push(args);
  }),
}));

import { applyCoverAction, closeCoverOnCancel, findCoverOverlap, flagCoversForRetime, moveCoversBeforeDelete, slotMovesOf, type CoverSession } from "@/lib/session-cover";
import { resolveSessionTeacher, staffCoachLabel, memberCoachLabel } from "@/lib/session-coach";

const T = "tenant-1";
const NOW = new Date("2031-11-20T12:00:00Z");
const THU = new Date("2031-12-04T00:00:00Z"); // a club date marker
const NEXT_THU = new Date("2031-12-11T00:00:00Z");

type Row = { id: string; status: string; coverUserId: string | null; needsReconfirm: boolean; classInstanceId: string | null; closedReason?: string | null };
// Every user carries its club and its deactivation, and the fake applies the query's own filters, so a refusal
// for "another club" or "deactivated" only passes if the real query asks for those things.
const USERS: Record<string, { id: string; name: string; role: string; tenantId: string; deactivatedAt: Date | null }> = {
  "u-owner": { id: "u-owner", name: "Olive Owner", role: "owner", tenantId: "tenant-1", deactivatedAt: null },
  "u-alex": { id: "u-alex", name: "Alex Regular", role: "coach", tenantId: "tenant-1", deactivatedAt: null },
  "u-sam": { id: "u-sam", name: "Sam Cover", role: "coach", tenantId: "tenant-1", deactivatedAt: null },
  "u-kim": { id: "u-kim", name: "Kim Coach", role: "coach", tenantId: "tenant-1", deactivatedAt: null },
  "u-gone": { id: "u-gone", name: "Gone Coach", role: "coach", tenantId: "tenant-1", deactivatedAt: new Date("2031-01-01T00:00:00Z") },
  "u-other": { id: "u-other", name: "Other Club Coach", role: "coach", tenantId: "tenant-2", deactivatedAt: null },
};

function session(over: Partial<CoverSession> & { classOver?: Partial<CoverSession["class"]> } = {}): CoverSession {
  const { classOver, ...rest } = over;
  return {
    id: "s-thu",
    date: THU,
    startTime: "19:00",
    endTime: "20:30",
    isCancelled: false,
    class: {
      id: "c-adults",
      name: "Adults Gi",
      coachUserId: "u-alex",
      coachName: null,
      location: "Mat 2",
      duration: 90,
      isActive: true,
      deletedAt: null,
      sourceImportJobId: null,
      coachUser: { id: "u-alex", name: "Alex Regular", deactivatedAt: null },
      mat: { name: "Mat 2" },
      ...classOver,
    },
    ...rest,
  } as CoverSession;
}

/** A transaction stand-in holding one session (of `sessionTenant`) and its (optional) cover row. */
function fakeTx(opts: { s?: CoverSession | null; row?: Row | null; candidates?: unknown[]; loseClaimTo?: string; insertLosesTo?: Row; sessionTenant?: string } = {}) {
  const state = { row: opts.row ?? null, s: opts.s === undefined ? session() : opts.s, sessionTenant: opts.sessionTenant ?? T };
  const name = (id: string | null) => (id ? USERS[id]?.name ?? null : null);
  const view = () => (state.row ? { ...state.row, coverUser: state.row.coverUserId ? { name: name(state.row.coverUserId) } : null } : null);
  const sessionVisible = (id: unknown, tenant: unknown) => !!state.s && id === state.s.id && tenant === state.sessionTenant;
  const matches = (where: Record<string, unknown>) => {
    const r = state.row;
    if (!r) return false;
    if ("id" in where && where.id !== r.id) return false;
    if ("tenantId" in where && where.tenantId !== T) return false;
    if ("classInstanceId" in where && where.classInstanceId !== r.classInstanceId) return false;
    const st = where.status as string | { in: string[] } | undefined;
    if (typeof st === "string" && r.status !== st) return false;
    if (st && typeof st === "object" && !st.in.includes(r.status)) return false;
    if ("coverUserId" in where && where.coverUserId !== r.coverUserId) return false;
    if ("needsReconfirm" in where && where.needsReconfirm !== r.needsReconfirm) return false;
    return true;
  };
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    // The session row lock: the session id and tenant id are its first two bind values.
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ...vals: unknown[]) => (Array.isArray(vals[0]) ? [] : sessionVisible(vals[0], vals[1]) ? [{ id: vals[0] }] : [])),
    tenant: { findUnique: vi.fn(async () => ({ timezone: "Europe/London" })) },
    classInstance: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; class: { tenantId: string } } }) => (sessionVisible(where.id, where.class?.tenantId) ? state.s : null)),
      findMany: vi.fn(async () => opts.candidates ?? []),
    },
    user: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; tenantId?: string; deactivatedAt?: null; role?: { in: string[] } } }) => {
        const u = USERS[where.id];
        if (!u) return null;
        if ("tenantId" in where && u.tenantId !== where.tenantId) return null;
        if ("deactivatedAt" in where && where.deactivatedAt === null && u.deactivatedAt !== null) return null;
        if (where.role && !where.role.in.includes(u.role)) return null;
        return { id: u.id, name: u.name };
      }),
    },
    sessionCover: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => (matches(where) ? view() : null)),
      findMany: vi.fn(async () => (state.row ? [{ ...state.row, classInstance: state.s ? { id: state.s.id, date: state.s.date, startTime: state.s.startTime, endTime: state.s.endTime } : null }] : [])),
      createMany: vi.fn(async ({ data }: { data: Array<Partial<Row>> }) => {
        if (opts.insertLosesTo) {
          // Another request or assignment inserted this session's row first (ON CONFLICT DO NOTHING).
          state.row = opts.insertLosesTo;
          return { count: 0 };
        }
        if (state.row) return { count: 0 };
        state.row = { id: "cov-1", status: "open", coverUserId: null, needsReconfirm: false, classInstanceId: "s-thu", ...data[0] } as Row;
        return { count: 1 };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        if (opts.loseClaimTo && data.status === "covered" && state.row?.status === "open") {
          // Another coach's claim committed first.
          state.row = { ...state.row, status: "covered", coverUserId: opts.loseClaimTo };
          return { count: 0 };
        }
        if (!matches(where)) return { count: 0 };
        state.row = { ...state.row!, ...data };
        return { count: 1 };
      }),
    },
  };
  return { tx: tx as never, state, raw: tx };
}

const as = (userId: string) => ({ tenantId: T, userId, role: USERS[userId].role });
const openRow = (): Row => ({ id: "cov-1", status: "open", coverUserId: null, needsReconfirm: false, classInstanceId: "s-thu" });
const coveredRow = (by = "u-sam"): Row => ({ id: "cov-1", status: "covered", coverUserId: by, needsReconfirm: false, classInstanceId: "s-thu" });

beforeEach(() => {
  audits.length = 0;
});

describe("request cover", () => {
  it("the class's own linked coach may ask; the row is open and Activity records who asked", async () => {
    const f = fakeTx();
    const out = await applyCoverAction(f.tx, as("u-alex"), "s-thu", { action: "request" }, NOW);
    expect(out).toMatchObject({ ok: true, changed: true, cover: { status: "open", coverUserId: null } });
    expect(audits.map((a) => [a.action, a.userId])).toEqual([["class.cover_requested", "u-alex"]]);
    expect(audits[0].metadata).toMatchObject({ classId: "c-adults", startTime: "19:00" });
  });

  it("another coach may not ask for cover on a session that is not theirs", async () => {
    const f = fakeTx();
    const out = await applyCoverAction(f.tx, as("u-kim"), "s-thu", { action: "request" }, NOW);
    expect(out).toMatchObject({ ok: false, status: 403 });
    expect(f.raw.sessionCover.createMany).not.toHaveBeenCalled();
  });

  it("a typed coach name equal to the coach's name does not make it their session", async () => {
    const f = fakeTx({ s: session({ classOver: { coachUserId: null, coachUser: null, coachName: "Kim Coach" } }) });
    const out = await applyCoverAction(f.tx, as("u-kim"), "s-thu", { action: "request" }, NOW);
    expect(out).toMatchObject({ ok: false, status: 403 });
  });

  it("the owner may ask on a class with no coach at all", async () => {
    const f = fakeTx({ s: session({ classOver: { coachUserId: null, coachUser: null } }) });
    expect(await applyCoverAction(f.tx, as("u-owner"), "s-thu", { action: "request" }, NOW)).toMatchObject({ ok: true });
  });

  it("a session that has started, or is cancelled, or of another club, is refused", async () => {
    expect(await applyCoverAction(fakeTx().tx, as("u-owner"), "s-thu", { action: "request" }, new Date("2031-12-04T19:30:00Z"))).toMatchObject({ ok: false, code: "SESSION_STARTED" });
    expect(await applyCoverAction(fakeTx({ s: session({ isCancelled: true }) }).tx, as("u-owner"), "s-thu", { action: "request" }, NOW)).toMatchObject({ ok: false, code: "SESSION_CANCELLED" });
    expect(await applyCoverAction(fakeTx({ s: null }).tx, as("u-owner"), "s-thu", { action: "request" }, NOW)).toMatchObject({ ok: false, status: 404 });
  });

  it("asking again while a request is open, or covered, is refused with who has it", async () => {
    expect(await applyCoverAction(fakeTx({ row: openRow() }).tx, as("u-owner"), "s-thu", { action: "request" }, NOW)).toMatchObject({ ok: false, code: "ALREADY_REQUESTED" });
    expect(await applyCoverAction(fakeTx({ row: coveredRow() }).tx, as("u-owner"), "s-thu", { action: "request" }, NOW)).toMatchObject({ ok: false, error: "Already covered by Sam Cover." });
  });
});

describe("claim — I'll cover this class", () => {
  it("assigns the signed-in coach at once, under that coach's advisory lock", async () => {
    const f = fakeTx({ row: openRow() });
    const out = await applyCoverAction(f.tx, as("u-sam"), "s-thu", { action: "claim" }, NOW);
    expect(out).toMatchObject({ ok: true, cover: { status: "covered", coverUserId: "u-sam", coverUserName: "Sam Cover" } });
    expect(f.raw.$executeRaw).toHaveBeenCalledTimes(1);
    expect(f.raw.sessionCover.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: "open" }) }));
    expect(audits.map((a) => [a.action, a.userId, a.metadata.coverUserId])).toEqual([["class.cover_claimed", "u-sam", "u-sam"]]);
  });

  it("the second of two claims sees Already covered by [name] and writes nothing", async () => {
    const f = fakeTx({ row: openRow(), loseClaimTo: "u-kim" });
    const out = await applyCoverAction(f.tx, as("u-sam"), "s-thu", { action: "claim" }, NOW);
    expect(out).toMatchObject({ ok: false, status: 409, code: "ALREADY_COVERED", error: "Already covered by Kim Coach." });
    expect(audits).toEqual([]);
  });

  it("refuses a coach who is already teaching at that time, naming the session", async () => {
    const clash = { ...session({ id: "s-kids", classOver: { id: "c-kids", name: "Kids BJJ", coachUserId: "u-sam", coachUser: { id: "u-sam", name: "Sam Cover", deactivatedAt: null }, mat: { name: "Mat 1" }, location: "Mat 1" } }), cover: null };
    const f = fakeTx({ row: openRow(), candidates: [clash] });
    const out = await applyCoverAction(f.tx, as("u-sam"), "s-thu", { action: "claim" }, NOW);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("OVERLAP");
    expect(out.error).toMatch(/^You're already teaching Kids BJJ on \w+day \d+ December, 19:00–20:30, Mat 1\.$/);
    expect(out.conflict).toMatchObject({ instanceId: "s-kids", className: "Kids BJJ" });
    expect(f.raw.sessionCover.updateMany).not.toHaveBeenCalled();
  });

  it("a request that is not open is refused", async () => {
    expect(await applyCoverAction(fakeTx().tx, as("u-sam"), "s-thu", { action: "claim" }, NOW)).toMatchObject({ ok: false, code: "NOT_OPEN" });
  });
});

describe("the overlap rule", () => {
  const target = session();
  const run = (candidates: unknown[], coach = "u-sam") => findCoverOverlap(fakeTx({ candidates }).tx, T, "Europe/London", coach, target);

  it("does not count the coach's own regular session that someone else is covering", async () => {
    const theirs = { ...session({ id: "s-own", classOver: { id: "c-own", name: "Own class", coachUserId: "u-sam" } }), cover: { status: "covered", coverUserId: "u-kim" } };
    expect(await run([theirs])).toBeNull();
  });

  it("counts a session the coach covers, and sessions that only touch end to start do not overlap", async () => {
    const covering = { ...session({ id: "s-c", startTime: "18:00", endTime: "19:30", classOver: { coachUserId: "u-kim" } }), cover: { status: "covered", coverUserId: "u-sam" } };
    expect(await run([covering])).toMatchObject({ instanceId: "s-c" });
    const before = { ...session({ id: "s-b", startTime: "17:30", endTime: "19:00", classOver: { coachUserId: "u-sam" } }), cover: null };
    expect(await run([before])).toBeNull();
  });

  it("an overnight session the evening before reaches into the target's day", async () => {
    const late = session({ startTime: "00:30", endTime: "01:30" });
    const overnight = { ...session({ id: "s-night", date: new Date("2031-12-03T00:00:00Z"), startTime: "23:00", endTime: "01:00", classOver: { coachUserId: "u-sam" } }), cover: null };
    expect(await findCoverOverlap(fakeTx({ candidates: [overnight] }).tx, T, "Europe/London", "u-sam", late)).toMatchObject({ instanceId: "s-night" });
  });
});

describe("who is actually teaching (Noe's correction, 26 Nov 2026)", () => {
  const target = session({ id: "s-mat2", classOver: { id: "c-mat2", name: "Mat 2 class", coachUserId: null, coachUser: null } });
  const alexsMat1 = (cover: unknown) => ({ ...session({ id: "s-mat1", classOver: { id: "c-mat1", name: "Mat 1 class", coachUserId: "u-alex", location: "Mat 1", mat: { name: "Mat 1" } } }), cover });
  const check = (cover: unknown) => findCoverOverlap(fakeTx({ candidates: [alexsMat1(cover)] }).tx, T, "Europe/London", "u-alex", target);
  it("an open request alone does not release the regular coach", async () => {
    expect(await check({ status: "open", coverUserId: null })).toMatchObject({ instanceId: "s-mat1" });
    expect(await check(null)).toMatchObject({ instanceId: "s-mat1" });
  });
  it("once Casey is confirmed on Alex's Mat 1 session, Alex is free for Mat 2", async () => {
    expect(await check({ status: "covered", coverUserId: "u-kim" })).toBeNull();
  });
  it("assigning Alex directly is refused the same way while his session is only requested", async () => {
    const f = fakeTx({ s: target, candidates: [alexsMat1({ status: "open", coverUserId: null })] });
    expect(await applyCoverAction(f.tx, as("u-owner"), "s-mat2", { action: "assign", coachUserId: "u-alex" }, NOW)).toMatchObject({ ok: false, code: "OVERLAP", error: expect.stringMatching(/^Alex Regular is already teaching Mat 1 class on /) });
  });
  it("withdraw, return and give up are refused by name when they would double-book the regular coach", async () => {
    // Alex now covers another overlapping session; taking Sam off Alex's own class would put Alex on both.
    const elsewhere = { ...session({ id: "s-other", classOver: { id: "c-o", name: "Open Mat", coachUserId: null, coachUser: null, location: "Mat 3", mat: { name: "Mat 3" } } }), cover: { status: "covered", coverUserId: "u-alex" } };
    for (const [action, who] of [["withdraw", "u-owner"], ["return", "u-owner"], ["give_up", "u-sam"]] as const) {
      const f = fakeTx({ row: coveredRow("u-sam"), candidates: [elsewhere] });
      const out = await applyCoverAction(f.tx, as(who), "s-thu", { action }, NOW);
      expect(out, action).toMatchObject({ ok: false, code: "REGULAR_COACH_BUSY", conflict: { instanceId: "s-other" } });
      if (!out.ok) expect(out.error).toMatch(/would put Alex Regular back on this class while they teach Open Mat on \w+day \d+ December, 19:00–20:30, Mat 3\./);
      expect(f.state.row).toMatchObject({ status: "covered", coverUserId: "u-sam" });
    }
  });
});

describe("assign, replace, give up, withdraw, return, reconfirm", () => {
  it("only the owner or a manager assigns, and only an active member of staff can be assigned", async () => {
    expect(await applyCoverAction(fakeTx().tx, as("u-sam"), "s-thu", { action: "assign", coachUserId: "u-kim" }, NOW)).toMatchObject({ ok: false, status: 403 });
    expect(await applyCoverAction(fakeTx().tx, as("u-owner"), "s-thu", { action: "assign", coachUserId: "u-gone" }, NOW)).toMatchObject({ ok: false, status: 400 });
    const f = fakeTx();
    expect(await applyCoverAction(f.tx, as("u-owner"), "s-thu", { action: "assign", coachUserId: "u-kim" }, NOW)).toMatchObject({ ok: true, cover: { status: "covered", coverUserId: "u-kim" } });
    expect(audits.map((a) => [a.action, a.userId, a.metadata.coverUserId])).toEqual([["class.cover_assigned", "u-owner", "u-kim"]]);
  });

  it("replace swaps the covering coach and records whom it replaced", async () => {
    const f = fakeTx({ row: coveredRow("u-sam") });
    expect(await applyCoverAction(f.tx, as("u-owner"), "s-thu", { action: "replace", coachUserId: "u-kim" }, NOW)).toMatchObject({ ok: true, cover: { coverUserId: "u-kim" } });
    expect(audits[0]).toMatchObject({ action: "class.cover_replaced", metadata: { coverUserId: "u-kim", previousCoverUserId: "u-sam" } });
  });

  it("give up: the covering coach reopens the request; another coach may not", async () => {
    expect(await applyCoverAction(fakeTx({ row: coveredRow("u-sam") }).tx, as("u-kim"), "s-thu", { action: "give_up" }, NOW)).toMatchObject({ ok: false, status: 403 });
    const f = fakeTx({ row: coveredRow("u-sam") });
    expect(await applyCoverAction(f.tx, as("u-sam"), "s-thu", { action: "give_up" }, NOW)).toMatchObject({ ok: true, cover: { status: "open", coverUserId: null } });
    expect(audits[0]).toMatchObject({ action: "class.cover_given_up", metadata: { previousCoverUserId: "u-sam" } });
  });

  it("give up after the session has started is refused", async () => {
    expect(await applyCoverAction(fakeTx({ row: coveredRow("u-sam") }).tx, as("u-sam"), "s-thu", { action: "give_up" }, new Date("2031-12-04T19:05:00Z"))).toMatchObject({ ok: false, code: "SESSION_STARTED" });
  });

  it("withdraw and return are the owner's or a manager's; return needs a regular coach", async () => {
    expect(await applyCoverAction(fakeTx({ row: openRow() }).tx, as("u-alex"), "s-thu", { action: "withdraw" }, NOW)).toMatchObject({ ok: false, status: 403 });
    const w = fakeTx({ row: coveredRow() });
    expect(await applyCoverAction(w.tx, as("u-owner"), "s-thu", { action: "withdraw" }, NOW)).toMatchObject({ ok: true, cover: null });
    expect(w.state.row).toMatchObject({ status: "withdrawn", coverUserId: null });
    const r = fakeTx({ row: coveredRow() });
    expect(await applyCoverAction(r.tx, as("u-owner"), "s-thu", { action: "return" }, NOW)).toMatchObject({ ok: true, cover: null });
    expect(r.state.row).toMatchObject({ status: "closed", closedReason: "returned_to_regular" });
    expect(await applyCoverAction(fakeTx({ row: openRow(), s: session({ classOver: { coachUserId: null, coachUser: null } }) }).tx, as("u-owner"), "s-thu", { action: "return" }, NOW)).toMatchObject({ ok: false, code: "NO_REGULAR_COACH" });
  });

  it("reconfirm clears the flag for the covering coach only", async () => {
    const flagged = { ...coveredRow("u-sam"), needsReconfirm: true };
    expect(await applyCoverAction(fakeTx({ row: flagged }).tx, as("u-kim"), "s-thu", { action: "reconfirm" }, NOW)).toMatchObject({ ok: false, status: 403 });
    const f = fakeTx({ row: { ...flagged } });
    expect(await applyCoverAction(f.tx, as("u-sam"), "s-thu", { action: "reconfirm" }, NOW)).toMatchObject({ ok: true, cover: { needsReconfirm: false } });
    expect(audits[0].action).toBe("class.cover_reconfirmed");
  });
});

describe("cancel, re-time and remove", () => {
  it("cancelling closes an active cover with its Activity row; no cover, no row", async () => {
    const f = fakeTx({ row: coveredRow("u-sam") });
    await closeCoverOnCancel(f.tx, T, "u-owner", { id: "s-thu", classId: "c-adults", date: THU, startTime: "19:00", endTime: "20:30" });
    expect(f.state.row).toMatchObject({ status: "closed", closedReason: "session_cancelled", coverUserId: null });
    expect(audits[0]).toMatchObject({ action: "class.cover_closed", metadata: { closedReason: "session_cancelled", previousCoverUserId: "u-sam" } });
    audits.length = 0;
    const none = fakeTx({ row: null });
    (none.raw.sessionCover.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await closeCoverOnCancel(none.tx, T, "u-owner", { id: "s-thu", classId: "c-adults", date: THU, startTime: "19:00", endTime: "20:30" });
    expect(audits).toEqual([]);
  });

  const WD = THU.getUTCDay();
  it("a one-to-one slot change moves a covered cover to its new session and flags it Awaiting reconfirmation", async () => {
    const f = fakeTx({ row: coveredRow("u-sam") });
    f.raw.classInstance.findMany.mockResolvedValueOnce([{ id: "s-thu-new", date: THU, startTime: "19:30", endTime: "21:00", cover: null }]);
    const report = await moveCoversBeforeDelete(f.tx, T, "u-owner", "c-adults", ["s-thu"], slotMovesOf([{ dayOfWeek: WD, startTime: "19:00" }], [{ dayOfWeek: WD, startTime: "19:30" }]));
    expect(report).toEqual({ moved: 1, closed: [] });
    expect(f.state.row).toMatchObject({ classInstanceId: "s-thu-new", status: "covered", needsReconfirm: true, coverUserId: "u-sam" });
    expect(audits[0]).toMatchObject({ action: "class.cover_reconfirm_flagged", entityId: "s-thu-new", metadata: { startTime: "19:30", previousStartTime: "19:00", coverUserId: "u-sam" } });
  });

  it("same date is not same session: a class twice on Thursday never carries the morning cover to the evening", async () => {
    // The 07:00 slot moved to 07:30; the 19:00 slot is unchanged. The morning cover goes to 07:30, not to 19:00.
    const morning = { ...coveredRow("u-sam") };
    const f = fakeTx({ row: morning, s: session({ startTime: "07:00", endTime: "08:00" }) });
    f.raw.classInstance.findMany.mockResolvedValueOnce([
      { id: "s-thu-eve", date: THU, startTime: "19:00", endTime: "20:30", cover: null },
      { id: "s-thu-0730", date: THU, startTime: "07:30", endTime: "08:30", cover: null },
    ]);
    await moveCoversBeforeDelete(f.tx, T, "u-owner", "c-adults", ["s-thu"], slotMovesOf([{ dayOfWeek: WD, startTime: "07:00" }], [{ dayOfWeek: WD, startTime: "07:30" }]));
    expect(f.state.row).toMatchObject({ classInstanceId: "s-thu-0730", needsReconfirm: true });
  });

  it("an edit with no one-to-one match that day closes the cover as ambiguous, with its Activity row", async () => {
    // Both Thursday slots changed at once: nothing says which new session the morning cover belongs to.
    const f = fakeTx({ row: coveredRow("u-sam"), s: session({ startTime: "07:00", endTime: "08:00" }) });
    f.raw.classInstance.findMany.mockResolvedValueOnce([
      { id: "s-a", date: THU, startTime: "07:30", endTime: "08:30", cover: null },
      { id: "s-b", date: THU, startTime: "19:30", endTime: "21:00", cover: null },
    ]);
    const report = await moveCoversBeforeDelete(f.tx, T, "u-owner", "c-adults", ["s-thu"], slotMovesOf(
      [{ dayOfWeek: WD, startTime: "07:00" }, { dayOfWeek: WD, startTime: "19:00" }],
      [{ dayOfWeek: WD, startTime: "07:30" }, { dayOfWeek: WD, startTime: "19:30" }],
    ));
    expect(f.state.row).toMatchObject({ status: "closed", closedReason: "replacement_ambiguous", classInstanceId: null, coverUserId: null });
    expect(report.closed).toEqual([{ date: THU.toISOString(), startTime: "07:00", closedReason: "replacement_ambiguous" }]);
    expect(audits[0]).toMatchObject({ action: "class.cover_closed", metadata: { closedReason: "replacement_ambiguous", previousCoverUserId: "u-sam" } });
  });

  it("with no session left on that day the cover is closed (session_removed) with its Activity row, never dropped", async () => {
    const f = fakeTx({ row: openRow() });
    f.raw.classInstance.findMany.mockResolvedValueOnce([{ id: "s-next", date: NEXT_THU, startTime: "19:30", endTime: "21:00", cover: null }]);
    await moveCoversBeforeDelete(f.tx, T, "u-owner", "c-adults", ["s-thu"]);
    expect(f.state.row).toMatchObject({ status: "closed", closedReason: "session_removed", classInstanceId: null });
    expect(audits[0]).toMatchObject({ action: "class.cover_closed", entityId: "s-thu", metadata: { closedReason: "session_removed", classId: "c-adults" } });
  });
});

describe("review of 5f92f724: eligibility, races and edits (round 2)", () => {
  it("a user of another club, or a deactivated one, is refused by the query's own filters", async () => {
    expect(await applyCoverAction(fakeTx().tx, as("u-owner"), "s-thu", { action: "assign", coachUserId: "u-other" }, NOW)).toMatchObject({ ok: false, status: 400, code: "NOT_ELIGIBLE" });
    expect(await applyCoverAction(fakeTx().tx, as("u-owner"), "s-thu", { action: "assign", coachUserId: "u-gone" }, NOW)).toMatchObject({ ok: false, status: 400, code: "NOT_ELIGIBLE" });
    expect(await applyCoverAction(fakeTx({ row: openRow() }).tx, { tenantId: T, userId: "u-gone", role: "coach" }, "s-thu", { action: "claim" }, NOW)).toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
  });

  it("another club's session is a bare 404, decided by the query's tenant filter", async () => {
    expect(await applyCoverAction(fakeTx({ sessionTenant: "tenant-2" }).tx, as("u-owner"), "s-thu", { action: "request" }, NOW)).toMatchObject({ ok: false, status: 404, error: "Not found" });
  });

  it("takes the coach's advisory lock and then the session row lock before reading the cover row", async () => {
    const f = fakeTx({ row: openRow() });
    await applyCoverAction(f.tx, as("u-sam"), "s-thu", { action: "claim" }, NOW);
    const order = [f.raw.$executeRaw.mock.invocationCallOrder[0], f.raw.$queryRaw.mock.invocationCallOrder[0], f.raw.sessionCover.findFirst.mock.invocationCallOrder[0]];
    expect(order.every((n) => typeof n === "number")).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("a Request or Assign that finds the row inserted meanwhile says so accurately, never a save error", async () => {
    const theirs: Row = { id: "cov-9", status: "open", coverUserId: null, needsReconfirm: false, classInstanceId: "s-thu" };
    expect(await applyCoverAction(fakeTx({ insertLosesTo: theirs }).tx, as("u-owner"), "s-thu", { action: "request" }, NOW)).toMatchObject({ ok: false, status: 409, code: "ALREADY_REQUESTED" });
    const covered: Row = { ...theirs, status: "covered", coverUserId: "u-kim" };
    expect(await applyCoverAction(fakeTx({ insertLosesTo: covered }).tx, as("u-owner"), "s-thu", { action: "assign", coachUserId: "u-sam" }, NOW)).toMatchObject({ ok: false, status: 409, code: "ALREADY_COVERED", error: "Already covered by Kim Coach." });
    expect(audits).toEqual([]);
  });

  it("every conditional update is pinned to the session", async () => {
    const f = fakeTx({ row: openRow() });
    await applyCoverAction(f.tx, as("u-sam"), "s-thu", { action: "claim" }, NOW);
    expect(f.raw.sessionCover.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ classInstanceId: "s-thu", status: "open" }) }));
  });

  it("the class's own regular coach cannot claim or be assigned its cover", async () => {
    expect(await applyCoverAction(fakeTx({ row: openRow() }).tx, as("u-alex"), "s-thu", { action: "claim" }, NOW)).toMatchObject({ ok: false, code: "REGULAR_COACH", error: expect.stringMatching(/^You're this class's regular coach/) });
    expect(await applyCoverAction(fakeTx({ row: openRow() }).tx, as("u-owner"), "s-thu", { action: "assign", coachUserId: "u-alex" }, NOW)).toMatchObject({ ok: false, code: "REGULAR_COACH" });
  });

  it("cancelling writes its Activity row only when it really closed a row", async () => {
    const f = fakeTx({ row: coveredRow("u-sam") });
    f.raw.sessionCover.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await closeCoverOnCancel(f.tx, T, "u-owner", { id: "s-thu", classId: "c-adults", date: THU, startTime: "19:00", endTime: "20:30" })).toBe(false);
    expect(audits).toEqual([]);
    expect(f.raw.$queryRaw).toHaveBeenCalled();
  });

  it("an end-time-only change is not a move, so the other slot's move stays clear", () => {
    const wd = THU.getUTCDay();
    const m = slotMovesOf([{ dayOfWeek: wd, startTime: "07:00" }, { dayOfWeek: wd, startTime: "19:00" }], [{ dayOfWeek: wd, startTime: "07:30" }, { dayOfWeek: wd, startTime: "19:00" }]);
    expect(m.moves.get(wd)).toEqual({ from: "07:00", to: "07:30" });
    expect(m.ambiguousDays.has(wd)).toBe(false);
  });

  it("a replacement holding only an ended row still takes a clear move; a moved open request writes its own Activity row", async () => {
    const wd = THU.getUTCDay();
    const f = fakeTx({ row: openRow() });
    f.raw.classInstance.findMany.mockResolvedValueOnce([{ id: "s-new", date: THU, startTime: "19:30", endTime: "21:00", cover: { id: "cov-old", status: "withdrawn" } }]);
    const calls: Array<{ where: Record<string, unknown>; data: Partial<Row> }> = [];
    f.raw.sessionCover.updateMany.mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      calls.push({ where, data });
      if (where.id === "cov-old") return { count: 1 };
      if (where.id === "cov-1" && where.classInstanceId === "s-thu") {
        f.state.row = { ...f.state.row!, ...data };
        return { count: 1 };
      }
      return { count: 0 };
    });
    const report = await moveCoversBeforeDelete(f.tx, T, "u-owner", "c-adults", ["s-thu"], slotMovesOf([{ dayOfWeek: wd, startTime: "19:00" }], [{ dayOfWeek: wd, startTime: "19:30" }]));
    expect(report).toEqual({ moved: 1, closed: [] });
    expect(calls[0]).toMatchObject({ where: { id: "cov-old", classInstanceId: "s-new" }, data: { classInstanceId: null } });
    expect(f.state.row).toMatchObject({ classInstanceId: "s-new", status: "open" });
    expect(audits[0]).toMatchObject({ action: "class.cover_moved", entityId: "s-new", metadata: { previousStartTime: "19:00", startTime: "19:30" } });
  });

  it("a cover is never carried to a replacement that has already started: it is closed as replacement_started", async () => {
    const wd = THU.getUTCDay();
    const f = fakeTx({ row: coveredRow("u-sam") });
    f.raw.classInstance.findMany.mockResolvedValueOnce([{ id: "s-early", date: THU, startTime: "07:00", endTime: "08:00", cover: null }]);
    const report = await moveCoversBeforeDelete(f.tx, T, "u-owner", "c-adults", ["s-thu"], slotMovesOf([{ dayOfWeek: wd, startTime: "19:00" }], [{ dayOfWeek: wd, startTime: "07:00" }]), "Europe/London", new Date("2031-12-04T12:00:00Z"));
    expect(report.closed).toEqual([{ date: THU.toISOString(), startTime: "19:00", closedReason: "replacement_started" }]);
    expect(f.state.row).toMatchObject({ status: "closed", classInstanceId: null });
  });
});

describe("a deactivated regular coach (round 2)", () => {
  const cls = { coachName: null, coachUserId: "u-alex", coachUser: { id: "u-alex", name: "Alex Regular", deactivatedAt: new Date("2031-01-01T00:00:00Z") } };
  it("is not shown as anyone's coach: no name to staff or members, and never Cover needed", () => {
    const t = resolveSessionTeacher(cls, null);
    expect(t).toMatchObject({ state: "regular", teacherUserId: null, teacherName: null, regularName: null });
    expect(staffCoachLabel(t)).toBeNull();
    expect(memberCoachLabel(t)).toBeNull();
  });
  it("a typed name on the class still shows", () => {
    expect(staffCoachLabel(resolveSessionTeacher({ ...cls, coachName: "Head coach" }, null))).toBe("Head coach");
  });
});

describe("review of 7d7b17df (round 3)", () => {
  // Alex (the regular coach) now covers an overlapping session elsewhere.
  const elsewhere = { ...session({ id: "s-other", classOver: { id: "c-o", name: "Open Mat", coachUserId: null, coachUser: null, location: "Mat 3", mat: { name: "Mat 3" } } }), cover: { status: "covered", coverUserId: "u-alex" } };

  it("withdraw and return of an OPEN request (as a deactivation leaves it) are refused when the regular coach is busy", async () => {
    for (const action of ["withdraw", "return"] as const) {
      const f = fakeTx({ row: openRow(), candidates: [elsewhere] });
      const out = await applyCoverAction(f.tx, as("u-owner"), "s-thu", { action }, NOW);
      expect(out, action).toMatchObject({ ok: false, code: "REGULAR_COACH_BUSY", conflict: { instanceId: "s-other" } });
      expect(f.state.row).toMatchObject({ status: "open", coverUserId: null });
      expect(audits).toEqual([]);
    }
  });

  it("round 4, nit 1: withdraw and return of an OPEN request are allowed when the regular coach only heads another class at the same time", async () => {
    // Alex's own Kids class at the same time: the regular-versus-regular overlap the class form allows.
    const ownKids = { ...session({ id: "s-kids", classOver: { id: "c-kids", name: "Kids BJJ" } }), cover: null };
    for (const action of ["withdraw", "return"] as const) {
      const f = fakeTx({ row: openRow(), candidates: [ownKids] });
      expect(await applyCoverAction(f.tx, as("u-owner"), "s-thu", { action }, NOW), action).toMatchObject({ ok: true, cover: null });
    }
    // The query asks only for sessions Alex covers.
    const g = fakeTx({ row: openRow(), candidates: [ownKids] });
    await applyCoverAction(g.tx, as("u-owner"), "s-thu", { action: "withdraw" }, NOW);
    expect(g.raw.classInstance.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: [{ cover: { is: { tenantId: T, status: "covered", coverUserId: "u-alex" } } }] }) }));
  });

  it("round 4, nit 1: a COVERED row keeps the round-3 rule: Alex's own simultaneous class still refuses withdraw and return", async () => {
    const ownKids = { ...session({ id: "s-kids", classOver: { id: "c-kids", name: "Kids BJJ" } }), cover: null };
    for (const action of ["withdraw", "return"] as const) {
      const f = fakeTx({ row: coveredRow("u-sam"), candidates: [ownKids] });
      expect(await applyCoverAction(f.tx, as("u-owner"), "s-thu", { action }, NOW), action).toMatchObject({ ok: false, code: "REGULAR_COACH_BUSY", conflict: { instanceId: "s-kids" } });
      expect(f.state.row).toMatchObject({ status: "covered", coverUserId: "u-sam" });
    }
  });

  it("withdraw and return of an open request still work when the regular coach is free", async () => {
    const w = fakeTx({ row: openRow() });
    expect(await applyCoverAction(w.tx, as("u-owner"), "s-thu", { action: "withdraw" }, NOW)).toMatchObject({ ok: true, cover: null });
    const r = fakeTx({ row: openRow() });
    expect(await applyCoverAction(r.tx, as("u-owner"), "s-thu", { action: "return" }, NOW)).toMatchObject({ ok: true, cover: null });
  });

  it("give up, withdraw and return refuse when the regular coach changed between the plain read and the session lock", async () => {
    for (const [action, who] of [["withdraw", "u-owner"], ["return", "u-owner"], ["give_up", "u-sam"]] as const) {
      const f = fakeTx({ row: coveredRow("u-sam") });
      // The plain read named Alex (whose lock was taken); by the time the session was locked, Kim was the regular coach.
      f.raw.classInstance.findFirst.mockResolvedValueOnce(session());
      f.raw.classInstance.findFirst.mockResolvedValueOnce(session({ classOver: { coachUserId: "u-kim", coachUser: { id: "u-kim", name: "Kim Coach", deactivatedAt: null } } }));
      const out = await applyCoverAction(f.tx, as(who), "s-thu", { action }, NOW);
      expect(out, action).toMatchObject({ ok: false, status: 409, code: "CHANGED" });
      expect(f.state.row).toMatchObject({ status: "covered", coverUserId: "u-sam" });
    }
  });

  it("an end-time edit flags a future covered session but not one already under way", async () => {
    const during = new Date("2031-12-04T19:30:00Z"); // 19:30 in London on that Thursday: the 19:00 session has started
    const started = fakeTx({ row: coveredRow("u-sam") });
    await flagCoversForRetime(started.tx, T, "u-owner", "c-adults", ["s-thu"], "21:00", "Europe/London", during);
    expect(started.state.row).toMatchObject({ status: "covered", needsReconfirm: false });
    expect(audits).toEqual([]);
    const future = fakeTx({ row: coveredRow("u-sam") });
    await flagCoversForRetime(future.tx, T, "u-owner", "c-adults", ["s-thu"], "21:00", "Europe/London", NOW);
    expect(future.state.row).toMatchObject({ status: "covered", needsReconfirm: true });
    expect(audits.map((a) => a.action)).toEqual(["class.cover_reconfirm_flagged"]);
  });
});
