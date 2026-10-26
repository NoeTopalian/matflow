// @vitest-environment jsdom
//
// T6c (Sean note 7): the class category on screen.
//  - Class form: a Category select (Uncategorised + the eight categories).
//    Picking one sends the key; an edit that does not touch it does not send
//    it; Uncategorised sends null.
//  - Timetable: a category chip on the class card and the week chip; a
//    "Kids" category on a kids class is not said twice.
//  - Timetable filter: offered once a class has a category; picking one shows
//    only those classes; Uncategorised shows the rest.
//  - Member schedule and kiosk: the label is shown.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup, within } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import KioskPage from "@/components/kiosk/KioskPage";
import type { ClassRow } from "@/app/dashboard/timetable/page";
import { CLASS_CATEGORIES, CLASS_CATEGORY_LABELS } from "@/lib/class-category";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/member/schedule",
}));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import MemberSchedulePage from "@/app/member/schedule/page";

function makeClass(id: string, name: string, category: string | null, extra: Partial<ClassRow> = {}): ClassRow {
  return {
    id, name, coachName: null, coachUserId: null, coachUser: null, location: null, locationId: null,
    duration: 60, maxCapacity: null, color: null, description: null,
    requiredRankId: null, requiredRank: null, maxRankId: null, maxRank: null,
    schedules: [{ id: `${id}-s`, dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
    roster: [], allowedTiers: [], category, ...extra,
  };
}

const props = (classes: ClassRow[]) => ({
  initialClasses: classes, rankSystems: [], coachUsers: [], membershipTiers: [],
  primaryColor: "var(--color-primary)", role: "owner", currentUserId: "u1",
});

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
function stubFetch(saved: Partial<ClassRow> = {}) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/api/locations") || url.includes("/api/coach/today")) return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({ ...makeClass("c1", "Advanced", null), ...saved, scheduleChange: null }) };
  }));
}
const patches = () => calls.filter((c) => c.init?.method === "PATCH");

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
afterEach(() => { cleanup(); });

describe("class form — Category", () => {
  it("offers Uncategorised and the eight categories, and starts on the class's own", async () => {
    stubFetch();
    render(<TimetableManager {...props([makeClass("c1", "Advanced", "gi")])} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    const select = (await screen.findByRole("combobox", { name: "Category" })) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => [o.value, o.textContent]);
    expect(options).toEqual([["", "Uncategorised"], ...CLASS_CATEGORIES.map((k) => [k, CLASS_CATEGORY_LABELS[k]])]);
    expect(select.value).toBe("gi");
  });

  it("picking No-Gi sends the key; the card then shows it", async () => {
    stubFetch({ category: "nogi" });
    render(<TimetableManager {...props([makeClass("c1", "Advanced", null)])} />);
    expect(screen.queryByTestId("class-card-category")).toBeNull();
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    fireEvent.change(await screen.findByRole("combobox", { name: "Category" }), { target: { value: "nogi" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(patches()[0].init!.body as string).category).toBe("nogi");
    await waitFor(() => expect(screen.getByTestId("class-card-category").textContent).toBe("No-Gi"));
  });

  it("an edit that does not touch the category does not send it", async () => {
    stubFetch();
    render(<TimetableManager {...props([makeClass("c1", "Advanced", "gi")])} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(patches()[0].init!.body as string)).not.toHaveProperty("category");
  });

  it("choosing Uncategorised sends null", async () => {
    stubFetch();
    render(<TimetableManager {...props([makeClass("c1", "Advanced", "gi")])} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    fireEvent.change(await screen.findByRole("combobox", { name: "Category" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(patches()[0].init!.body as string).category).toBeNull();
  });
});

describe("timetable — category chip and filter", () => {
  it("shows the chip on the card and the week chip; a Kids-category kids class is tagged Kids once", async () => {
    stubFetch();
    render(<TimetableManager {...props([
      makeClass("c1", "Advanced", "competition"),
      makeClass("c2", "Little Grapplers", "kids", { isKids: true }),
    ])} />);
    await act(async () => {});
    expect(screen.getAllByTestId("class-card-category").map((n) => n.textContent)).toEqual(["Competition"]);
    expect(screen.getAllByTestId("class-chip-category").every((n) => n.textContent === "Competition")).toBe(true);
  });

  it("no filter until a class has a category", async () => {
    stubFetch();
    render(<TimetableManager {...props([makeClass("c1", "Advanced", null)])} />);
    await act(async () => {});
    expect(screen.queryByTestId("timetable-category-filter")).toBeNull();
  });

  it("filters the timetable by category, and Uncategorised shows the rest", async () => {
    stubFetch();
    render(<TimetableManager {...props([
      makeClass("c1", "Gi Fundamentals", "fundamentals"),
      makeClass("c2", "No-Gi Advanced", "nogi"),
      makeClass("c3", "Drop-in", null),
    ])} />);
    const filter = await screen.findByTestId("timetable-category-filter");
    fireEvent.change(filter.querySelector("select") ?? filter, { target: { value: "nogi" } });
    await waitFor(() => expect(screen.queryByText("Gi Fundamentals")).toBeNull());
    expect(screen.getAllByText("No-Gi Advanced").length).toBeGreaterThan(0);
    expect(screen.queryByText("Drop-in")).toBeNull();
    expect(screen.getByTestId("timetable-category-count").textContent).toBe("Showing 1 of 3 classes");

    fireEvent.change(filter.querySelector("select") ?? filter, { target: { value: "__uncategorised" } });
    await waitFor(() => expect(screen.getAllByText("Drop-in").length).toBeGreaterThan(0));
    expect(screen.queryByText("No-Gi Advanced")).toBeNull();
  });
});

describe("member schedule and kiosk — category label", () => {
  it("the member schedule shows the label in the class sheet", async () => {
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function scrollIntoView() {};
    const now = new Date();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/api/member/schedule")) {
        return {
          ok: true, status: 200,
          json: async () => [{
            id: "c1-s1", classId: "c1", scheduleId: "s1", name: "Advanced No-Gi", color: null,
            startTime: "18:00", endTime: "19:00", coach: "Sam", location: "Mat 1", capacity: null,
            dayOfWeek: now.getDay(), classInstanceId: null, eligibility: "ok", category: "nogi",
          }],
        };
      }
      if (url.startsWith("/api/member/me/subscriptions")) return { ok: true, status: 200, json: async () => ({ classIds: [] }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }));
    render(<MemberSchedulePage />);
    await waitFor(() => expect(screen.getAllByText(/Advanced No-Gi/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(/Advanced No-Gi/)[0]);
    expect((await screen.findByTestId("schedule-sheet-category")).textContent).toBe("No-Gi");
  });

  it("the kiosk labels a categorised class and leaves an uncategorised one bare", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/classes")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            classes: [
              { id: "i1", name: "Advanced", startTime: "18:00", endTime: "19:00", date: "2026-10-17T00:00:00.000Z", requiredRank: null, maxRank: null, category: "open_mat" },
              { id: "i2", name: "Drop-in", startTime: "19:00", endTime: "20:00", date: "2026-10-17T00:00:00.000Z", requiredRank: null, maxRank: null, category: null },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }) as unknown as typeof fetch;
    render(<KioskPage token="kiosk_token_abcdefghijklmnop" tenant={{ name: "Total BJJ", primaryColor: "#38f", bgColor: "#111", textColor: "#fff", logoUrl: null, fontFamily: "Inter" }} />);
    await act(async () => {});
    const labels = screen.getAllByTestId("kiosk-class-category");
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toBe("Open mat");
    expect(within(labels[0].closest("button")!).getByText("Advanced")).toBeTruthy();
  });
});
