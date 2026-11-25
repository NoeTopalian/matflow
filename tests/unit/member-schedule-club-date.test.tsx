// @vitest-environment jsdom
//
// The member's day reads "today", live and next on the CLUB's clock (25 Nov 2026). It used the phone's: a London
// club's member in Bali (UTC+8) opened on Thursday at 20:30 on Wednesday, saw Wednesday's live class as upcoming and
// Thursday's 07:00 as "next". The reverse, a phone a day BEHIND the club (Honolulu, UTC-10), opened on yesterday.
// Each case runs the device in one zone against a London club at a frozen instant, in a GMT week and a BST week, so
// it never depends on when or where it runs. A day the member picks by hand is never moved.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import React from "react";
import { clubNow } from "@/lib/class-time";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/member/schedule",
}));

import MemberSchedulePage from "@/app/member/schedule/page";

const BALI = "Asia/Makassar"; // UTC+8, no DST: a day AHEAD of London in the evening
const HONOLULU = "Pacific/Honolulu"; // UTC-10, no DST: a day BEHIND London in the morning
const LONDON = "Europe/London";

// API dayOfWeek: 0 = Sun … 6 = Sat.
function row(id: string, name: string, dayOfWeek: number, startTime: string, endTime: string) {
  return {
    id: `${id}-s`, classId: id, name, color: null, startTime, endTime, coach: "Sam Doe", location: "Mat A", matId: null,
    capacity: 20, dayOfWeek, classInstanceId: null, eligibility: "ok", requiredRankName: null, maxRankName: null,
  };
}
const ROWS = [
  row("mon", "Fundamentals", 1, "18:00", "19:00"),
  row("tue", "Tuesday Morning", 2, "07:00", "08:00"),
  row("wed", "Evening Gi", 3, "20:00", "21:00"),
  row("thu", "Thursday Morning", 4, "07:00", "08:00"),
];

let scheduleUrls: string[] = [];
function stub(zoneHeader: string | null, gate?: Promise<void>) {
  scheduleUrls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.startsWith("/api/member/schedule")) {
        scheduleUrls.push(url);
        if (gate) await gate;
        return { ok: true, status: 200, headers: new Headers(zoneHeader ? { "X-Club-Zone": zoneHeader } : {}), json: async () => ROWS } as Response;
      }
      if (url.startsWith("/api/member/me/subscriptions")) return { ok: true, status: 200, json: async () => ({ classIds: [] }) } as Response;
      if (url.startsWith("/api/member/timetable")) return { ok: true, status: 200, json: async () => ({ layout: "time", mats: [] }) } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
}

const savedTz = process.env.TZ;
beforeEach(() => {
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function scrollIntoView() {};
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

function at(deviceZone: string, iso: string) {
  process.env.TZ = deviceZone;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

/** The day line under the pills: "Wednesday · 1 class · 1 live". */
function dayLine(): string {
  const p = screen.getAllByText((_, el) => el?.tagName === "P" && /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day/.test(el.textContent ?? ""));
  return p[0].textContent ?? "";
}
/** Session states in the visible day pane, by class name. */
async function states(): Promise<Record<string, string | null>> {
  const pane = await screen.findByTestId("schedule-pane");
  const day = await within(pane).findByTestId("schedule-day");
  const out: Record<string, string | null> = {};
  for (const b of day.querySelectorAll<HTMLElement>("[data-session-state]")) {
    const name = (b.getAttribute("aria-label") ?? "").split(",")[0];
    out[name] = b.getAttribute("data-session-state");
  }
  return out;
}
async function opened(dayName: string) {
  await waitFor(() => expect(dayLine().startsWith(dayName)).toBe(true));
}

describe("clubNow: the club's date and minute, whatever the device's zone", () => {
  it.each([
    [BALI, "2026-11-25T20:30:00Z", "2026-11-25", 3, 20 * 60 + 30], // club Wed 20:30 GMT; device Thu 04:30
    [HONOLULU, "2026-11-26T07:30:00Z", "2026-11-26", 4, 7 * 60 + 30], // club Thu 07:30 GMT; device Wed 21:30
    [BALI, "2027-03-29T17:30:00Z", "2027-03-29", 1, 18 * 60 + 30], // club Mon 18:30 BST; device Tue 01:30
    [HONOLULU, "2027-03-30T06:30:00Z", "2027-03-30", 2, 7 * 60 + 30], // club Tue 07:30 BST; device Mon 20:30
  ])("device %s at %s → club %s, weekday %i, minute %i", (zone, iso, date, dow, minutes) => {
    process.env.TZ = zone;
    const c = clubNow(LONDON, new Date(iso));
    const key = `${c.date.getFullYear()}-${String(c.date.getMonth() + 1).padStart(2, "0")}-${String(c.date.getDate()).padStart(2, "0")}`;
    expect({ key, dow: c.dow, minutes: c.minutes }).toEqual({ key: date, dow, minutes });
  });
});

describe("device a day AHEAD of the club (Bali)", () => {
  it("GMT, club Wed 25 Nov 20:30: opens on Wednesday, Evening Gi live; Thursday 07:00 has no state", async () => {
    at(BALI, "2026-11-25T20:30:00Z");
    stub(LONDON);
    render(<MemberSchedulePage />);
    await opened("Wednesday");
    expect(scheduleUrls).toEqual(["/api/member/schedule?date=today"]);
    expect((await states())["Evening Gi"]).toBe("live");
    expect(dayLine()).toContain("1 live");
    fireEvent.click(screen.getByRole("button", { name: /Thu\s*26/ }));
    await opened("Thursday");
    expect((await states())["Thursday Morning"]).toBe("upcoming");
  });

  it("GMT week, club Mon 22 Mar 2027 18:30: opens on Monday, Fundamentals live", async () => {
    at(BALI, "2027-03-22T18:30:00Z");
    stub(LONDON);
    render(<MemberSchedulePage />);
    await opened("Monday");
    expect((await states())["Fundamentals"]).toBe("live");
  });

  it("BST week, club Mon 29 Mar 2027 18:30 (device Tue 01:30): opens on Monday, Fundamentals live", async () => {
    at(BALI, "2027-03-29T17:30:00Z");
    stub(LONDON);
    render(<MemberSchedulePage />);
    await opened("Monday");
    expect((await states())["Fundamentals"]).toBe("live");
  });
});

describe("device a day BEHIND the club (Honolulu)", () => {
  it("GMT, club Thu 26 Nov 07:30 (device Wed 21:30): opens on Thursday, 07:00 live; Wednesday's Evening Gi not live", async () => {
    at(HONOLULU, "2026-11-26T07:30:00Z");
    stub(LONDON);
    render(<MemberSchedulePage />);
    await opened("Thursday");
    expect((await states())["Thursday Morning"]).toBe("live");
    fireEvent.click(screen.getByRole("button", { name: /Wed\s*25/ }));
    await opened("Wednesday");
    expect((await states())["Evening Gi"]).toBe("upcoming");
  });

  it("GMT week, club Tue 23 Mar 2027 07:30 (device Mon 21:30): opens on Tuesday, 07:00 live", async () => {
    at(HONOLULU, "2027-03-23T07:30:00Z");
    stub(LONDON);
    render(<MemberSchedulePage />);
    await opened("Tuesday");
    expect((await states())["Tuesday Morning"]).toBe("live");
  });

  it("BST week, club Tue 30 Mar 2027 07:30 (device Mon 20:30): opens on Tuesday, 07:00 live", async () => {
    at(HONOLULU, "2027-03-30T06:30:00Z");
    stub(LONDON);
    render(<MemberSchedulePage />);
    await opened("Tuesday");
    expect((await states())["Tuesday Morning"]).toBe("live");
  });
});

describe("manual day selection", () => {
  it("a day picked while the schedule loads is kept when the club's today arrives", async () => {
    at(BALI, "2026-11-25T20:30:00Z");
    let release!: () => void;
    stub(LONDON, new Promise<void>((r) => { release = r; }));
    render(<MemberSchedulePage />);
    fireEvent.click(screen.getByRole("button", { name: /Fri\s*27/ }));
    release();
    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
    await waitFor(() => expect(dayLine().startsWith("Friday")).toBe(true));
    expect(dayLine().startsWith("Friday")).toBe(true);
  });

  it("Today returns to the club's today, not the device's", async () => {
    at(BALI, "2026-11-25T20:30:00Z");
    stub(LONDON);
    render(<MemberSchedulePage />);
    await opened("Wednesday");
    fireEvent.click(screen.getByRole("button", { name: /Sat\s*28/ }));
    await opened("Saturday");
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await opened("Wednesday");
  });
});
