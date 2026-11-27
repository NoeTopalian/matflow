// Session cover, round 4 (review of 121529e4, should-fix 1 and 2): the read-time check that flags one person shown
// teaching two overlapping sessions where at least one of the two is a cover (lib/session-clash.ts).
import { describe, it, expect, vi } from "vitest";
import { clashesAmong, loadTeacherClashes, type ClashSession } from "@/lib/session-clash";

const TZ = "Europe/London";
const THU = new Date("2034-01-05T00:00:00Z");
const FRI = new Date("2034-01-06T00:00:00Z");

type Coach = { id: string; name: string; deactivatedAt: Date | null };
const alex: Coach = { id: "u-alex", name: "Alex Regular", deactivatedAt: null };
function s(id: string, startTime: string, endTime: string, over: { coach?: Coach | null; cover?: ClashSession["cover"]; name?: string; mat?: string; date?: Date; isCancelled?: boolean; isActive?: boolean; deletedAt?: Date | null } = {}): ClashSession {
  return {
    id,
    date: over.date ?? THU,
    startTime,
    endTime,
    isCancelled: over.isCancelled ?? false,
    class: {
      name: over.name ?? `Class ${id}`,
      location: null,
      duration: 60,
      isActive: over.isActive ?? true,
      deletedAt: over.deletedAt ?? null,
      coachUser: over.coach === undefined ? alex : over.coach,
      mat: { name: over.mat ?? "Mat 1" },
    },
    cover: over.cover ?? null,
  };
}
const coveredBy = (userId: string, name: string): ClashSession["cover"] => ({ status: "covered", coverUserId: userId, coverUser: { name } });

describe("clashesAmong", () => {
  it("Alex's own class and a session Alex covers at the same time: both flagged, each naming the other", () => {
    const own = s("own", "19:00", "20:30", { name: "Kids BJJ", mat: "Mat 1" });
    const elsewhere = s("else", "19:30", "21:00", { coach: null, cover: coveredBy("u-alex", "Alex Regular"), name: "Adults Gi", mat: "Mat 2" });
    const out = clashesAmong([own, elsewhere], [own, elsewhere], TZ);
    expect(out.get("own")).toEqual({ side: "regular", teacherName: "Alex Regular", otherIsCover: true, instanceId: "else", className: "Adults Gi", label: "Thursday 5 January, 19:30–21:00, Mat 2" });
    expect(out.get("else")).toEqual({ side: "cover", teacherName: "Alex Regular", otherIsCover: false, instanceId: "own", className: "Kids BJJ", label: "Thursday 5 January, 19:00–20:30, Mat 1" });
  });

  it("an OPEN request does not release the regular coach: their open session clashes with the one they cover", () => {
    const open = s("open", "19:00", "20:30", { cover: { status: "open", coverUserId: null, coverUser: null } });
    const elsewhere = s("else", "19:00", "20:30", { coach: null, cover: coveredBy("u-alex", "Alex Regular") });
    expect(clashesAmong([open], [open, elsewhere], TZ).get("open")).toMatchObject({ side: "regular", instanceId: "else" });
  });

  it("back to back (one ends as the other starts) is not a clash", () => {
    const own = s("own", "19:00", "20:00");
    const after = s("after", "20:00", "21:00", { coach: null, cover: coveredBy("u-alex", "Alex Regular") });
    expect(clashesAmong([own, after], [own, after], TZ).size).toBe(0);
  });

  it("two classes of the same regular coach at once, no cover: not flagged (the class form allows it)", () => {
    const a = s("a", "19:00", "20:30");
    const b = s("b", "19:00", "20:30");
    expect(clashesAmong([a, b], [a, b], TZ).size).toBe(0);
  });

  it("Alex's class covered by someone else is not Alex's: no clash with the session Alex covers", () => {
    const own = s("own", "19:00", "20:30", { cover: coveredBy("u-sam", "Sam Cover") });
    const elsewhere = s("else", "19:00", "20:30", { coach: null, cover: coveredBy("u-alex", "Alex Regular") });
    expect(clashesAmong([own, elsewhere], [own, elsewhere], TZ).size).toBe(0);
  });

  it("a cancelled session, a paused or archived class, a deactivated regular coach, or another day: no clash", () => {
    const elsewhere = s("else", "19:00", "20:30", { coach: null, cover: coveredBy("u-alex", "Alex Regular") });
    for (const other of [
      s("x", "19:00", "20:30", { isCancelled: true }),
      s("x", "19:00", "20:30", { isActive: false }),
      s("x", "19:00", "20:30", { deletedAt: new Date("2033-01-01T00:00:00Z") }),
      s("x", "19:00", "20:30", { coach: { ...alex, deactivatedAt: new Date("2033-01-01T00:00:00Z") } }),
      s("x", "19:00", "20:30", { date: FRI }),
    ]) {
      expect(clashesAmong([elsewhere, other], [elsewhere, other], TZ).size).toBe(0);
    }
  });

  it("two sessions both covered by the same person clash, each side a cover", () => {
    const a = s("a", "19:00", "20:30", { coach: null, cover: coveredBy("u-alex", "Alex Regular") });
    const b = s("b", "20:00", "21:00", { coach: null, cover: coveredBy("u-alex", "Alex Regular") });
    expect(clashesAmong([a], [a, b], TZ).get("a")).toMatchObject({ side: "cover", otherIsCover: true, instanceId: "b" });
  });
});

describe("loadTeacherClashes", () => {
  function fakeTx(shown: ClashSession[], pool: ClashSession[]) {
    const calls: Array<Record<string, unknown>> = [];
    const tx = {
      classInstance: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          calls.push(where);
          return calls.length === 1 ? shown : pool;
        }),
      },
      tenant: { findUnique: vi.fn(async () => ({ timezone: TZ })) },
    };
    return { tx: tx as never, calls, raw: tx };
  }

  it("two queries for every session on screen, both scoped to the club; the second asks only for what could clash", async () => {
    const own = s("own", "19:00", "20:30");
    const elsewhere = s("else", "19:30", "21:00", { coach: null, cover: coveredBy("u-alex", "Alex Regular") });
    const f = fakeTx([own], [elsewhere]);
    const out = await loadTeacherClashes(f.tx, "tenant-1", ["own"], TZ);
    expect(out.get("own")).toMatchObject({ instanceId: "else" });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]).toMatchObject({ id: { in: ["own"] }, isCancelled: false, class: { tenantId: "tenant-1", isActive: true, deletedAt: null } });
    expect(f.calls[1]).toMatchObject({ isCancelled: false, class: { tenantId: "tenant-1", isActive: true, deletedAt: null } });
    // No session on screen is a cover, so only sessions covered by its teacher are asked for (tenant-scoped).
    expect(f.calls[1].OR).toEqual([{ cover: { is: { tenantId: "tenant-1", status: "covered", coverUserId: { in: ["u-alex"] } } } }]);
    expect(f.raw.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("a session on screen that is a cover also asks for its coach's own classes", async () => {
    const elsewhere = s("else", "19:30", "21:00", { coach: null, cover: coveredBy("u-alex", "Alex Regular") });
    const f = fakeTx([elsewhere], []);
    await loadTeacherClashes(f.tx, "tenant-1", ["else"], TZ);
    expect(f.calls[1].OR).toEqual([
      { cover: { is: { tenantId: "tenant-1", status: "covered", coverUserId: { in: ["u-alex"] } } } },
      { class: { coachUserId: { in: ["u-alex"] } } },
    ]);
  });

  it("one query when nobody teaches the sessions on screen, none for an empty screen; the zone is read only when needed", async () => {
    const f = fakeTx([s("nobody", "19:00", "20:00", { coach: null })], []);
    expect((await loadTeacherClashes(f.tx, "tenant-1", ["nobody"])).size).toBe(0);
    expect(f.calls).toHaveLength(1);
    const g = fakeTx([], []);
    expect((await loadTeacherClashes(g.tx, "tenant-1", [])).size).toBe(0);
    expect(g.calls).toHaveLength(0);
    const own = s("own", "19:00", "20:30");
    const h = fakeTx([own], [s("else", "19:30", "21:00", { coach: null, cover: coveredBy("u-alex", "Alex Regular") })]);
    await loadTeacherClashes(h.tx, "tenant-1", ["own"]);
    expect(h.raw.tenant.findUnique).toHaveBeenCalledWith({ where: { id: "tenant-1" }, select: { timezone: true } });
  });
});
