// Session cover (26 Nov 2026): the one resolver of who teaches a dated session, and what staff and members read.
import { describe, it, expect } from "vitest";
import {
  COACH_TO_BE_CONFIRMED,
  isMySession,
  memberCoachLabel,
  resolveSessionTeacher,
  staffCoachLabel,
  type CoverSnapshot,
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
