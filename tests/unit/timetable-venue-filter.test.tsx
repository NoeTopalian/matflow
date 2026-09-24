// @vitest-environment jsdom
/**
 * Timetable venue filter (ADR-001 D2, slice 1). The control appears only
 * when the club has more than one venue; a class with no venue belongs to
 * every venue and stays visible whichever one is picked; a failed venue read
 * leaves the timetable exactly as it was (no control, nothing hidden).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import type { ClassRow } from "@/app/dashboard/timetable/page";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

function makeClass(id: string, name: string, locationId: string | null): ClassRow {
  return {
    id, name, coachName: null, coachUserId: null, coachUser: null, location: null, locationId,
    duration: 60, maxCapacity: null, color: null, description: null,
    requiredRankId: null, requiredRank: null, maxRankId: null, maxRank: null,
    schedules: [{ id: `${id}-s`, dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
  };
}

const CLASSES = [
  makeClass("c1", "Northside Fundamentals", "loc-north"),
  makeClass("c2", "Southside No-Gi", "loc-south"),
  makeClass("c3", "Everywhere Open Mat", null),
];

const PROPS = { initialClasses: CLASSES, rankSystems: [], coachUsers: [], primaryColor: "#2563eb", role: "owner", currentUserId: null };

function stubLocations(body: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/locations")) return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
}

beforeEach(() => { vi.unstubAllGlobals(); });

describe("timetable venue filter", () => {
  it("with two venues, picking one hides the other venue's classes and keeps the venue-less class", async () => {
    stubLocations({ locations: [{ id: "loc-north", name: "Northside", isDefault: true }, { id: "loc-south", name: "Southside", isDefault: false }] });
    render(<TimetableManager {...PROPS} />);
    const select = await screen.findByTestId("timetable-venue-filter");
    expect(screen.getAllByText("Southside No-Gi").length).toBeGreaterThan(0);
    fireEvent.change(select, { target: { value: "loc-north" } });
    await waitFor(() => expect(screen.queryByText("Southside No-Gi")).toBeNull());
    expect(screen.getAllByText("Northside Fundamentals").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Everywhere Open Mat").length).toBeGreaterThan(0);
    expect(screen.getByText(/2 of 3 classes/)).toBeTruthy();
  });

  it("with one venue there is no control and nothing is hidden", async () => {
    stubLocations({ locations: [{ id: "loc-north", name: "Northside", isDefault: true }] });
    render(<TimetableManager {...PROPS} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByTestId("timetable-venue-filter")).toBeNull();
    expect(screen.getAllByText("Southside No-Gi").length).toBeGreaterThan(0);
  });

  it("a failed venue read leaves the timetable as it was", async () => {
    stubLocations({ error: "boom" }, false);
    render(<TimetableManager {...PROPS} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByTestId("timetable-venue-filter")).toBeNull();
    expect(screen.getAllByText("Northside Fundamentals").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Southside No-Gi").length).toBeGreaterThan(0);
  });
});
