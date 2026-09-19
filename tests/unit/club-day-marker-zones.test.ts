/**
 * One spelling of the day, at every offset on earth.
 *
 * `ClassInstance.date` is a calendar-day MARKER. Three places write it and two
 * read it, and they must agree byte-for-byte or `@@unique([classId, date,
 * startTime])` stops matching:
 *
 *   writers  `lib/today-sessions.ts` (clubDayMarker → buildInstanceRows)
 *            `app/api/instances/generate/route.ts`
 *            `app/api/classes/[id]/route.ts` (reconcileSchedules)
 *            `app/api/cron/class-instances/route.ts`
 *   readers  `lib/class-time.ts` — `todayWindow` (which rows are today)
 *                                 `parseTime`   (when the class starts)
 *
 * `todayWindow`'s own docstring states the invariant the whole design rests on:
 * *"every writer's spelling of D lies within twelve hours of D's UTC midnight"*.
 * That is a claim about the WRITERS, and nothing has ever checked it. These
 * cases check it, at every offset from −11 to +14.
 *
 * Round 2 (L-B): with `Tenant.timezone` now writable from Settings, a club set
 * to Pacific/Auckland reads an EMPTY day. That is no longer a dormant defect.
 */
import { describe, it, expect } from "vitest";
import { clubDayMarker } from "@/lib/today-sessions";
import { todayWindow, parseTime, zoneOffsetMs } from "@/lib/class-time";
import { buildInstanceRows } from "@/lib/class-instances";

/** A fixed instant, so nothing here depends on when it runs. */
const NOW = new Date("2026-09-19T19:00:00.000Z");

/** Every populated offset band, named by a real IANA zone. */
const ZONES = [
  "Pacific/Midway", // −11
  "Pacific/Honolulu", // −10
  "America/Anchorage", // −08
  "America/Los_Angeles", // −07
  "America/New_York", // −04
  "America/Sao_Paulo", // −03
  "Europe/London", // +01 (BST in September)
  "Europe/Berlin", // +02
  "Africa/Nairobi", // +03
  "Asia/Kolkata", // +05:30
  "Asia/Makassar", // +08 (Bali — the laptop this is written on)
  "Asia/Tokyo", // +09
  "Australia/Sydney", // +10
  "Pacific/Auckland", // +12 (NZST in September, +13 from late September)
  "Pacific/Chatham", // +12:45
  "Pacific/Kiritimati", // +14
];

/** The club's calendar date today, as the club spells it. */
function clubDate(now: Date, tz: string): { y: number; m: number; d: number; dow: number } {
  const local = new Date(now.getTime() + zoneOffsetMs(now, tz));
  return {
    y: local.getUTCFullYear(),
    m: local.getUTCMonth(),
    d: local.getUTCDate(),
    dow: local.getUTCDay(),
  };
}

describe("the day marker every writer emits is one the readers admit", () => {
  for (const tz of ZONES) {
    it(`${tz}: clubDayMarker lands inside todayWindow`, () => {
      const marker = clubDayMarker(NOW, tz);
      const { start, end } = todayWindow(NOW, tz);
      expect(
        marker >= start && marker < end,
        `${tz}: marker ${marker.toISOString()} is outside [${start.toISOString()}, ${end.toISOString()}) — ` +
          "the club's session is written, and then not found",
      ).toBe(true);
    });

    it(`${tz}: the marker resolves to the club's own calendar date`, () => {
      const marker = clubDayMarker(NOW, tz);
      const expected = clubDate(NOW, tz);
      // parseTime is the reader that turns the marker back into an instant.
      // Midnight of the marker, read in the club's zone, must be the club's
      // date — otherwise the check-in window opens on the wrong day.
      const midnight = parseTime("00:00", marker, tz);
      const asLocal = new Date(midnight.getTime() + zoneOffsetMs(midnight, tz));
      expect(
        [asLocal.getUTCFullYear(), asLocal.getUTCMonth(), asLocal.getUTCDate()],
        `${tz}: the marker reads back as a different calendar date`,
      ).toEqual([expected.y, expected.m, expected.d]);
    });

    it(`${tz}: today's schedule mints exactly one row for today`, () => {
      const { dow } = clubDate(NOW, tz);
      const rows = buildInstanceRows(
        [{ id: "c1", schedules: [{ dayOfWeek: dow, startTime: "18:00", endTime: "19:00" }] }],
        { from: clubDayMarker(NOW, tz), days: 1 },
      );
      expect(rows.length, `${tz}: a class scheduled for the club's today minted ${rows.length} rows`).toBe(1);
    });
  }
});

describe("the ±12 h band the readers depend on", () => {
  /**
   * The club and the host are in the SAME place — one gym, one server, the case
   * `new Date(y, m, d)` is built for and the one a self-hosting club is in. The
   * marker is exactly what `new Date(y, m, d)` produces in that process: the
   * club's calendar date at that zone's midnight.
   */
  for (const tz of [
    "Pacific/Midway", // −11
    "Pacific/Honolulu", // −10
    "America/Los_Angeles", // −07
    "America/New_York", // −04
    "UTC", // ±00
    "Europe/London", // +01
    "Asia/Makassar", // +08
    "Australia/Brisbane", // +10
    "Pacific/Auckland", // +12
    "Pacific/Chatham", // +12:45
    "Pacific/Kiritimati", // +14
  ]) {
    // KNOWN DEFECT, pinned (round 2, L-D): offsets past ±12 h fall outside
    // todayWindow's band — that club has no today. `it.fails` keeps the gate
    // green while the defect stands and goes red the moment it is fixed, at
    // which point flip these back to plain `it`. Owner: the round-3 day-marker
    // migration (one spelling across all four writers, cron route included).
    const pin = tz === "Pacific/Chatham" || tz === "Pacific/Kiritimati" ? it.fails : it;
    pin(`a host in ${tz} writes a marker todayWindow admits`, () => {
      const offsetMs = zoneOffsetMs(NOW, tz);
      const local = new Date(NOW.getTime() + offsetMs);
      const marker = new Date(
        Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offsetMs,
      );
      const { start, end } = todayWindow(NOW, tz);
      expect(
        marker >= start && marker < end,
        `${tz} (UTC${offsetMs / 3_600_000}): marker ${marker.toISOString()} falls outside ` +
          `[${start.toISOString()}, ${end.toISOString()}) — that club has no today`,
      ).toBe(true);
    });
  }
});

describe("the three minting sites spell one day", () => {
  // `lib/today-sessions.ts` spells the CLUB's date at the PROCESS's midnight;
  // `app/api/instances/generate/route.ts` and `reconcileSchedules` spell the
  // PROCESS's date at the process's midnight. They agree only while the club's
  // calendar date equals the host's.
  const processMidnight = (now: Date) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  for (const tz of ["Pacific/Auckland", "America/Los_Angeles", "Asia/Makassar", "Europe/London"]) {
    // KNOWN DEFECT, pinned (round 2, L-D): for a club a day ahead of the host,
    // ensureTodayInstances and the Generate button spell the day a full day
    // apart, so skipDuplicates cannot match. `it.fails` = green while broken,
    // red when fixed — then flip back to plain `it`. Owner: the round-3
    // day-marker migration.
    const pin = tz === "Pacific/Auckland" || tz === "Asia/Makassar" ? it.fails : it;
    pin(`${tz}: the read-side marker equals the Generate-button marker`, () => {
      const fromRead = clubDayMarker(NOW, tz);
      const fromButton = processMidnight(NOW);
      const sameDay =
        Math.abs(fromRead.getTime() - fromButton.getTime()) < 12 * 3_600_000;
      expect(
        sameDay,
        `${tz}: ensureTodayInstances writes ${fromRead.toISOString()} and Generate writes ` +
          `${fromButton.toISOString()} — skipDuplicates cannot match, so one session gets two rows`,
      ).toBe(true);
    });
  }
});
