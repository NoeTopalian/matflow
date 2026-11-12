// @vitest-environment jsdom
//
// The class category on screen (T6c, Sean note 7; club-managed categories,
// Release A, 11 Nov 2026).
//  - Class form: a Category select of Uncategorised and the club's own active
//    categories, by the names the club gives them (a renamed starting category
//    and one the club made included, archived ones left out unless the class
//    has one). Picking one sends its id; an edit that does not touch it sends
//    nothing; Uncategorised sends null. A club with no category rows yet (made
//    by an older build) is offered the old keys, sent as `category`.
//  - Timetable: a category chip on the class card and the week chip, by name;
//    a "Kids" category on a kids class is not said twice, a renamed one is.
//  - Member schedule and kiosk: the club's name for the category; a server
//    from before this release (old key only) still gets the old label.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup, within } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import KioskPage from "@/components/kiosk/KioskPage";
import type { ClassRow } from "@/app/dashboard/timetable/page";
import { CLASS_CATEGORIES, CLASS_CATEGORY_LABELS, type ClassCategoryOption } from "@/lib/class-category";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/member/schedule",
}));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import MemberSchedulePage from "@/app/member/schedule/page";

// What Release B can leave behind, which this release must show correctly: Fundamentals renamed to Beginners,
// a category the club made (no old key), and an archived one.
const CATEGORIES: ClassCategoryOption[] = [
  { id: "cat-kids", name: "Kids", legacyKey: "kids", archived: false },
  { id: "cat-beg", name: "Beginners", legacyKey: "fundamentals", archived: false },
  { id: "cat-int", name: "Intermediate", legacyKey: null, archived: false },
  { id: "cat-comp", name: "Competition", legacyKey: "competition", archived: false },
  { id: "cat-gi", name: "Gi", legacyKey: "gi", archived: true },
];
const named = (id: string) => CATEGORIES.find((c) => c.id === id)!.name;

function makeClass(id: string, name: string, categoryId: string | null, extra: Partial<ClassRow> = {}): ClassRow {
  return {
    id, name, coachName: null, coachUserId: null, coachUser: null, location: null, locationId: null,
    duration: 60, maxCapacity: null, color: null, description: null,
    requiredRankId: null, requiredRank: null, maxRankId: null, maxRank: null,
    schedules: [{ id: `${id}-s`, dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
    roster: [], allowedTiers: [], categoryId, categoryName: categoryId ? named(categoryId) : null, ...extra,
  };
}

const props = (classes: ClassRow[], categories: ClassCategoryOption[] = CATEGORIES) => ({
  initialClasses: classes, rankSystems: [], coachUsers: [], membershipTiers: [], categories,
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
const sent = () => JSON.parse(patches()[0].init!.body as string) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
afterEach(() => { cleanup(); });

describe("class form — Category", () => {
  it("offers Uncategorised and the club's active categories by name, and starts on the class's own", async () => {
    stubFetch();
    render(<TimetableManager {...props([makeClass("c1", "Advanced", "cat-beg")])} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    const select = (await screen.findByRole("combobox", { name: "Category" })) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ["", "Uncategorised"],
      ["id:cat-kids", "Kids"],
      ["id:cat-beg", "Beginners"],
      ["id:cat-int", "Intermediate"],
      ["id:cat-comp", "Competition"],
    ]);
    expect(select.value).toBe("id:cat-beg");
  });

  it("a class on an archived category keeps it on offer, marked, and an unrelated save leaves it alone", async () => {
    stubFetch();
    render(<TimetableManager {...props([makeClass("c1", "Advanced", "cat-gi")])} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    const select = (await screen.findByRole("combobox", { name: "Category" })) as HTMLSelectElement;
    expect(select.value).toBe("id:cat-gi");
    expect(Array.from(select.options).map((o) => o.textContent)).toContain("Gi (archived)");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(sent()).not.toHaveProperty("categoryId");
    expect(sent()).not.toHaveProperty("category");
  });

  it("a class on a category the page's list does not hold yet shows its name alone, not \"(archived)\"", async () => {
    stubFetch();
    render(<TimetableManager {...props([makeClass("c1", "Advanced", null, { categoryId: "cat-new", categoryName: "Gi" })], [])} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    const select = (await screen.findByRole("combobox", { name: "Category" })) as HTMLSelectElement;
    expect(select.value).toBe("id:cat-new");
    const own = Array.from(select.options).find((o) => o.value === "id:cat-new");
    expect(own?.textContent).toBe("Gi");
  });

  it("picking Intermediate (a category the club made) sends its id; the card then shows the name", async () => {
    stubFetch({ categoryId: "cat-int", categoryName: "Intermediate" });
    render(<TimetableManager {...props([makeClass("c1", "Advanced", null)])} />);
    expect(screen.queryByTestId("class-card-category")).toBeNull();
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    fireEvent.change(await screen.findByRole("combobox", { name: "Category" }), { target: { value: "id:cat-int" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(sent().categoryId).toBe("cat-int");
    expect(sent()).not.toHaveProperty("category");
    await waitFor(() => expect(screen.getByTestId("class-card-category").textContent).toBe("Intermediate"));
  });

  it("an edit that does not touch the category sends neither field", async () => {
    stubFetch();
    render(<TimetableManager {...props([makeClass("c1", "Advanced", "cat-beg")])} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(sent()).not.toHaveProperty("categoryId");
    expect(sent()).not.toHaveProperty("category");
  });

  it("choosing Uncategorised sends a null category id", async () => {
    stubFetch();
    render(<TimetableManager {...props([makeClass("c1", "Advanced", "cat-beg")])} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    fireEvent.change(await screen.findByRole("combobox", { name: "Category" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(sent().categoryId).toBeNull();
  });

  it("a club with no category rows yet is offered the old eight, sent as an old key", async () => {
    stubFetch();
    render(<TimetableManager {...props([makeClass("c1", "Advanced", null)], [])} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    const select = (await screen.findByRole("combobox", { name: "Category" })) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ["", "Uncategorised"], ...CLASS_CATEGORIES.map((k) => [`key:${k}`, CLASS_CATEGORY_LABELS[k]]),
    ]);
    fireEvent.change(select, { target: { value: "key:nogi" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(sent().category).toBe("nogi");
    expect(sent()).not.toHaveProperty("categoryId");
  });
});

describe("timetable — category chip", () => {
  it("shows the club's names on the card and the week chip; a Kids-named category on a kids class is tagged Kids once", async () => {
    stubFetch();
    render(<TimetableManager {...props([
      makeClass("c1", "Advanced", "cat-comp"),
      makeClass("c2", "Little Grapplers", "cat-kids", { isKids: true }),
      makeClass("c3", "Fundamentals Gi", "cat-beg"),
    ])} />);
    await act(async () => {});
    expect(screen.getAllByTestId("class-card-category").map((n) => n.textContent)).toEqual(["Competition", "Beginners"]);
    const chips = screen.getAllByTestId("class-chip-category").map((n) => n.textContent);
    expect(new Set(chips)).toEqual(new Set(["Competition", "Beginners"]));
  });

  it("a renamed Kids category on a kids class is shown (only the word Kids is not said twice)", async () => {
    stubFetch();
    render(<TimetableManager {...props([makeClass("c1", "Little Grapplers", null, { isKids: true, categoryId: "cat-x", categoryName: "Juniors" })])} />);
    await act(async () => {});
    expect(screen.getAllByTestId("class-card-category").map((n) => n.textContent)).toEqual(["Juniors"]);
  });

  it("has no category filter above the timetable (removed 6 Nov 2026)", async () => {
    stubFetch();
    render(<TimetableManager {...props([makeClass("c1", "Gi Fundamentals", "cat-beg"), makeClass("c3", "Drop-in", null)])} />);
    await act(async () => {});
    expect(screen.queryByTestId("timetable-category-filter")).toBeNull();
    expect(screen.queryByLabelText("Filter by category")).toBeNull();
  });
});

describe("member schedule and kiosk — category label", () => {
  function scheduleWith(extra: Record<string, unknown>) {
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
            dayOfWeek: now.getDay(), classInstanceId: null, eligibility: "ok", ...extra,
          }],
        };
      }
      if (url.startsWith("/api/member/me/subscriptions")) return { ok: true, status: 200, json: async () => ({ classIds: [] }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }));
  }

  it("the member schedule shows the club's name for the category (a renamed starting one)", async () => {
    scheduleWith({ category: "fundamentals", categoryName: "Beginners" });
    render(<MemberSchedulePage />);
    await waitFor(() => expect(screen.getAllByText(/Advanced No-Gi/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(/Advanced No-Gi/)[0]);
    expect((await screen.findByTestId("schedule-sheet-category")).textContent).toBe("Beginners");
  });

  it("the member schedule still labels a class from a server older than this release (old key only)", async () => {
    scheduleWith({ category: "nogi" });
    render(<MemberSchedulePage />);
    await waitFor(() => expect(screen.getAllByText(/Advanced No-Gi/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(/Advanced No-Gi/)[0]);
    expect((await screen.findByTestId("schedule-sheet-category")).textContent).toBe("No-Gi");
  });

  it("the kiosk shows the club's names, falls back to the old label for an older server, and leaves an uncategorised class bare", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/classes")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            classes: [
              { id: "i1", name: "Advanced", startTime: "18:00", endTime: "19:00", date: "2026-10-17T00:00:00.000Z", requiredRank: null, maxRank: null, category: null, categoryName: "Intermediate" },
              { id: "i2", name: "Drop-in", startTime: "19:00", endTime: "20:00", date: "2026-10-17T00:00:00.000Z", requiredRank: null, maxRank: null, category: null, categoryName: null },
              { id: "i3", name: "Sunday", startTime: "20:00", endTime: "21:00", date: "2026-10-17T00:00:00.000Z", requiredRank: null, maxRank: null, category: "open_mat" },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }) as unknown as typeof fetch;
    render(<KioskPage token="kiosk_token_abcdefghijklmnop" tenant={{ name: "Total BJJ", primaryColor: "#38f", bgColor: "#111", textColor: "#fff", logoUrl: null, fontFamily: "Inter" }} />);
    await act(async () => {});
    const labels = screen.getAllByTestId("kiosk-class-category");
    expect(labels.map((l) => l.textContent)).toEqual(["Intermediate", "Open mat"]);
    expect(within(labels[0].closest("button")!).getByText("Advanced")).toBeTruthy();
  });
});
