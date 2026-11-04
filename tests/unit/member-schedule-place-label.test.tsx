// @vitest-environment jsdom
//
// Member day view: two sessions side by side (two lanes) each name their mat,
// because that is the only thing that tells two "Beginners Gi" at 18:40 apart.
// A session on its own keeps the shorter line. PR C of
// .omc/plans/timetable-density-plan-2026-11-04.md.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/member/schedule",
}));

import MemberSchedulePage from "@/app/member/schedule/page";

function row(id: string, name: string, startTime: string, endTime: string, location: string) {
  const now = new Date();
  return {
    id: `${id}-s`, classId: id, scheduleId: `${id}-s`, name, color: "#3b82f6", startTime, endTime,
    coach: "Sam Doe", location, capacity: 20, dayOfWeek: now.getDay(), classInstanceId: null,
    eligibility: "ok", requiredRankName: null, maxRankName: null,
  };
}

beforeEach(() => {
  // jsdom implements neither of these; the grid auto-scrolls to "now" on mount.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function scrollIntoView() {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.startsWith("/api/member/schedule")) {
        return { ok: true, status: 200, json: async () => [
          row("gi-a", "Beginners Gi", "18:40", "19:30", "Mat 1"),
          row("gi-b", "Beginners Gi", "18:40", "19:30", "Mat 2"),
          row("open", "Open Mat", "20:00", "21:00", "Mat 1"),
        ] } as Response;
      }
      if (url.startsWith("/api/member/me/subscriptions")) return { ok: true, status: 200, json: async () => ({ classIds: [] }) } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
});

describe("member schedule — the mat beside side-by-side sessions", () => {
  it("names the mat on both lane-mates and not on a session that stands alone", async () => {
    render(<MemberSchedulePage />);
    const gi = await screen.findAllByRole("button", { name: /^Beginners Gi, 18:40 to 19:30/ });
    // The day strip renders three panels (previous, current, next); today's panel holds the pair.
    const labelled = gi.filter((b) => b.querySelector('[data-testid="schedule-cell-place"]'));
    expect(labelled.length).toBeGreaterThanOrEqual(2);
    expect(labelled.map((b) => b.querySelector('[data-testid="schedule-cell-place"]')?.textContent?.trim()).slice(0, 2).sort()).toEqual(["Mat 1", "Mat 2"]);
    // The mat takes the coach's place on that line (plan §3: `18:40–19:30 · Mat 2`).
    expect(labelled[0].textContent).not.toContain("Sam Doe");
    const open = await screen.findAllByRole("button", { name: /^Open Mat, 20:00 to 21:00/ });
    expect(open.every((b) => !b.querySelector('[data-testid="schedule-cell-place"]'))).toBe(true);
    expect(open[0].textContent).toContain("Sam Doe");
  });
});
