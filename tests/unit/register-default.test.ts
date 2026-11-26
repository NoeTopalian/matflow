// Which session the staff register opens on, with a fixed club clock
// (25 Nov 2026). Times are minutes of the club's day turned into instants, so
// each case reads as a time on the wall of the club.
import { describe, expect, it } from "vitest";
import { countRunning, pickRegisterSession, type RegisterPickSession } from "@/lib/register-default";

const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h * 60 + m) * 60_000;
};
const s = (id: string, start: string, end: string | null, extra: Partial<RegisterPickSession> = {}): RegisterPickSession => ({
  id, start: at(start), end: end === null ? null : at(end), isCancelled: false, isMine: false, matOrder: null, ...extra,
});

const DAY = [
  s("am", "06:30", "07:30"),
  s("noon", "12:00", "13:00"),
  s("five", "17:00", "18:00"),
  s("six", "18:00", "19:00"),
  s("late", "19:30", "20:30"),
];

describe("pickRegisterSession", () => {
  it("before opening: the first class, as up next", () => {
    expect(pickRegisterSession(DAY, at("05:00"))).toEqual({ id: "am", reason: "up_next" });
  });

  it("during a class: that class, as on now", () => {
    expect(pickRegisterSession(DAY, at("12:30"))).toEqual({ id: "noon", reason: "on_now" });
    // The first minute counts.
    expect(pickRegisterSession(DAY, at("12:00"))).toEqual({ id: "noon", reason: "on_now" });
  });

  it("at the exact boundary between back-to-back classes: the one starting, not the one ending", () => {
    expect(pickRegisterSession(DAY, at("18:00"))).toEqual({ id: "six", reason: "on_now" });
    // One minute earlier it is still the first.
    expect(pickRegisterSession(DAY, at("17:59"))).toEqual({ id: "five", reason: "on_now" });
  });

  it("in a gap: the next class to start, never the one just finished", () => {
    expect(pickRegisterSession(DAY, at("13:00"))).toEqual({ id: "five", reason: "up_next" });
    expect(pickRegisterSession(DAY, at("19:10"))).toEqual({ id: "late", reason: "up_next" });
  });

  it("after closing: the class that ended most recently, which need not be the one that started last", () => {
    expect(pickRegisterSession(DAY, at("22:00"))).toEqual({ id: "late", reason: "last_today" });
    const day = [s("long", "17:00", "21:00"), s("short", "19:00", "20:00")];
    expect(pickRegisterSession(day, at("21:30"))).toEqual({ id: "long", reason: "last_today" });
  });

  it("two classes on now on two mats: the signed-in coach's own first", () => {
    const day = [s("a", "18:00", "19:00", { matOrder: 0 }), s("b", "18:00", "19:00", { matOrder: 1, isMine: true })];
    expect(pickRegisterSession(day, at("18:20"))).toEqual({ id: "b", reason: "on_now" });
    expect(countRunning(day, at("18:20"))).toBe(2);
  });

  it("two on now, neither the coach's: the one that started most recently, then the club's mat order, then the id", () => {
    const overlap = [s("early", "17:30", "19:00", { matOrder: 0 }), s("recent", "18:00", "19:00", { matOrder: 1 })];
    expect(pickRegisterSession(overlap, at("18:20"))?.id).toBe("recent");
    const together = [s("z", "18:00", "19:00", { matOrder: 1 }), s("y", "18:00", "19:00", { matOrder: 0 }), s("x", "18:00", "19:00")];
    expect(pickRegisterSession(together, at("18:20"))?.id).toBe("y");
    const sameMat = [s("b", "18:00", "19:00", { matOrder: 0 }), s("a", "18:00", "19:00", { matOrder: 0 })];
    expect(pickRegisterSession(sameMat, at("18:20"))?.id).toBe("a");
  });

  it("several start together next: the coach's own, then mat order", () => {
    const day = [s("m2", "18:00", "19:00", { matOrder: 1 }), s("m1", "18:00", "19:00", { matOrder: 0 }), s("later", "19:00", "20:00", { isMine: true })];
    expect(pickRegisterSession(day, at("17:00"))).toEqual({ id: "m1", reason: "up_next" });
    expect(pickRegisterSession([...day.slice(0, 2), s("mine", "18:00", "19:00", { matOrder: 2, isMine: true })], at("17:00"))?.id).toBe("mine");
  });

  it("never a cancelled class; nothing eligible gives no choice", () => {
    const day = [s("off", "18:00", "19:00", { isCancelled: true }), s("next", "20:00", "21:00")];
    expect(pickRegisterSession(day, at("18:20"))).toEqual({ id: "next", reason: "up_next" });
    expect(countRunning(day, at("18:20"))).toBe(0);
    expect(pickRegisterSession([s("off", "18:00", "19:00", { isCancelled: true })], at("18:20"))).toBeNull();
    expect(pickRegisterSession([], at("18:20"))).toBeNull();
  });

  it("a session with no recorded end is never on now", () => {
    const day = [s("noend", "18:00", null), s("next", "20:00", "21:00")];
    expect(pickRegisterSession(day, at("18:20"))).toEqual({ id: "next", reason: "up_next" });
    expect(pickRegisterSession([s("noend", "18:00", null)], at("18:20"))).toEqual({ id: "noend", reason: "last_today" });
  });
});
