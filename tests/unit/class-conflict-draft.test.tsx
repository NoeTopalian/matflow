// @vitest-environment jsdom
//
// Round 11 (baseline 1.1): a class save refused because someone else changed the class (stale_class), its days and
// times (stale_schedules) or its category offered "Reload", and the reload threw away everything typed. Reload now
// keeps only the fields this person changed (this tab's sessionStorage, lib/draft-stash.ts), and after the reload the
// class's sheet reopens with them on top of the fresh class. Fields they did not touch come from the fresh class, and
// the save sends only what differs from it. Depends on PR #92's stale_class / category refusals (this branch is based
// on programme/round-7).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import type { ClassRow } from "@/app/dashboard/timetable/page";

const toastSpy = vi.fn();
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

const GI: ClassRow = {
  id: "c1", name: "Gi", coachName: null, coachUserId: null, coachUser: null, location: null, locationId: null,
  duration: 60, maxCapacity: null, color: null, description: null, requiredRankId: null, requiredRank: null,
  maxRankId: null, maxRank: null,
  schedules: [{ id: "slot-mon", dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
  roster: [], lifecycle: "active", archivedAt: null,
};
const PROPS = { rankSystems: [], coachUsers: [], primaryColor: "var(--color-primary)", role: "owner", currentUserId: "u1" };
const KEY = "matflow:draft:class-edit";
const STALE = { error: "Someone changed this class since you opened it. Your changes have not been saved.", reason: "stale_class" };

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
let calls: Call[] = [];
let patchReply: () => { ok: boolean; status: number; body: unknown };
let store: Map<string, string>;
let setItemThrows = false;
let reload: ReturnType<typeof vi.fn>;
const realLocation = Object.getOwnPropertyDescriptor(window, "location");
const realSession = Object.getOwnPropertyDescriptor(window, "sessionStorage");

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  calls = [];
  store = new Map();
  setItemThrows = false;
  patchReply = () => ({ ok: false, status: 409, body: STALE });
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { if (setItemThrows) throw new Error("QuotaExceededError"); store.set(k, v); },
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
  reload = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, method, body });
    if (url === "/api/locations") return { ok: true, json: async () => ({ locations: [] }) };
    if (url === "/api/coach/today") return { ok: true, json: async () => [] };
    if (method === "PATCH") { const r = patchReply(); return { ok: r.ok, status: r.status, json: async () => r.body }; }
    return { ok: false, json: async () => ({}) };
  }));
});
afterEach(() => {
  if (realLocation) Object.defineProperty(window, "location", realLocation);
  if (realSession) Object.defineProperty(window, "sessionStorage", realSession);
});

async function refusedEdit(newName = "Gi Fundamentals") {
  render(<TimetableManager initialClasses={[GI]} {...PROPS} />);
  fireEvent.click(screen.getAllByRole("button", { name: /^Edit Gi/ })[0]);
  fireEvent.change(screen.getByLabelText("Class Name") as HTMLInputElement, { target: { value: newName } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("alert");
}

describe("class form: a conflict reload keeps what was typed (Round 11, 1.1)", () => {
  it("Reload keeps only the changed field and its opened value, says so, then reloads", async () => {
    await refusedEdit();
    expect(screen.getByTestId("class-form-reload-keeps").textContent).toBe("Reload keeps what you've changed here.");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
    const kept = JSON.parse(store.get(KEY)!);
    expect(kept.classId).toBe("c1");
    expect(kept.form).toEqual({ name: "Gi Fundamentals" });
    expect(kept.opened).toEqual({ name: "Gi" });
  });

  it("after the reload: the sheet reopens with my name on top of their description, and the save sends only my change", async () => {
    store.set(KEY, JSON.stringify({ classId: "c1", form: { name: "Gi Fundamentals" }, opened: { name: "Gi" }, at: Date.now() }));
    patchReply = () => ({ ok: true, status: 200, body: { ...GI, name: "Gi Fundamentals", description: "Theirs" } });
    render(<TimetableManager initialClasses={[{ ...GI, description: "Theirs" }]} {...PROPS} />);
    await act(async () => {});
    expect((await screen.findByLabelText("Class Name") as HTMLInputElement).value).toBe("Gi Fundamentals");
    expect(screen.getByTestId("class-draft-restored").textContent).toContain("Your name change is kept below");
    expect(store.has(KEY)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = calls.find((c) => c.method === "PATCH")!.body!;
    expect(body.name).toBe("Gi Fundamentals");
    expect(body).not.toHaveProperty("description"); // theirs is not sent back
  });

  it("if this browser will not keep the input, it does not reload and says so", async () => {
    setItemThrows = true;
    await refusedEdit();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByTestId("class-form-reload-keeps").textContent).toContain("note your changes first");
    expect((screen.getByLabelText("Class Name") as HTMLInputElement).value).toBe("Gi Fundamentals");
  });

  it("a draft for a class not on this timetable, or older than 30 minutes, opens nothing", async () => {
    store.set(KEY, JSON.stringify({ classId: "gone", form: { name: "X" }, opened: { name: "Y" }, at: Date.now() }));
    const { unmount } = render(<TimetableManager initialClasses={[GI]} {...PROPS} />);
    await act(async () => {});
    expect(screen.queryByTestId("class-draft-restored")).toBeNull();
    unmount();
    store.set(KEY, JSON.stringify({ classId: "c1", form: { name: "Old" }, opened: { name: "Gi" }, at: Date.now() - 31 * 60 * 1000 }));
    render(<TimetableManager initialClasses={[GI]} {...PROPS} />);
    await act(async () => {});
    expect(screen.queryByTestId("class-draft-restored")).toBeNull();
  });

  it("lists are merged, not replaced: my moved Monday and their new Wednesday both survive (review of #105, H1)", async () => {
    store.set(KEY, JSON.stringify({
      classId: "c1", form: {}, opened: {},
      lists: { schedules: {
        added: [{ dayOfWeek: 1, startTime: "18:30", endTime: "19:30" }],
        removed: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
      } },
      at: Date.now(),
    }));
    patchReply = () => ({ ok: true, status: 200, body: GI });
    const theirs = { ...GI, schedules: [...GI.schedules, { id: "slot-wed", dayOfWeek: 3, startTime: "07:00", endTime: "08:00" }] };
    render(<TimetableManager initialClasses={[theirs]} {...PROPS} />);
    await act(async () => {});
    expect((await screen.findByTestId("class-draft-restored")).textContent).toContain("days and times");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const sent = (calls.find((c) => c.method === "PATCH")!.body!.schedules as Array<{ dayOfWeek: number; startTime: string }>)
      .map((x) => `${x.dayOfWeek} ${x.startTime}`).sort();
    expect(sent).toEqual(["1 18:30", "3 07:00"]); // their Wednesday kept, my Monday move applied, the old Monday gone
  });

  it("a days-and-times change is stashed as additions and removals, never as the whole list", async () => {
    render(<TimetableManager initialClasses={[GI]} {...PROPS} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Gi/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: /Add day/ }));
    fireEvent.change(screen.getAllByLabelText("Day of the week")[1], { target: { value: "3" } }); // a new Wednesday
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    const kept = JSON.parse(store.get(KEY)!);
    expect(kept.form).not.toHaveProperty("schedules");
    expect(kept.lists.schedules.added).toHaveLength(1);
    expect(kept.lists.schedules.removed).toHaveLength(0);
  });

  it("a days-and-times change is NOT put back when they removed a day it changed (review of #105, N1): their Tuesday stays deleted", async () => {
    // Opened: Mon, Tue, Wed 18:00-19:00. I changed the duration to 90 (every row's end). They deleted Tuesday.
    const row = (d: number, e: string) => ({ dayOfWeek: d, startTime: "18:00", endTime: e });
    store.set(KEY, JSON.stringify({
      classId: "c1", form: { duration: "90" }, opened: { duration: "60" },
      lists: { schedules: { added: [row(1, "19:30"), row(2, "19:30"), row(3, "19:30")], removed: [row(1, "19:00"), row(2, "19:00"), row(3, "19:00")] } },
      at: Date.now(),
    }));
    patchReply = () => ({ ok: true, status: 200, body: GI });
    const theirs = { ...GI, schedules: [{ id: "slot-mon", ...row(1, "19:00") }, { id: "slot-wed", ...row(3, "19:00") }] };
    render(<TimetableManager initialClasses={[theirs]} {...PROPS} />);
    await act(async () => {});
    expect((await screen.findByTestId("class-draft-restored")).textContent).toContain("Your days and times change was not kept");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = calls.find((c) => c.method === "PATCH")!.body!;
    const sent = ((body.schedules ?? []) as Array<{ dayOfWeek: number }>).map((x) => x.dayOfWeek).sort();
    expect(sent).not.toContain(2); // Tuesday is not brought back
  });

  it("a new class (nothing to reopen) does not claim Reload keeps the draft (review of #105, M1)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/locations") return { ok: true, json: async () => ({ locations: [] }) };
      if (method === "POST") return { ok: false, status: 409, json: async () => ({ error: "That category changed. Reload the page and choose again.", reason: "category" }) };
      return { ok: false, json: async () => ({}) };
    }));
    render(<TimetableManager initialClasses={[GI]} {...PROPS} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Add class" })[0]);
    fireEvent.change(await screen.findByLabelText("Class Name"), { target: { value: "Brand new" } });
    fireEvent.click(screen.getByRole("button", { name: /Add day/ }));
    const create = screen.getByRole("button", { name: "Create class" }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    expect((await screen.findByRole("alert")).textContent).toContain("That category changed");
    expect(screen.queryByTestId("class-form-reload-keeps")).toBeNull();
  });
});

