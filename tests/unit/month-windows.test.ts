/**
 * T2c (17 Oct 2026): the Analysis page's month windows are half-open.
 *
 * Analysis used to close last month at `lte 00:00 on its last day`, so a
 * member who joined at 18:00 on 30 September counted in neither September
 * nor October. `monthWindows(now)` is pure; these cases drive it with
 * synthetic instants in the UK zone, across both British Summer Time
 * changeovers, and check membership with the same `gte start, lt end` the
 * page's queries use.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { monthWindows } from "@/lib/month-windows";

const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => { process.env.TZ = "Europe/London"; });
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const utc = (iso: string) => new Date(iso);
const inHalfOpen = (at: Date, start: Date, end: Date) => at.getTime() >= start.getTime() && at.getTime() < end.getTime();

describe("monthWindows(now) — half-open calendar months", () => {
  it("runs in the UK zone (precondition: BST is UTC+1 in July)", () => {
    expect(new Date(Date.UTC(2026, 6, 1, 12)).getTimezoneOffset()).toBe(-60);
    expect(new Date(Date.UTC(2026, 0, 1, 12)).getTimezoneOffset()).toBe(0);
  });

  it("October during BST: this month and last month start at UK midnight on the 1st", () => {
    const w = monthWindows(utc("2026-10-17T10:00:00Z"));
    expect(w.startOfMonth.toISOString()).toBe("2026-09-30T23:00:00.000Z");
    expect(w.startOfLastMonth.toISOString()).toBe("2026-08-31T23:00:00.000Z");
    expect(w.sixMonthsAgo.toISOString()).toBe("2026-04-30T23:00:00.000Z");
  });

  it("a member who joined at 18:00 on the last day of last month is in last month — the case the old lte bucket dropped", () => {
    const now = utc("2026-10-17T10:00:00Z");
    const { startOfMonth, startOfLastMonth } = monthWindows(now);
    const joined = utc("2026-09-30T17:00:00Z"); // 18:00 BST, 30 Sep
    expect(inHalfOpen(joined, startOfLastMonth, startOfMonth)).toBe(true);
    expect(joined.getTime() >= startOfMonth.getTime()).toBe(false);
    // The old bucket ended at 00:00 on 30 Sep, so this join fell outside it.
    const oldEndOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    expect(joined.getTime() <= oldEndOfLastMonth.getTime()).toBe(false);
  });

  it("one minute before UK midnight on the last day is last month; UK midnight on the 1st is this month", () => {
    const { startOfMonth, startOfLastMonth } = monthWindows(utc("2026-10-17T10:00:00Z"));
    expect(inHalfOpen(utc("2026-09-30T22:59:00Z"), startOfLastMonth, startOfMonth)).toBe(true);
    const firstOfMonth = utc("2026-09-30T23:00:00Z"); // 00:00 BST, 1 Oct
    expect(inHalfOpen(firstOfMonth, startOfLastMonth, startOfMonth)).toBe(false);
    expect(firstOfMonth.getTime() >= startOfMonth.getTime()).toBe(true);
  });

  it("on the 1st itself, last month is the whole previous month", () => {
    const { startOfMonth, startOfLastMonth } = monthWindows(utc("2026-10-01T06:00:00Z"));
    expect(startOfMonth.toISOString()).toBe("2026-09-30T23:00:00.000Z");
    expect(startOfLastMonth.toISOString()).toBe("2026-08-31T23:00:00.000Z");
  });

  it("autumn changeover (clocks back 25 Oct): November's last month starts at BST midnight and ends at GMT midnight", () => {
    const { startOfMonth, startOfLastMonth } = monthWindows(utc("2026-11-05T12:00:00Z"));
    expect(startOfMonth.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(startOfLastMonth.toISOString()).toBe("2026-09-30T23:00:00.000Z");
    // 23:30 GMT on 31 Oct is still October.
    expect(inHalfOpen(utc("2026-10-31T23:30:00Z"), startOfLastMonth, startOfMonth)).toBe(true);
  });

  it("spring changeover (clocks forward 29 Mar): a join at 23:30 BST on 31 Mar is March", () => {
    const { startOfMonth, startOfLastMonth } = monthWindows(utc("2026-04-10T12:00:00Z"));
    expect(startOfMonth.toISOString()).toBe("2026-03-31T23:00:00.000Z");
    expect(startOfLastMonth.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(inHalfOpen(utc("2026-03-31T22:30:00Z"), startOfLastMonth, startOfMonth)).toBe(true);
  });

  it("January rolls last month back into December of the previous year", () => {
    const { startOfMonth, startOfLastMonth, sixMonthsAgo } = monthWindows(utc("2026-01-15T12:00:00Z"));
    expect(startOfMonth.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(startOfLastMonth.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(sixMonthsAgo.toISOString()).toBe("2025-07-31T23:00:00.000Z");
  });
});
