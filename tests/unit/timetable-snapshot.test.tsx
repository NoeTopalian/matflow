// @vitest-environment jsdom
//
// The timetable keeps showing what the server last sent it. A route refresh
// re-renders the server page while TimetableManager stays mounted; the
// component used to read `initialClasses` / `initialInactiveClasses` only on
// its first render, so a weekday saved elsewhere (Gi on Tuesday) stayed hidden,
// and a class paused or restored elsewhere stayed in the wrong list.
//
// These cases also pin what the fix must NOT do: replace a local change while
// the snapshot is unchanged, or touch a form that is being edited.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import type { ClassRow } from "@/app/dashboard/timetable/page";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const slot = (dayOfWeek: number, startTime = "18:00") => ({ dayOfWeek, startTime, endTime: "19:00" });
const makeClass = (id: string, days: number[], over: Partial<ClassRow> = {}): ClassRow => ({
  id, name: "Gi", coachName: null, coachUserId: null, coachUser: null,
  location: null, locationId: null, duration: 60, maxCapacity: null, color: null,
  description: null, requiredRankId: null, requiredRank: null, maxRankId: null, maxRank: null,
  schedules: days.map((d) => ({ id: `${id}-${d}`, ...slot(d) })), roster: [],
  lifecycle: "active", archivedAt: null,
  ...over,
});
const PROPS = { rankSystems: [], coachUsers: [], primaryColor: "#2563eb", role: "owner", currentUserId: null };

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
let calls: Call[];
let saved: ClassRow[];
let failWrites: boolean;
beforeEach(() => {
  calls = [];
  saved = [];
  failWrites = false;
  refresh.mockClear();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (method === "DELETE" && url.includes("dryRun=1")) {
      return { ok: true, json: async () => ({ dryRun: true, state: "active", attendanceCount: 0, rosterCount: 0, bookingCount: 0 }) };
    }
    if (method === "DELETE") {
      if (failWrites) return { ok: false, json: async () => ({ error: "Synthetic failure" }) };
      return { ok: true, json: async () => ({ success: true, archivedAt: "2026-11-04T00:00:00.000Z" }) };
    }
    if (url.includes("dryRun=1")) return { ok: true, json: async () => ({ dryRun: true, restriction: null }) };
    if (failWrites && method === "PATCH") return { ok: false, json: async () => ({ error: "Synthetic failure" }) };
    if (url === "/api/locations") return { ok: true, json: async () => ({ locations: [] }) };
    if (method === "PATCH" && typeof body?.isActive === "boolean") {
      return { ok: true, json: async () => ({ id: url.split("/").at(-1), sessionsCreatedOnResume: body.isActive ? 8 : 0 }) };
    }
    if (method === "POST" || method === "PATCH") {
      const id = method === "POST" ? `c${saved.length + 1}` : url.split("/").at(-1)!;
      const schedules = (body!.schedules as object[]).map((s, i) => ({ ...s, id: `${id}-${i}` }));
      const row = { ...makeClass(id, []), ...body, schedules } as ClassRow;
      saved = [...saved.filter((c) => c.id !== id), row];
      return { ok: true, json: async () => ({ ...row, instancesCreated: 16, allowedTierIds: [], scheduleChange: null }) };
    }
    return { ok: true, json: async () => [] };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function gridDay(container: HTMLElement, label: string) {
  const grid = container.querySelector(".grid-cols-7") as HTMLElement;
  return within(within(grid).getByText(label).closest(".rounded-2xl") as HTMLElement);
}
// With no active class the week grid is replaced by "No classes yet".
const chipCount = (container: HTMLElement, day: string, name = "Gi") =>
  container.querySelector(".grid-cols-7")
    ? gridDay(container, day).queryAllByRole("button", { name: `Edit ${name}` }).length
    : 0;
function expectDays(container: HTMLElement, want: Record<string, number>) {
  for (const [day, n] of Object.entries(want)) expect(chipCount(container, day), day).toBe(n);
}
async function create(days: number[]) {
  fireEvent.click(screen.getAllByRole("button", { name: "Add class" })[0]);
  fireEvent.change(await screen.findByLabelText("Class Name"), { target: { value: "Gi" } });
  for (const [i, day] of days.entries()) {
    fireEvent.click(screen.getByRole("button", { name: "Add day" }));
    fireEvent.change(screen.getAllByLabelText("Day of the week")[i], { target: { value: String(day) } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Create class" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}
async function pauseFromCard(name = "Gi") {
  fireEvent.click(screen.getAllByRole("button", { name: `Pause ${name}` })[0]);
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Pause class" }));
  await waitFor(() => expect(screen.getByRole("button", { name: `Resume ${name}` })).toBeTruthy());
}

describe("a refreshed server snapshot reaches the mounted timetable", () => {
  it.each([
    ["one class with both days", () => [makeClass("c1", [1, 2])]],
    ["two separate classes with the same name", () => [makeClass("c1", [1]), makeClass("c2", [2])]],
  ])("Tuesday saved elsewhere appears (%s)", async (_label, next) => {
    const view = render(<TimetableManager {...PROPS} initialClasses={[makeClass("c1", [1])]} initialInactiveClasses={[]} />);
    expectDays(view.container, { Mon: 1, Tue: 0 });
    view.rerender(<TimetableManager {...PROPS} initialClasses={next()} initialInactiveClasses={[]} />);
    await waitFor(() => expectDays(view.container, { Mon: 1, Tue: 1 }));
  });

  it("a class paused elsewhere leaves the timetable and is listed once under Paused", async () => {
    const view = render(<TimetableManager {...PROPS} initialClasses={[makeClass("c1", [1, 2])]} initialInactiveClasses={[]} />);
    view.rerender(
      <TimetableManager {...PROPS} initialClasses={[]} initialInactiveClasses={[makeClass("c1", [1, 2], { lifecycle: "paused" })]} />,
    );
    await waitFor(() => expectDays(view.container, { Mon: 0, Tue: 0 }));
    expect(screen.getAllByTestId("inactive-class-c1")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Resume Gi" })).toBeTruthy();
  });

  it("a class restored elsewhere returns to the timetable and leaves Paused, with no duplicate", async () => {
    const view = render(
      <TimetableManager {...PROPS} initialClasses={[]} initialInactiveClasses={[makeClass("c1", [1, 2], { lifecycle: "paused" })]} />,
    );
    view.rerender(<TimetableManager {...PROPS} initialClasses={[makeClass("c1", [1, 2])]} initialInactiveClasses={[]} />);
    await waitFor(() => expectDays(view.container, { Mon: 1, Tue: 1 }));
    expect(screen.queryByTestId("inactive-classes")).toBeNull();
  });

  it("a locally created class is not duplicated when the snapshot that includes it arrives", async () => {
    const view = render(<TimetableManager {...PROPS} initialClasses={[]} initialInactiveClasses={[]} />);
    await create([1, 2]);
    expectDays(view.container, { Mon: 1, Tue: 1 });
    view.rerender(<TimetableManager {...PROPS} initialClasses={[...saved]} initialInactiveClasses={[]} />);
    await waitFor(() => expectDays(view.container, { Mon: 1, Tue: 1 }));
  });
});

describe("what a snapshot must not overwrite", () => {
  it("a local pause survives a re-render that brings the same snapshot", async () => {
    const active = [makeClass("c1", [1, 2])];
    const inactive: ClassRow[] = [];
    const view = render(<TimetableManager {...PROPS} initialClasses={active} initialInactiveClasses={inactive} />);
    await pauseFromCard();
    view.rerender(<TimetableManager {...PROPS} initialClasses={active} initialInactiveClasses={inactive} />);
    expectDays(view.container, { Mon: 0, Tue: 0 });
    expect(screen.getByRole("button", { name: "Resume Gi" })).toBeTruthy();
  });

  it("with no inactive list passed at all, a local pause survives a re-render (no reset, no render loop)", async () => {
    const active = [makeClass("c1", [1, 2])];
    const view = render(<TimetableManager {...PROPS} initialClasses={active} />);
    await pauseFromCard();
    view.rerender(<TimetableManager {...PROPS} initialClasses={active} />);
    expectDays(view.container, { Mon: 0, Tue: 0 });
    expect(screen.getByRole("button", { name: "Resume Gi" })).toBeTruthy();
  });

  it("an unsaved edit in the open form is kept when a new snapshot arrives, and is what gets saved", async () => {
    const view = render(<TimetableManager {...PROPS} initialClasses={[makeClass("c1", [1, 2])]} initialInactiveClasses={[]} />);
    fireEvent.click(gridDay(view.container, "Tue").getByRole("button", { name: "Edit Gi" }));
    const tue = screen.getAllByLabelText("Day of the week").findIndex((el) => (el as HTMLSelectElement).value === "2");
    fireEvent.change(screen.getAllByLabelText("Start time")[tue], { target: { value: "19:30" } });
    view.rerender(<TimetableManager {...PROPS} initialClasses={[makeClass("c1", [1, 2])]} initialInactiveClasses={[]} />);
    expect((screen.getAllByLabelText("Start time")[tue] as HTMLInputElement).value).toBe("19:30");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const sent = calls.find((c) => c.method === "PATCH")!.body!.schedules as { dayOfWeek: number; startTime: string }[];
    expect(sent.map((s) => [s.dayOfWeek, s.startTime])).toEqual([[1, "18:00"], [2, "19:30"]]);
  });
});

describe("after a confirmed change the page asks for a fresh snapshot", () => {
  it("a saved class requests exactly one refresh", async () => {
    render(<TimetableManager {...PROPS} initialClasses={[]} initialInactiveClasses={[]} />);
    await create([1, 2]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a pause requests exactly one refresh", async () => {
    render(<TimetableManager {...PROPS} initialClasses={[makeClass("c1", [1, 2])]} initialInactiveClasses={[]} />);
    await pauseFromCard();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("an edit requests exactly one refresh", async () => {
    const view = render(<TimetableManager {...PROPS} initialClasses={[makeClass("c1", [1, 2])]} initialInactiveClasses={[]} />);
    fireEvent.click(gridDay(view.container, "Tue").getByRole("button", { name: "Edit Gi" }));
    fireEvent.change(screen.getAllByLabelText("Start time")[1], { target: { value: "19:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("an archive requests exactly one refresh", async () => {
    render(<TimetableManager {...PROPS} initialClasses={[makeClass("c1", [1, 2])]} initialInactiveClasses={[]} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Archive Gi" })[0]);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Archive class" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore Gi" })).toBeTruthy());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a resume requests exactly one refresh", async () => {
    const view = render(
      <TimetableManager {...PROPS} initialClasses={[]} initialInactiveClasses={[makeClass("c1", [1, 2], { lifecycle: "paused" })]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume Gi" }));
    await waitFor(() => expectDays(view.container, { Mon: 1, Tue: 1 }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("a failed pause, archive or resume changes nothing and requests no refresh", () => {
  it("pause", async () => {
    failWrites = true;
    const view = render(<TimetableManager {...PROPS} initialClasses={[makeClass("c1", [1, 2])]} initialInactiveClasses={[]} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Pause Gi" })[0]);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Pause class" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expectDays(view.container, { Mon: 1, Tue: 1 });
    expect(screen.queryByTestId("inactive-classes")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("archive", async () => {
    failWrites = true;
    const view = render(<TimetableManager {...PROPS} initialClasses={[makeClass("c1", [1, 2])]} initialInactiveClasses={[]} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Archive Gi" })[0]);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Archive class" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && !c.url.includes("dryRun"))).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expectDays(view.container, { Mon: 1, Tue: 1 });
    expect(screen.queryByTestId("inactive-classes")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("resume", async () => {
    failWrites = true;
    const view = render(
      <TimetableManager {...PROPS} initialClasses={[]} initialInactiveClasses={[makeClass("c1", [1, 2], { lifecycle: "paused" })]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume Gi" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    await waitFor(() => expect((screen.getByRole("button", { name: "Resume Gi" }) as HTMLButtonElement).disabled).toBe(false));
    expectDays(view.container, { Mon: 0, Tue: 0 });
    expect(screen.getAllByTestId("inactive-class-c1")).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a failed save requests none, keeps the form open and the typed value", async () => {
    render(<TimetableManager {...PROPS} initialClasses={[]} initialInactiveClasses={[]} />);
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url) === "/api/locations"
        ? ({ ok: true, json: async () => ({ locations: [] }) } as Response)
        : ({ ok: false, json: async () => ({ error: "Synthetic failure" }) } as Response));
    fireEvent.click(screen.getAllByRole("button", { name: "Add class" })[0]);
    fireEvent.change(await screen.findByLabelText("Class Name"), { target: { value: "Gi" } });
    fireEvent.click(screen.getByRole("button", { name: "Add day" }));
    fireEvent.click(screen.getByRole("button", { name: "Create class" }));
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
      expect((screen.getByRole("button", { name: "Create class" }) as HTMLButtonElement).disabled).toBe(false);
    });
    expect(refresh).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Class Name") as HTMLInputElement).value).toBe("Gi");
  });
});

describe("Gi on Monday and Tuesday through the form", () => {
  it("one form submits both days, shows both, and editing Tuesday keeps Monday; both survive reopening", async () => {
    const view = render(<TimetableManager {...PROPS} initialClasses={[]} initialInactiveClasses={[]} />);
    await create([1, 2]);
    expect(saved[0].schedules.map((s) => s.dayOfWeek)).toEqual([1, 2]);
    expectDays(view.container, { Mon: 1, Tue: 1 });
    fireEvent.click(gridDay(view.container, "Tue").getByRole("button", { name: "Edit Gi" }));
    expect(screen.getAllByLabelText("Day of the week")).toHaveLength(2);
    fireEvent.change(screen.getAllByLabelText("Start time")[1], { target: { value: "19:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(saved[0].schedules[0]).toMatchObject(slot(1));
    expect(saved[0].schedules[1]).toMatchObject({ dayOfWeek: 2, startTime: "19:00" });
    expectDays(view.container, { Mon: 1, Tue: 1 });
    view.unmount();
    expectDays(render(<TimetableManager {...PROPS} initialClasses={saved} initialInactiveClasses={[]} />).container, { Mon: 1, Tue: 1 });
  });

  it("two separately created classes with the same name stay distinct", async () => {
    const view = render(<TimetableManager {...PROPS} initialClasses={[]} initialInactiveClasses={[]} />);
    await create([1]);
    await create([2]);
    expect(saved).toHaveLength(2);
    expect(saved[0].id).not.toBe(saved[1].id);
    expectDays(view.container, { Mon: 1, Tue: 1 });
    view.unmount();
    expectDays(render(<TimetableManager {...PROPS} initialClasses={saved} initialInactiveClasses={[]} />).container, { Mon: 1, Tue: 1 });
  });
});
