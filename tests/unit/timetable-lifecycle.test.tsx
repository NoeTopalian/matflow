// @vitest-environment jsdom
//
// T6b (Sean note 7): Pause, Archive, Resume and Restore on the timetable.
//
//  - Archive shows a COUNTED confirmation (check-ins, roster, bookings kept)
//    instead of failing with "Could not delete class" on a class with history.
//  - Paused and archived classes are listed under "Paused and archived", with
//    Resume (paused) and Restore (archived). Owner and manager only.
//  - Pause asks first and moves the class off the timetable into Paused.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";
import TimetableManager, { archiveConfirmBody } from "@/components/dashboard/TimetableManager";
import type { ClassRow } from "@/app/dashboard/timetable/page";

const toastSpy = vi.fn();

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

const base = (over: Partial<ClassRow>): ClassRow => ({
  id: "c1",
  name: "Fundamentals BJJ",
  coachName: null,
  coachUserId: null,
  coachUser: null,
  location: null,
  locationId: null,
  duration: 60,
  maxCapacity: null,
  color: null,
  description: null,
  requiredRankId: null,
  requiredRank: null,
  maxRankId: null,
  maxRank: null,
  schedules: [{ id: "s1", dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
  roster: [],
  lifecycle: "active",
  archivedAt: null,
  ...over,
});

const LIVE = base({});
const PAUSED = base({ id: "c2", name: "No-Gi Tuesdays", lifecycle: "paused" });
const ARCHIVED = base({ id: "c3", name: "Summer Camp", lifecycle: "archived", archivedAt: "2026-09-01T10:00:00.000Z" });

const PROPS = {
  rankSystems: [],
  coachUsers: [],
  primaryColor: "var(--color-primary)",
  role: "owner",
  currentUserId: "u1",
};

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];

function mockFetch(handlers: { preview?: () => { ok: boolean; body: unknown } } = {}) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url === "/api/locations") return { ok: true, json: async () => ({ locations: [] }) };
      if (url === "/api/coach/today") return { ok: true, json: async () => [] };
      if (method === "DELETE" && url.endsWith("?dryRun=1")) {
        const r = handlers.preview?.() ?? { ok: true, body: { dryRun: true, state: "active", attendanceCount: 4, rosterCount: 2, bookingCount: 3 } };
        return { ok: r.ok, json: async () => r.body };
      }
      if (method === "DELETE") return { ok: true, json: async () => ({ success: true, archivedAt: "2026-10-17T09:00:00.000Z" }) };
      if (method === "PATCH") return { ok: true, json: async () => ({ id: "x", sessionsCreatedOnResume: body?.isActive ? 8 : 0 }) };
      return { ok: false, json: async () => ({}) };
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mockFetch();
});

describe("archiveConfirmBody — the counted confirmation", () => {
  it("states each count that is kept", () => {
    const text = archiveConfirmBody({ attendanceCount: 4, rosterCount: 2, bookingCount: 3 });
    expect(text).toMatch(/Its 4 check-ins, 2 members on its roster, 3 bookings are kept\./);
    expect(text).toMatch(/Check-ins stay in reports/);
    expect(text).toMatch(/restore it from Paused and archived/);
  });
  it("says so when there is nothing to keep", () => {
    expect(archiveConfirmBody({ attendanceCount: 0, rosterCount: 0, bookingCount: 0 })).toMatch(/no check-ins, roster or bookings yet/);
  });
});

describe("Paused and archived section", () => {
  it("lists paused classes with Resume and archived classes with Restore", () => {
    render(<TimetableManager {...PROPS} initialClasses={[LIVE]} initialInactiveClasses={[PAUSED, ARCHIVED]} />);
    const section = screen.getByTestId("inactive-classes");
    expect(within(section).getByText("Paused and archived")).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Resume No-Gi Tuesdays" })).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Restore Summer Camp" })).toBeTruthy();
    expect(within(screen.getByTestId("inactive-class-c3")).getByText(/archived 1 Sept 2026/)).toBeTruthy();
  });

  it("is not shown to a coach (read-only role)", () => {
    render(<TimetableManager {...PROPS} role="coach" initialClasses={[LIVE]} initialInactiveClasses={[PAUSED]} />);
    expect(screen.queryByTestId("inactive-classes")).toBeNull();
  });

  it("is still shown when every class is paused (the empty timetable keeps the way back)", () => {
    render(<TimetableManager {...PROPS} initialClasses={[]} initialInactiveClasses={[PAUSED]} />);
    expect(screen.getByText("No classes yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume No-Gi Tuesdays" })).toBeTruthy();
  });
});

describe("Archive with a counted confirmation", () => {
  it("acceptance 3: reads the counts, says them, archives on confirm, and lists the class under Archived", async () => {
    render(<TimetableManager {...PROPS} initialClasses={[LIVE]} initialInactiveClasses={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Archive Fundamentals BJJ" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Archive Fundamentals BJJ?")).toBeTruthy();
    expect(within(dialog).getByText(/4 check-ins, 2 members on its roster, 3 bookings are kept/)).toBeTruthy();
    // The read was a dry run; nothing archived yet.
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/classes/c1?dryRun=1"]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Archive class" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/classes/c1")).toBe(true));
    await waitFor(() => expect(screen.getByTestId("inactive-class-c1")).toBeTruthy());
    expect(within(screen.getByTestId("inactive-class-c1")).getByText("Archived")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore Fundamentals BJJ" })).toBeTruthy();
    expect(toastSpy).toHaveBeenCalledWith(expect.stringMatching(/Class archived/), "success");
  });

  it("if the counts cannot be read, nothing is archived and the owner is told", async () => {
    mockFetch({ preview: () => ({ ok: false, body: { error: "Server error" } }) });
    render(<TimetableManager {...PROPS} initialClasses={[LIVE]} initialInactiveClasses={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Archive Fundamentals BJJ" }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    expect(toastSpy.mock.calls[0][1]).toBe("error");
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/classes/c1")).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Pause, Resume and Restore", () => {
  it("Pause asks first, sends isActive false and moves the class into Paused", async () => {
    render(<TimetableManager {...PROPS} initialClasses={[LIVE]} initialInactiveClasses={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause Fundamentals BJJ" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Bookings and check-in history are kept/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause class" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/api/classes/c1", body: { isActive: false } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume Fundamentals BJJ" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Pause Fundamentals BJJ" })).toBeNull();
  });

  it("Resume sends isActive true and puts the class back on the timetable, saying how many sessions were added", async () => {
    render(<TimetableManager {...PROPS} initialClasses={[]} initialInactiveClasses={[PAUSED]} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume No-Gi Tuesdays" }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/api/classes/c2", body: { isActive: true } });
    expect(toastSpy).toHaveBeenCalledWith("Class resumed · 8 sessions added to the timetable", "success");
    expect(screen.getAllByLabelText("Edit No-Gi Tuesdays").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("inactive-classes")).toBeNull();
  });

  it("Restore brings an archived class back and says Restored", async () => {
    render(<TimetableManager {...PROPS} initialClasses={[LIVE]} initialInactiveClasses={[ARCHIVED]} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore Summer Camp" }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    expect(toastSpy.mock.calls[0][0]).toMatch(/^Class restored/);
    expect(screen.getAllByLabelText("Edit Summer Camp").length).toBeGreaterThan(0);
  });
});
