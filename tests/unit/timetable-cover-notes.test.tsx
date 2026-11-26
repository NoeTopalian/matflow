// @vitest-environment jsdom
//
// Session cover on the staff timetable (26 Nov 2026): a dated session's chip carries "Covered by …" or
// "Cover needed · … away" from GET /api/coach/cover; a class with no cover row carries nothing.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import type { ClassRow } from "@/app/dashboard/timetable/page";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/dashboard/timetable",
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const TZ = "Europe/London";
const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dow = new Date(`${todayKey}T00:00:00Z`).getUTCDay();

function makeClass(id: string, name: string): ClassRow {
  return {
    id, name, coachName: null, coachUserId: null, coachUser: null, location: null, locationId: null,
    duration: 30, maxCapacity: null, color: null, description: null,
    requiredRankId: null, requiredRank: null, maxRankId: null, maxRank: null,
    schedules: [{ id: `${id}-s`, dayOfWeek: dow, startTime: "22:00", endTime: "22:30" }],
    roster: [], allowedTiers: [], categoryId: null, categoryName: null,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("timetable cover notes", () => {
  it("shows the cover line on the covered and requested sessions only", async () => {
    const coverCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/coach/cover")) {
        coverCalls.push(url);
        return {
          ok: true,
          json: async () => ({
            sessions: [
              { classId: "c-cov", dayKey: todayKey, startTime: "22:00", state: "covered", coachLabel: "Covered by Casey Cover" },
              { classId: "c-req", dayKey: todayKey, startTime: "22:00", state: "cover_needed", coachLabel: "Cover needed · Alex Regular away" },
              { classId: "c-none", dayKey: todayKey, startTime: "22:00", state: "regular", coachLabel: null },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }));
    render(
      <TimetableManager
        initialClasses={[makeClass("c-cov", "Dash Covered"), makeClass("c-req", "Dash Requested"), makeClass("c-none", "Dash No Coach")]}
        rankSystems={[]}
        coachUsers={[]}
        membershipTiers={[]}
        primaryColor="var(--color-primary)"
        role="owner"
        currentUserId="u1"
        timeZone={TZ}
      />,
    );
    await waitFor(() => expect(coverCalls.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByText("Covered by Casey Cover").length).toBeGreaterThan(0));
    expect(screen.getAllByText("Cover needed · Alex Regular away").length).toBeGreaterThan(0);
    const covers = [...document.querySelectorAll('[data-chip-part="cover"]')].map((el) => el.textContent);
    expect(covers.every((t) => t === "Covered by Casey Cover" || t === "Cover needed · Alex Regular away")).toBe(true);
  });
});
