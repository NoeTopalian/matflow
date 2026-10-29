/**
 * Attendance coverage (owner rule, 28 Oct 2026): "Missing attendance coverage
 * must not automatically become a claim that nobody attended." The pure rule
 * in lib/attendance-coverage.ts: where a club's records start (club-local
 * day), how a span relates to it, and the exact words each case shows.
 */
import { describe, it, expect, vi } from "vitest";
import {
  attendanceCoverageFor,
  bucketNote,
  clubDayStart,
  comparisonGap,
  coverageNote,
  coverageOf,
  noRecordsNote,
  partialNote,
  readAttendanceCoverageStart,
} from "@/lib/attendance-coverage";

const LONDON = "Europe/London";
// 3 Mar 2026 is GMT in London: midnight is 00:00Z.
const START = "2026-03-03T00:00:00.000Z";
const AT = { start: START, timeZone: LONDON };

describe("clubDayStart", () => {
  it("is midnight on the club's wall clock, not the server's", () => {
    // 23:30Z on 2 Jul is 00:30 on 3 Jul in London (BST): the day is 3 Jul, starting 23:00Z on 2 Jul.
    expect(clubDayStart(new Date("2026-07-02T23:30:00.000Z"), LONDON).toISOString()).toBe("2026-07-02T23:00:00.000Z");
    // The same instant is still 2 Jul in New York.
    expect(clubDayStart(new Date("2026-07-02T23:30:00.000Z"), "America/New_York").toISOString()).toBe("2026-07-02T04:00:00.000Z");
  });
});

describe("coverageOf", () => {
  it("no records at all is none", () => {
    expect(coverageOf(null, "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z")).toBe("none");
  });
  it("a span that ends on or before the start is before (half-open)", () => {
    expect(coverageOf(START, "2026-02-01T00:00:00.000Z", START)).toBe("before");
  });
  it("a span the start falls inside is partial", () => {
    expect(coverageOf(START, "2026-03-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z")).toBe("partial");
  });
  it("a span that starts on the start day is covered", () => {
    expect(coverageOf(START, START, "2026-04-01T00:00:00.000Z")).toBe("covered");
  });
});

describe("the words", () => {
  it("no records at all", () => {
    expect(noRecordsNote({ start: null, timeZone: LONDON }, "none")).toBe("No attendance recorded yet");
    expect(bucketNote({ start: null, timeZone: LONDON }, "none")).toBe("No attendance recorded yet");
  });
  it("a period wholly before the records start", () => {
    expect(noRecordsNote(AT, "before")).toBe("No attendance records for this period (MatFlow's records start 3 Mar 2026)");
    expect(bucketNote(AT, "before")).toBe("No records (MatFlow's records start 3 Mar 2026)");
    expect(comparisonGap("before")).toBe("— (no records for the period before)");
  });
  it("a period that straddles the start", () => {
    expect(partialNote(AT, "partial")).toBe("Records start 3 Mar 2026");
    expect(coverageNote(AT, "partial")).toBe("Records start 3 Mar 2026");
    expect(bucketNote(AT, "partial")).toBe("Partly covered (records start 3 Mar 2026)");
    expect(comparisonGap("partial")).toBe("— (the period before is only partly covered)");
  });
  it("a covered period has no note, so a zero there is a real zero", () => {
    expect(coverageNote(AT, "covered")).toBeNull();
    expect(bucketNote(AT, "covered")).toBeNull();
    expect(comparisonGap("covered")).toBeNull();
  });
});

describe("readAttendanceCoverageStart", () => {
  it("asks for this club's earliest record of any method and returns its club-local day", async () => {
    const findFirst = vi.fn().mockResolvedValue({ checkInTime: new Date("2026-03-03T18:45:00.000Z") });
    const start = await readAttendanceCoverageStart({ attendanceRecord: { findFirst } }, "tenant-a", LONDON);
    expect(findFirst).toHaveBeenCalledWith({ where: { tenantId: "tenant-a" }, orderBy: { checkInTime: "asc" }, select: { checkInTime: true } });
    expect(start?.toISOString()).toBe(START);
  });
  it("a club with no records has no coverage", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    expect(await readAttendanceCoverageStart({ attendanceRecord: { findFirst } }, "tenant-a", LONDON)).toBeNull();
  });
});

describe("attendanceCoverageFor", () => {
  it("states the period and the run before it", () => {
    expect(
      attendanceCoverageFor(new Date(START), LONDON, { start: "2026-02-01T00:00:00.000Z", end: "2026-05-01T00:00:00.000Z" }, { start: "2025-11-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" }),
    ).toEqual({ start: START, timeZone: LONDON, period: "partial", previous: "before" });
  });
});
