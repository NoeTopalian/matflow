// Session cover (26 Nov 2026): the one resolver of who teaches a dated session, and what staff and members read.
import { describe, it, expect } from "vitest";
import {
  COACH_TO_BE_CONFIRMED,
  clashLabel,
  isMySession,
  memberCoachLabel,
  resolveSessionTeacher,
  staffCoachLabel,
  staffCoachLine,
  type CoverSnapshot,
  type TeacherClash,
} from "@/lib/session-coach";

const linked = { coachName: null, coachUserId: "u-alex", coachUser: { id: "u-alex", name: "Alex Regular" } };
const typedOnly = { coachName: "Terry Typed", coachUserId: null, coachUser: null };
const none = { coachName: null, coachUserId: null, coachUser: null };
const open: CoverSnapshot = { status: "open", coverUserId: null, coverUserName: null, needsReconfirm: false };
const covered: CoverSnapshot = { status: "covered", coverUserId: "u-sam", coverUserName: "Sam Cover", needsReconfirm: false };

describe("resolveSessionTeacher", () => {
  it("no cover row: the regular coach — the linked staff member, else the typed name", () => {
    expect(resolveSessionTeacher(linked, null)).toMatchObject({ state: "regular", teacherUserId: "u-alex", teacherName: "Alex Regular" });
    expect(resolveSessionTeacher(typedOnly, undefined)).toMatchObject({ state: "regular", teacherUserId: null, teacherName: "Terry Typed" });
    expect(resolveSessionTeacher(none, null)).toMatchObject({ state: "regular", teacherUserId: null, teacherName: null });
  });

  it("an accepted cover: the covering coach teaches it, and the regular coach is kept as the regular", () => {
    expect(resolveSessionTeacher(linked, covered)).toMatchObject({ state: "covered", teacherUserId: "u-sam", teacherName: "Sam Cover", regularName: "Alex Regular" });
  });

  it("an open request before the session starts: nobody is confirmed", () => {
    expect(resolveSessionTeacher(linked, open)).toMatchObject({ state: "cover_needed", teacherUserId: null, teacherName: null, regularName: "Alex Regular" });
  });

  it("an open request whose session has started is treated as closed: the regular coach again", () => {
    expect(resolveSessionTeacher(linked, open, { started: true })).toMatchObject({ state: "regular", teacherUserId: "u-alex" });
  });

  it("a withdrawn or closed row changes nothing", () => {
    for (const status of ["withdrawn", "closed"]) {
      expect(resolveSessionTeacher(linked, { status, coverUserId: null, coverUserName: null, needsReconfirm: false }).state).toBe("regular");
    }
  });

  it("a typed coach name never names the signed-in teacher", () => {
    expect(resolveSessionTeacher(typedOnly, null).teacherUserId).toBeNull();
  });
});

describe("what staff read", () => {
  it("Covered by [name]; Cover needed with the regular coach marked as away; the regular coach otherwise", () => {
    expect(staffCoachLabel(resolveSessionTeacher(linked, covered))).toBe("Covered by Sam Cover");
    expect(staffCoachLabel(resolveSessionTeacher(linked, open))).toBe("Cover needed · Alex Regular away");
    expect(staffCoachLabel(resolveSessionTeacher(none, open))).toBe("Cover needed");
    expect(staffCoachLabel(resolveSessionTeacher(linked, null))).toBe("Alex Regular");
    expect(staffCoachLabel(resolveSessionTeacher(none, null))).toBeNull();
  });

  it("a covered session whose time changed says it needs reconfirming", () => {
    expect(staffCoachLabel(resolveSessionTeacher(linked, { ...covered!, needsReconfirm: true }))).toBe("Covered by Sam Cover · Awaiting reconfirmation");
  });
});

describe("what members read", () => {
  it("the confirmed covering coach once cover is accepted", () => {
    expect(memberCoachLabel(resolveSessionTeacher(linked, covered))).toBe("Sam Cover");
  });

  it("Coach to be confirmed while cover is open: never the unavailable regular coach, never the request", () => {
    const label = memberCoachLabel(resolveSessionTeacher(linked, open));
    expect(label).toBe(COACH_TO_BE_CONFIRMED);
    expect(label).not.toMatch(/Alex|cover|away|request/i);
  });

  it("a covered session waiting for its coach to reconfirm is not presented as confirmed", () => {
    expect(memberCoachLabel(resolveSessionTeacher(linked, { ...covered!, needsReconfirm: true }))).toBe(COACH_TO_BE_CONFIRMED);
  });

  it("no cover: the regular coach, as before", () => {
    expect(memberCoachLabel(resolveSessionTeacher(linked, null))).toBe("Alex Regular");
    expect(memberCoachLabel(resolveSessionTeacher(typedOnly, null))).toBe("Terry Typed");
  });
});

describe("the Yours highlight on Mark attendance", () => {
  it("moves to the confirmed covering coach and off the regular coach", () => {
    expect(isMySession("u-sam", linked, covered)).toBe(true);
    expect(isMySession("u-alex", linked, covered)).toBe(false);
  });
  it("is nobody's while a covered session awaits reconfirmation after a time change", () => {
    const awaiting = { ...covered!, needsReconfirm: true };
    expect(isMySession("u-sam", linked, awaiting)).toBe(false);
    expect(isMySession("u-alex", linked, awaiting)).toBe(false);
  });
  it("stays the regular coach's while cover is only requested, and a typed name never makes it anyone's", () => {
    expect(isMySession("u-alex", linked, open)).toBe(true);
    expect(isMySession("u-terry", typedOnly, null)).toBe(false);
  });
});

// Round 4 (review of 121529e4): one person on two overlapping sessions, one of them a cover (lib/session-clash.ts).
describe("a clash", () => {
  // Alex Regular covers Life Elsewhere, which overlaps Alex's own class.
  const regularSide: TeacherClash = { side: "regular", teacherName: "Alex Regular", otherIsCover: true, instanceId: "s-else", className: "Life Elsewhere", label: "Thursday 7 April, 19:30–21:00, Mat 10" };
  const coverSide: TeacherClash = { side: "cover", teacherName: "Sam Cover", otherIsCover: false, instanceId: "s-own", className: "Sam Own", label: "Thursday 7 April, 19:00–20:30, Mat 9" };
  const FLAG = "Clash: Alex Regular is also teaching Life Elsewhere on Thursday 7 April, 19:30–21:00, Mat 10";

  it("should-fix 1: an open request that has started, its regular coach covering elsewhere, is not resolved to that coach", () => {
    const t = resolveSessionTeacher(linked, open, { started: true, clash: regularSide });
    expect(t).toMatchObject({ state: "regular", teacherName: null, teacherUserId: "u-alex", clash: regularSide });
    expect(staffCoachLabel(t)).toBe(COACH_TO_BE_CONFIRMED);
    expect(clashLabel(t)).toBe(FLAG);
    expect(memberCoachLabel(t)).toBe(COACH_TO_BE_CONFIRMED);
  });

  it("before the start the open request still reads Cover needed, now with the flag; members read Coach to be confirmed", () => {
    const t = resolveSessionTeacher(linked, open, { clash: regularSide });
    expect(staffCoachLabel(t)).toBe("Cover needed · Alex Regular away");
    expect(staffCoachLine(t)).toBe(`Cover needed · Alex Regular away · ${FLAG}`);
    expect(memberCoachLabel(t)).toBe(COACH_TO_BE_CONFIRMED);
  });

  it("should-fix 2: a plain regular session (no cover row) whose coach covers an overlapping session", () => {
    const t = resolveSessionTeacher(linked, null, { clash: regularSide });
    expect(staffCoachLine(t)).toBe(`${COACH_TO_BE_CONFIRMED} · ${FLAG}`);
    expect(memberCoachLabel(t)).toBe(COACH_TO_BE_CONFIRMED);
  });

  it("the accepted cover's side keeps its coach for members and carries the flag for staff", () => {
    const t = resolveSessionTeacher(linked, covered, { clash: coverSide });
    expect(staffCoachLabel(t)).toBe("Covered by Sam Cover");
    expect(clashLabel(t)).toBe("Clash: Sam Cover is also teaching Sam Own on Thursday 7 April, 19:00–20:30, Mat 9");
    expect(memberCoachLabel(t)).toBe("Sam Cover");
  });

  it("when both sides are covers, members see neither as confirmed", () => {
    expect(memberCoachLabel(resolveSessionTeacher(linked, covered, { clash: { ...coverSide, otherIsCover: true } }))).toBe(COACH_TO_BE_CONFIRMED);
  });

  it("no clash: nothing changes and there is no flag", () => {
    const t = resolveSessionTeacher(linked, null);
    expect(t.clash).toBeNull();
    expect(clashLabel(t)).toBeNull();
    expect(staffCoachLine(t)).toBe("Alex Regular");
  });

  it("the Yours highlight: the coach still sees both sessions as theirs", () => {
    expect(isMySession("u-alex", linked, open)).toBe(true);
    expect(isMySession("u-alex", linked, null)).toBe(true);
    expect(isMySession("u-alex", { coachUserId: null }, { status: "covered", coverUserId: "u-alex", coverUserName: "Alex Regular", needsReconfirm: false })).toBe(true);
  });
});
