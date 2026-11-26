// @vitest-environment jsdom
//
// Custom class colours on the members' schedule (25 Nov 2026).
//  - Two classes in the same shade at the same time on different mats are still told apart and opened by name, time
//    and mat: each block's accessible name carries all three, and opening one opens that class.
//  - Booked never rests on the fill: a booked block says "booked" in its name and shows the booked mark (the bell),
//    whatever its colour; a class that is not booked does neither — however green, grey or red it is.
//  - Members get no colour controls.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import React from "react";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/member/schedule",
}));

import MemberSchedulePage from "@/app/member/schedule/page";

type Row = Record<string, unknown>;
function row(id: string, name: string, startTime: string, endTime: string, location: string, matId: string | null, color: string | null): Row {
  return {
    id: `${id}-s`, classId: id, scheduleId: `${id}-s`, name, color, startTime, endTime,
    coach: "Sam Doe", location, matId, capacity: 20, dayOfWeek: new Date().getDay(), classInstanceId: null,
    eligibility: "ok", requiredRankName: null, maxRankName: null,
  };
}
const MATS = [{ id: "m1", name: "Mat 1" }, { id: "m2", name: "Mat 2" }];

function stub(rows: Row[], booked: string[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.startsWith("/api/member/schedule")) return { ok: true, status: 200, json: async () => rows } as Response;
      if (url.startsWith("/api/member/me/subscriptions")) return { ok: true, status: 200, json: async () => ({ classIds: booked }) } as Response;
      if (url.startsWith("/api/member/timetable")) return { ok: true, status: 200, json: async () => ({ layout: "mat", mats: MATS }) } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
}

beforeEach(() => {
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function scrollIntoView() {};
});

async function day() {
  const pane = await screen.findByTestId("schedule-pane");
  return within(pane).findByTestId("schedule-day");
}

describe("same shade, same time, different mats", () => {
  it("each block names its class, time and mat, and opens that class", async () => {
    stub([
      row("gi", "Gi Fundamentals", "11:00", "12:00", "Mat 1", "m1", "#7c8a6e"),
      row("nogi", "No-Gi Fundamentals", "11:00", "12:00", "Mat 2", "m2", "#7c8a6e"),
    ]);
    render(<MemberSchedulePage />);
    const d = await day();
    const gi = within(d).getByRole("button", { name: /^Gi Fundamentals, 11:00 to 12:00, Mat 1/ });
    const nogi = within(d).getByRole("button", { name: /^No-Gi Fundamentals, 11:00 to 12:00, Mat 2/ });
    expect(gi).not.toBe(nogi);
    fireEvent.click(nogi);
    const sheet = await screen.findByRole("dialog");
    expect(sheet.textContent).toContain("No-Gi Fundamentals");
    expect(sheet.textContent).toContain("Mat 2");
  });
});

describe("booked is said, not painted", () => {
  it.each([["white", "#ffffff"], ["pale yellow", "#fef9c3"], ["navy", "#1e3a8a"], ["the club's colour (none chosen)", null]])(
    "a booked %s class says booked and shows the booked mark; the same class not booked does neither",
    async (_n, color) => {
      stub([
        row("a", "Morning Class", "07:00", "08:00", "Mat 1", "m1", color as string | null),
        row("b", "Evening Class", "07:00", "08:00", "Mat 2", "m2", color as string | null),
      ], ["a"]);
      render(<MemberSchedulePage />);
      const d = await day();
      const booked = within(d).getByRole("button", { name: /^Morning Class,/ });
      const free = within(d).getByRole("button", { name: /^Evening Class,/ });
      expect(booked.getAttribute("aria-label")).toMatch(/, booked$/);
      expect(booked.querySelector("[data-testid='schedule-cell-booked-mark']")).not.toBeNull();
      expect(free.getAttribute("aria-label")).not.toMatch(/booked/);
      expect(free.querySelector("[data-testid='schedule-cell-booked-mark']")).toBeNull();
    },
  );

  it("a green, grey or red class that is not booked is not called booked, ended or cancelled because of its colour", async () => {
    stub([
      row("g", "Green Class", "21:00", "21:30", "Mat 1", "m1", "#22c55e"),
      row("y", "Grey Class", "21:00", "21:30", "Mat 2", "m2", "#94a3b8"),
      row("r", "Red Class", "22:00", "22:30", "Mat 1", "m1", "#ef4444"),
    ]);
    render(<MemberSchedulePage />);
    const d = await day();
    for (const name of ["Green Class", "Grey Class", "Red Class"]) {
      const b = within(d).getByRole("button", { name: new RegExp(`^${name},`) });
      expect(b.getAttribute("aria-label")).not.toMatch(/booked|cancelled/);
      expect(b.getAttribute("data-booked")).toBeNull();
      expect(b.getAttribute("data-session-state")).not.toBe("cancelled");
    }
    // The state is the clock's, not the colour's: green and grey at the same time are in the same state.
    const state = (n: string) => within(d).getByRole("button", { name: new RegExp(`^${n},`) }).getAttribute("data-session-state");
    expect(state("Grey Class")).toBe(state("Green Class"));
  });

  it("members get no colour controls", async () => {
    stub([row("a", "Morning Class", "07:00", "08:00", "Mat 1", "m1", "#ffffff")]);
    render(<MemberSchedulePage />);
    await day();
    expect(screen.queryByRole("button", { name: /Custom colour|Class colour/ })).toBeNull();
    expect(document.querySelector("input[type='color']")).toBeNull();
  });
});
