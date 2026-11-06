// @vitest-environment jsdom
// /dashboard/timetable?classId=<id> — the page a class link lands on.
//
//  - an active class opens its edit sheet (owner and manager);
//  - a paused or archived class has no sheet to open, so its row in "Paused
//    and archived" is brought into view and marked;
//  - an id that is no longer a class says so;
//  - the param is removed afterwards, so Back does not repeat it.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import type { ClassRow } from "@/app/dashboard/timetable/page";

const { nav, toastSpy } = vi.hoisted(() => ({ nav: { search: "" }, toastSpy: vi.fn() }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ refresh: vi.fn() }),
}));
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

const PROPS = { rankSystems: [], coachUsers: [], primaryColor: "var(--color-primary)", currentUserId: "u1" };

const scrollSpy = vi.fn();

function open(search: string, role = "owner") {
  nav.search = search;
  window.history.pushState({}, "", `/dashboard/timetable${search ? `?${search}` : ""}`);
  return render(<TimetableManager initialClasses={[LIVE]} initialInactiveClasses={[PAUSED]} role={role} {...PROPS} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/locations") return { ok: true, json: async () => ({ locations: [] }) };
      if (url === "/api/coach/today") return { ok: true, json: async () => [] };
      return { ok: false, json: async () => ({}) };
    }),
  );
  Element.prototype.scrollIntoView = scrollSpy;
});

describe("timetable ?classId=", () => {
  it("opens an active class's edit sheet and removes the param", async () => {
    open("classId=c1");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByDisplayValue("Fundamentals BJJ")).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("keeps other params when it removes its own", async () => {
    open("classId=c1&venue=v1");
    await screen.findByRole("dialog");
    await waitFor(() => expect(window.location.search).toBe("?venue=v1"));
  });

  it("marks a paused class's row instead of opening a sheet", async () => {
    open("classId=c2");
    await waitFor(() =>
      expect(document.querySelector('[data-testid="inactive-class-c2"]')?.getAttribute("aria-current")).toBe("true"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(scrollSpy).toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("says so when the class no longer exists", async () => {
    open("classId=gone");
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    expect(String(toastSpy.mock.calls[0][0])).toMatch(/isn't on the timetable any more/);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("handles a second link to another class while the page stays mounted", async () => {
    const view = open("classId=c2");
    await waitFor(() =>
      expect(document.querySelector('[data-testid="inactive-class-c2"]')?.getAttribute("aria-current")).toBe("true"),
    );
    nav.search = "classId=c1";
    window.history.pushState({}, "", "/dashboard/timetable?classId=c1");
    view.rerender(<TimetableManager initialClasses={[LIVE]} initialInactiveClasses={[PAUSED]} role="owner" {...PROPS} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByDisplayValue("Fundamentals BJJ")).toBeTruthy();
    // The earlier mark is cleared: only one record is "the one the link named".
    expect(document.querySelector('[data-testid="inactive-class-c2"]')?.getAttribute("aria-current")).toBeNull();
  });

  it("keeps a #hash when it removes the param", async () => {
    nav.search = "classId=c2";
    window.history.pushState({}, "", "/dashboard/timetable?classId=c2#inactive");
    render(<TimetableManager initialClasses={[LIVE]} initialInactiveClasses={[PAUSED]} role="owner" {...PROPS} />);
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.location.hash).toBe("#inactive");
  });

  it("does nothing for a coach, who cannot edit classes", async () => {
    open("classId=c1", "coach");
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("marks nothing without the param", () => {
    open("");
    expect(document.querySelector('[aria-current="true"]')).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
