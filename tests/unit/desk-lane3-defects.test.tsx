// @vitest-environment jsdom
//
// Five desk-screen defects found by independent verifier lane 3 on the
// production build (30 Sep 2026). Each case fails on the code before the fix.
//
//   D1  no screen could cancel one session (the PATCH route had no caller)
//   D3  class Duration and a day's end time could disagree
//   D4  the members list showed cancelled members as current; a member who
//       joined today and had not visited yet was "quiet"
//   D5  a non-owner was told "Kiosk disabled" when the read was refused
//   D6  the timetable showed a cancelled session as LIVE

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

const toastSpy = vi.fn();
let currentSearch = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/dashboard",
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));
// The hub's sections fetch on their own; they are not what these cases test.
vi.mock("@/components/dashboard/RegisterPanel", () => ({ default: () => <div data-testid="register" /> }));
vi.mock("@/components/dashboard/CardScanner", () => ({ default: () => <div data-testid="scanner" /> }));

import AttendanceHub from "@/components/dashboard/AttendanceHub";
import KioskPanel from "@/components/dashboard/KioskPanel";
import MembersList, { isQuiet, type MemberRow } from "@/components/dashboard/MembersList";
import TimetableManager, { applyClassDuration, chipStatesFor } from "@/components/dashboard/TimetableManager";
import type { ClassRow } from "@/app/dashboard/timetable/page";

type FetchCall = { url: string; init?: RequestInit };

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  toastSpy.mockReset();
  currentSearch = "";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── D1 ──────────────────────────────────────────────────────────────────────

const SESSION = {
  id: "inst-1",
  classId: "cls-1",
  name: "Fundamentals",
  coachName: null,
  location: null,
  color: null,
  startTime: "18:00",
  endTime: "19:00",
  maxCapacity: null,
  attendedCount: 0,
  waitlistCount: 0,
  status: "soon" as const,
  isCancelled: false,
  cancellationReason: null as string | null,
  isMine: false,
};

function stubHubFetch(opts: { patchStatus?: number; patchBody?: unknown } = {}) {
  const calls: FetchCall[] = [];
  let cancelled = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/coach/today") {
        return json(200, [{ ...SESSION, isCancelled: cancelled, cancellationReason: cancelled ? "Coach ill" : null }]);
      }
      if (url.startsWith("/api/classes/") && init?.method === "PATCH") {
        const status = opts.patchStatus ?? 200;
        if (status === 200) cancelled = JSON.parse(String(init.body)).isCancelled;
        return json(status, opts.patchBody ?? { id: SESSION.id });
      }
      if (url === "/api/settings/kiosk") return json(403, { error: "Forbidden" });
      return json(404, { error: "Not found" });
    }),
  );
  return calls;
}

describe("D1 — cancel one session from the register", () => {
  it("cancel sends the reason to the instance route and reloads the picker", async () => {
    const calls = stubHubFetch();
    render(<AttendanceHub initialMode="tick" preselectClassId={null} role="manager" primaryColor="#3b82f6" />);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel this session" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "  Coach ill  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel this session" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Restore session" })).toBeTruthy());
    const patch = calls.find((c) => c.init?.method === "PATCH");
    expect(patch?.url).toBe("/api/classes/cls-1/instances/inst-1");
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ isCancelled: true, cancellationReason: "Coach ill" });
    // Refreshed: the day was read again after the change.
    expect(calls.filter((c) => c.url === "/api/coach/today").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Cancelled: Coach ill").some((el) => el.tagName === "P")).toBe(true);
  });

  it("refuses to send without a reason", async () => {
    const calls = stubHubFetch();
    render(<AttendanceHub initialMode="tick" preselectClassId={null} role="owner" primaryColor="#3b82f6" />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel this session" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel this session" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(calls.some((c) => c.init?.method === "PATCH")).toBe(false);
  });

  it("shows the route's refusal sentence", async () => {
    stubHubFetch({ patchStatus: 403, patchBody: { error: "Only an owner or manager can do that" } });
    render(<AttendanceHub initialMode="tick" preselectClassId={null} role="owner" primaryColor="#3b82f6" />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel this session" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Coach ill" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel this session" }));
    expect(await within(dialog).findByText("Only an owner or manager can do that")).toBeTruthy();
  });

  it("is not offered to a coach (the route admits owner and manager only)", async () => {
    stubHubFetch();
    render(<AttendanceHub initialMode="tick" preselectClassId={null} role="coach" primaryColor="#3b82f6" />);
    await screen.findByTestId("register");
    expect(screen.queryByRole("button", { name: "Cancel this session" })).toBeNull();
  });
});

// ─── D3 ──────────────────────────────────────────────────────────────────────

const CLASS: ClassRow = {
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
  schedules: [{ id: "s1", dayOfWeek: 2, startTime: "20:00", endTime: "21:00" }],
  roster: [],
};

const TT_PROPS = {
  rankSystems: [],
  coachUsers: [],
  primaryColor: "#3b82f6",
  role: "owner",
  currentUserId: "u1",
};

describe("D3 — class Duration moves duration-mode day ends", () => {
  it("applyClassDuration moves duration-mode rows and keeps end-mode rows", () => {
    const rows = [
      { dayOfWeek: 2, startTime: "20:00", endTime: "21:00" },
      { dayOfWeek: 4, startTime: "18:00", endTime: "20:30" },
    ];
    expect(applyClassDuration(rows, ["duration", "end"], 90)).toEqual([
      { dayOfWeek: 2, startTime: "20:00", endTime: "21:30" },
      { dayOfWeek: 4, startTime: "18:00", endTime: "20:30" },
    ]);
  });

  it("changing Duration 60 → 90 in the form moves Tuesday to 20:00–21:30", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, {})));
    render(<TimetableManager {...TT_PROPS} initialClasses={[CLASS]} />);
    fireEvent.click(screen.getAllByLabelText(/^Edit Fundamentals BJJ/)[0]);
    const [classDuration] = await screen.findAllByLabelText("Duration (mins)");
    fireEvent.change(classDuration, { target: { value: "90" } });
    expect(screen.getByText("90 mins · ends 21:30")).toBeTruthy();
    expect(screen.queryByText(/different from the class duration/)).toBeNull();
  });

  it("a day in end-time mode keeps its end and says it differs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, {})));
    render(<TimetableManager {...TT_PROPS} initialClasses={[CLASS]} />);
    fireEvent.click(screen.getAllByLabelText(/^Edit Fundamentals BJJ/)[0]);
    fireEvent.click(await screen.findByRole("button", { name: "dur" }));
    fireEvent.change(screen.getByLabelText("Duration (mins)"), { target: { value: "90" } });
    expect(screen.getByText("60 mins · ends 21:00")).toBeTruthy();
    expect(screen.getByText("Tuesday runs 60 min — different from the class duration")).toBeTruthy();
  });
});

// ─── D4 ──────────────────────────────────────────────────────────────────────

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const MEMBERS: MemberRow[] = [
  { id: "a", name: "Ada Active", email: "a@x.test", status: "active", joinedAt: daysAgo(100), lastVisitAt: daysAgo(1) },
  { id: "h", name: "Hal Hold", email: "h@x.test", status: "active", paymentStatus: "paused", joinedAt: daysAgo(100), lastVisitAt: daysAgo(1) },
  { id: "c", name: "Cara Cancelled", email: "c@x.test", status: "cancelled", paymentStatus: "cancelled", joinedAt: daysAgo(200), cancelledAt: daysAgo(40) },
];

describe("D4 — members list shows standing and does not count cancelled as current", () => {
  it("counts: All and the headline exclude the cancelled member; a Cancelled chip carries it", () => {
    render(<MembersList members={MEMBERS} primaryColor="#3b82f6" role="owner" />);
    expect(screen.getByText("All · 2")).toBeTruthy();
    expect(screen.getByText("Cancelled · 1")).toBeTruthy();
    expect(screen.getByText("On hold · 1")).toBeTruthy();
    expect(screen.getByText(/^2 current members/)).toBeTruthy();
    expect(screen.queryAllByText("Cara Cancelled")).toHaveLength(0);
    // The on-hold member is on the row as such.
    expect(screen.getAllByText("On hold").length).toBeGreaterThan(0);
  });

  it("?filter=cancelled shows the member with a Cancelled tag", () => {
    currentSearch = "filter=cancelled";
    render(<MembersList members={MEMBERS} primaryColor="#3b82f6" role="owner" />);
    expect(screen.getAllByText("Cara Cancelled").length).toBeGreaterThan(0);
    // The chip says "Cancelled · 1"; the row tag says exactly "Cancelled".
    expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
  });

  it("a member who joined today and has not visited is not quiet; one who joined a month ago is", () => {
    expect(isQuiet({ status: "active", paymentStatus: "paid", lastVisitAt: null, joinedAt: new Date().toISOString() })).toBe(false);
    expect(isQuiet({ status: "active", paymentStatus: "paid", lastVisitAt: null, joinedAt: daysAgo(30) })).toBe(true);
  });
});

// ─── D5 ──────────────────────────────────────────────────────────────────────

describe("D5 — kiosk status for a non-owner", () => {
  it("a non-owner is told only the owner can see it, never 'disabled', without asking the owner-only route", async () => {
    // Asking left the refused body unread, so the request never finished and
    // the check-in page never went quiet (lb-1 J16 / lb-2 J18, 30 Sep 2026).
    const fetchMock = vi.fn(async () => json(403, { error: "Forbidden" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<KioskPanel primaryColor="#3b82f6" role="admin" variant="compact" />);
    expect(await screen.findByText("Only the owner can see or change the kiosk link.")).toBeTruthy();
    expect(screen.queryByText(/disabled/i)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("any other failure is an error with retry, not 'disabled'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(500, { error: "boom" })));
    render(<KioskPanel primaryColor="#3b82f6" role="owner" variant="compact" />);
    expect(await screen.findByText(/Couldn't load the kiosk status/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText(/disabled/i)).toBeNull();
  });
});

// ─── D6 ──────────────────────────────────────────────────────────────────────

describe("D6 — a cancelled session is never Live on the timetable", () => {
  it("chipStatesFor marks today's cancelled instance Cancelled even mid-session", () => {
    const now = new Date(2026, 8, 30, 20, 30); // Wednesday 30 Sep, 20:30
    const cls = { ...CLASS, schedules: [{ id: "s1", dayOfWeek: 3, startTime: "20:00", endTime: "21:00" }] };
    expect(chipStatesFor([cls], 3, true, new Set(), now)).toEqual(["live"]);
    expect(chipStatesFor([cls], 3, true, new Set(["c1|20:00"]), now)).toEqual(["cancelled"]);
  });

  it("the week view reads today's instances and shows the chip as Cancelled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 30, 20, 30));
    const cls = { ...CLASS, schedules: [{ id: "s1", dayOfWeek: 3, startTime: "20:00", endTime: "21:00" }] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/coach/today"
          ? json(200, [{ ...SESSION, classId: "c1", startTime: "20:00", isCancelled: true, cancellationReason: "Coach ill" }])
          : json(200, { locations: [] }),
      ),
    );
    const { container } = render(<TimetableManager {...TT_PROPS} initialClasses={[cls]} />);
    await waitFor(() => expect(container.querySelector('[data-session-state="cancelled"]')).not.toBeNull());
    expect(container.querySelector('[data-session-state="live"]')).toBeNull();
  });
});
