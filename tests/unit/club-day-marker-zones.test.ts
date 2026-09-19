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
   * a self-hosting club is in.
   *
   * ROUND 3: these cases now drive `clubDayMarker`, the product's writer, where
   * before they re-implemented its old body inline (`Date.UTC(clubYMD) -
   * offsetMs` — the club's LOCAL midnight, which is what `new Date(y, m, d)`
   * produced in a process sitting in that zone). That reconstruction is no
   * longer a copy of anything: since the day-marker migration no writer spells
   * a marker in a process zone, so asserting on that formula would be asserting
   * on code the product no longer contains. Two claims are made instead, and
   * both are about the shipped function:
   *
   *   1. the marker is UTC midnight — so it is the SAME instant whatever host
   *      computes it, which is what the old formula could not promise;
   *   2. `todayWindow` admits it — which at +12:45 and +14 the old formula did
   *      not, because a local midnight there is 12.75–14 h from UTC midnight
   *      and the band is ±12 h. Those two zones were pinned `it.fails`; they
   *      are plain `it` now and green, which is the designed proof.
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
    it(`a host in ${tz} writes a marker todayWindow admits`, () => {
      const offsetMs = zoneOffsetMs(NOW, tz);
      const marker = clubDayMarker(NOW, tz);
      // Host-independent by construction, which is the fix. A marker that is
      // not a UTC midnight carries the writing process's zone inside a value
      // that is supposed to be a calendar date.
      expect(
        marker.getTime() % 86_400_000,
        `${tz} (UTC${offsetMs / 3_600_000}): marker ${marker.toISOString()} is not a UTC midnight, ` +
          "so where it was written changes what was written",
      ).toBe(0);
      const { start, end } = todayWindow(NOW, tz);
      expect(
        marker >= start && marker < end,
        `${tz} (UTC${offsetMs / 3_600_000}): marker ${marker.toISOString()} falls outside ` +
          `[${start.toISOString()}, ${end.toISOString()}) — that club has no today`,
      ).toBe(true);
    });
  }
});

describe("the four minting sites spell one day", () => {
  /**
   * ROUND 3: all four writers — `ensureTodayInstances`,
   * `POST /api/instances/generate`, `POST /api/classes/[id]/instances` +
   * `reconcileSchedules`, and `GET /api/cron/class-instances` — now derive
   * `from` from `clubDayMarker(now, club zone)`. Before, only the read side did;
   * the other three used `new Date(); setHours(0,0,0,0)`, the PROCESS's date at
   * the process's midnight, reproduced here as `processMidnight`.
   *
   * So the claim under test is no longer "do two different formulas agree" (they
   * never could) but "does the one formula every writer now shares stay on the
   * club's own date when the host is somewhere else". `processMidnight` is kept
   * as the counter-example, named as the discarded spelling: for Auckland and
   * Makassar it is a full day away from the club's date, which is exactly the
   * duplicate-row defect Pacific/Auckland and Asia/Makassar were pinned
   * `it.fails` for. Both are plain `it` now.
   */
  const processMidnight = (now: Date) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  for (const tz of ["Pacific/Auckland", "America/Los_Angeles", "Asia/Makassar", "Europe/London"]) {
    it(`${tz}: every writer's marker is the club's own calendar date`, () => {
      const marker = clubDayMarker(NOW, tz);
      const expected = clubDate(NOW, tz);
      expect(
        [marker.getUTCFullYear(), marker.getUTCMonth(), marker.getUTCDate()],
        `${tz}: the shared marker ${marker.toISOString()} is not the club's date`,
      ).toEqual([expected.y, expected.m, expected.d]);
      expect(marker.toISOString()).toMatch(/T00:00:00\.000Z$/);

      // The spelling the three button/cron writers used to carry. Kept as the
      // counter-example: where it differs from the marker above, those writers
      // were minting a second row for a session the read side had already made.
      const discarded = processMidnight(NOW);
      const agreesWithHost =
        Math.abs(marker.getTime() - discarded.getTime()) < 12 * 3_600_000;
      if (tz === "Pacific/Auckland" || tz === "Asia/Makassar") {
        expect(
          agreesWithHost,
          `${tz}: the discarded process-midnight spelling ${discarded.toISOString()} happens to ` +
            "agree with the club's date on this host, so this case is not exercising anything",
        ).toBe(false);
      }
    });
  }
});
