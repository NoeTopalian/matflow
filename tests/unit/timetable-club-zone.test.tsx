// @vitest-environment jsdom
//
// Round 6, timezone boundaries. The staff timetable's "today" (the Today pill,
// which column carries Live / Next / Cancelled, the week shown, the Today
// button) came from the BROWSER's clock, while today's cancellations come from
// /api/coach/today, which reads the CLUB's day (Tenant.timezone, todayWindow).
// With the browser and the club on different dates, the club's cancellations
// landed on the browser's today: an owner abroad saw Saturday's session called
// off when Friday's was, and a session live by the browser's clock but not the
// club's.
//
// This file runs the browser in Bali (Asia/Makassar, UTC+8, no DST) against a
// London club, at frozen instants, so it never depends on when it runs.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import type { ClassRow } from "@/app/dashboard/timetable/page";
import { clubWallClock, todayWindow } from "@/lib/class-time";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const savedTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Makassar";
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const base = (over: Partial<ClassRow>): ClassRow => ({
  id: "c1",
  name: "Evening Gi",
  coachName: null,
  coachUserId: null,
  coachUser: null,
  location: "Mat 1",
  locationId: null,
  duration: 60,
  maxCapacity: null,
  color: null,
  description: null,
  requiredRankId: null,
  requiredRank: null,
  maxRankId: null,
  maxRank: null,
  schedules: [],
  roster: [],
  lifecycle: "active",
  archivedAt: null,
  ...over,
});
const slot = (id: string, dayOfWeek: number, startTime: string, endTime: string) => ({ id, dayOfWeek, startTime, endTime });

// Fri and Sat at 19:00 (one class), a Saturday 07:00 class, a Friday overnight
// class 23:00-01:00, and Monday/Tuesday sessions (Sean's days).
const EVENING = base({ schedules: [slot("s-fri", 5, "19:00", "20:00"), slot("s-sat", 6, "19:00", "20:00")] });
const MORNING = base({ id: "c2", name: "Sat Morning", schedules: [slot("s-sat-am", 6, "07:00", "08:00")] });
const LATE = base({ id: "c3", name: "Late Open Mat", schedules: [slot("s-late", 5, "23:00", "01:00")] });
const MONTUE = base({ id: "c4", name: "Beginners Gi", schedules: [slot("s-mon", 1, "18:40", "19:30"), slot("s-tue", 2, "17:50", "18:40")] });
const CLASSES = [EVENING, MORNING, LATE, MONTUE];

const PROPS = { rankSystems: [], coachUsers: [], primaryColor: "var(--color-primary)", role: "owner", currentUserId: "u1" };

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** /api/coach/today as the server answers for the club's day: Friday's 19:00 Evening Gi is cancelled. */
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/coach/today"
        ? json(200, [{ classId: "c1", startTime: "19:00", isCancelled: true }])
        : json(200, { locations: [] }),
    ),
  );
}

function at(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

const todayTab = () => document.querySelector('[role="tab"][data-today]')?.getAttribute("aria-label") ?? null;
const chip = (name: string, day: string, start: string) =>
  screen.getAllByRole("button").filter((b) => (b.getAttribute("aria-label") ?? "").startsWith(`Edit ${name}, ${day} ${start} `));

describe("clubWallClock: the club's date, weekday and minutes", () => {
  it("names the same day as the server's todayWindow, for every hour of a fortnight across clock changes, in six zones", () => {
    const zones = ["Europe/London", "America/Los_Angeles", "Asia/Makassar", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Australia/Sydney"];
    for (const tz of zones) {
      for (let h = 0; h < 24 * 14; h++) {
        const now = new Date(Date.UTC(2026, 9, 20) + h * 3_600_000); // 20 Oct - 3 Nov 2026: London 25 Oct, Los Angeles 1 Nov
        const c = clubWallClock(now, tz);
        const w = todayWindow(now, tz);
        const mid = new Date((w.start.getTime() + w.end.getTime()) / 2);
        expect([c.year, c.month, c.day], `${tz} ${now.toISOString()}`).toEqual([mid.getUTCFullYear(), mid.getUTCMonth() + 1, mid.getUTCDate()]);
        expect(c.dow).toBe(mid.getUTCDay());
      }
    }
  });

  it("midnight and both London clock changes", () => {
    expect(clubWallClock(new Date("2026-11-13T23:59:00Z"), "Europe/London")).toMatchObject({ day: 13, dow: 5, minutes: 23 * 60 + 59 });
    expect(clubWallClock(new Date("2026-11-14T00:00:00Z"), "Europe/London")).toMatchObject({ day: 14, dow: 6, minutes: 0 });
    // Spring forward, Sun 29 Mar 2026 01:00Z: 00:59 GMT, then 02:00 BST.
    expect(clubWallClock(new Date("2026-03-29T00:59:00Z"), "Europe/London")).toMatchObject({ day: 29, minutes: 59 });
    expect(clubWallClock(new Date("2026-03-29T01:00:00Z"), "Europe/London")).toMatchObject({ day: 29, minutes: 120 });
    // Fall back, Sun 25 Oct 2026 01:00Z: 01:30 BST, then 01:30 GMT again.
    expect(clubWallClock(new Date("2026-10-25T00:30:00Z"), "Europe/London")).toMatchObject({ day: 25, minutes: 90 });
    expect(clubWallClock(new Date("2026-10-25T01:30:00Z"), "Europe/London")).toMatchObject({ day: 25, minutes: 90 });
    // A club far from the browser: Bali is a day ahead of Pago Pago (UTC-11) at 06:00Z.
    expect(clubWallClock(new Date("2026-11-13T06:00:00Z"), "Pacific/Pago_Pago")).toMatchObject({ day: 12, dow: 4, minutes: 19 * 60 });
  });
});

describe("the staff timetable's today is the club's day, not the browser's", () => {
  it("the browser really is in Bali for these cases", () => {
    expect(new Date("2026-11-13T23:30:00Z").getDate()).toBe(14);
    expect(new Date("2026-11-13T23:30:00Z").getHours()).toBe(7);
  });

  it("club Friday 23:30, browser Saturday 07:30: Friday is today, carries the club's cancellation, and its overnight session is live", async () => {
    at("2026-11-13T23:30:00Z");
    stubFetch();
    render(<TimetableManager {...PROPS} timeZone="Europe/London" initialClasses={CLASSES} />);
    await waitFor(() => expect(document.querySelector('[data-session-state="cancelled"]')).not.toBeNull());

    // The club's cancellation is Friday's session, not Saturday's.
    for (const b of chip("Evening Gi", "Saturday", "19:00")) expect(b.getAttribute("data-session-state")).toBeNull();
    for (const b of chip("Evening Gi", "Friday", "19:00")) expect(b.getAttribute("data-session-state")).toBe("cancelled");
    expect(todayTab()).toMatch(/^Friday 13, today/);
    // 07:00 Saturday is live in Bali, not at the club (it is Friday night there).
    for (const b of chip("Sat Morning", "Saturday", "07:00")) expect(b.getAttribute("data-session-state")).toBeNull();
    // The overnight session sits on its start day and is live at the club's 23:30.
    expect(chip("Late Open Mat", "Friday", "23:00").length).toBeGreaterThan(0);
    for (const b of chip("Late Open Mat", "Friday", "23:00")) expect(b.getAttribute("data-session-state")).toBe("live");
  });

  it("the week shown and its dates are the club's week; next, previous and Today move by the club's week", async () => {
    at("2026-11-15T23:30:00Z"); // club Sunday 15 Nov 23:30; browser Monday 16 Nov 07:30
    stubFetch();
    render(<TimetableManager {...PROPS} timeZone="Europe/London" initialClasses={CLASSES} />);
    expect(todayTab()).toMatch(/^Sunday 15, today/);
    expect(screen.getByText("9 Nov – 15 Nov")).toBeTruthy();
    // Monday and Tuesday sessions sit on the Monday 9 / Tuesday 10 of that week.
    expect(screen.getByRole("tab", { name: /^Monday 9,/ })).toBeTruthy();
    expect(chip("Beginners Gi", "Monday", "18:40").length).toBeGreaterThan(0);
    expect(chip("Beginners Gi", "Tuesday", "17:50").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(screen.getByText("16 Nov – 22 Nov")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /^Monday 16,/ })).toBeTruthy();
    expect(todayTab()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(screen.getByRole("tab", { name: /^Monday 2,/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(todayTab()).toMatch(/^Sunday 15, today/);
  });

  it("the club's midnight moves today, not the browser's", () => {
    at("2026-11-13T23:59:00Z"); // club Fri 23:59, browser Sat 07:59
    stubFetch();
    const { unmount } = render(<TimetableManager {...PROPS} timeZone="Europe/London" initialClasses={CLASSES} />);
    expect(todayTab()).toMatch(/^Friday 13, today/);
    unmount();
    at("2026-11-14T00:00:00Z"); // club Sat 00:00, browser Sat 08:00
    render(<TimetableManager {...PROPS} timeZone="Europe/London" initialClasses={CLASSES} />);
    expect(todayTab()).toMatch(/^Saturday 14, today/);
  });

  it("a club on summer time: London's clocks going back on Sunday 25 Oct 2026 keep the club's day and minutes", async () => {
    // 00:30Z = 01:30 BST (first 01:30), 01:30Z = 01:30 GMT (second); both Sunday at the club, Sunday 09:30 in Bali.
    for (const iso of ["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"]) {
      at(iso);
      vi.stubGlobal("fetch", vi.fn(async () => json(200, [])));
      const night = base({ id: "c5", name: "Night Owls", schedules: [slot("s-sun", 0, "01:00", "02:00")] });
      const { unmount } = render(<TimetableManager {...PROPS} timeZone="Europe/London" initialClasses={[night]} />);
      expect(todayTab()).toMatch(/^Sunday 25, today/);
      for (const b of chip("Night Owls", "Sunday", "01:00")) expect(b.getAttribute("data-session-state")).toBe("live");
      unmount();
      vi.unstubAllGlobals();
    }
  });
});
