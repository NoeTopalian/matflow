// @vitest-environment jsdom
//
// Round 3 (10 Nov 2026), review M-1: the dashboard's week of classes is the
// club's week, so the calendar's "today" and day labels come from the club's
// day key, not from the browser's clock or UTC. Rendered in a Los Angeles
// browser for an Auckland club whose Monday has started while it is still
// Sunday in UTC and in the browser.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement("a", { href }, children) }));

import WeeklyCalendar, { type DayClass } from "@/components/dashboard/WeeklyCalendar";

// jsdom has no Element.scrollTo; the calendar scrolls its own strip to centre the selected day (audit F1).
Element.prototype.scrollTo = () => {};

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  process.env.TZ = ORIGINAL_TZ;
});

const cls = (date: string, name: string): DayClass => ({ id: name, name, time: "18:00", endTime: "19:00", coach: "Coach", capacity: 20, enrolled: 3, date });

describe("WeeklyCalendar uses the club's today", () => {
  it("Auckland's Monday 9 Nov while the browser (Los Angeles) and UTC are on Sunday 8 Nov", () => {
    process.env.TZ = "America/Los_Angeles";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
    render(
      React.createElement(WeeklyCalendar, {
        todayKey: "2026-11-09",
        classes: [cls("2026-11-09", "Monday Fundamentals"), cls("2026-11-08", "Last Sunday Open Mat")],
        primaryColor: "#3b82f6",
        role: "owner",
      }),
    );
    // The club's week, 9–15 November, with Monday selected as today.
    expect(screen.getAllByText(/9–15 November 2026/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Monday Fundamentals").length).toBeGreaterThan(0);
    expect(screen.queryByText("Last Sunday Open Mat")).toBeNull();
  });
});

// Review L-3: a report's month is named from the middle of its period, so a
// reader west of the club does not see the month before.
import { formatPeriod } from "@/components/dashboard/MonthlyReportView";

describe("Monthly report list names the club's month in any reader's zone", () => {
  it("a London club's October, read in Los Angeles and in Auckland", () => {
    for (const zone of ["America/Los_Angeles", "Pacific/Auckland", "Europe/London"]) {
      process.env.TZ = zone;
      expect(formatPeriod("2026-09-30T23:00:00.000Z", "2026-10-31T23:59:59.999Z")).toBe("October 2026");
    }
  });
});
