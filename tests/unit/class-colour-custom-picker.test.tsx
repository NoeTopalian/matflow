// @vitest-environment jsdom
//
// The class form's "+ Custom colour…" (25 Nov 2026): under the 14 swatches, an in-place panel with the native colour
// picker and a hex box editing the same colour, and a preview chip drawn by the timetable's own WeekChip.
//  - A code is six hex digits with or without "#", stored "#rrggbb"; a swatch's code chooses the swatch (no duplicate).
//  - A half-typed code is said wrong only once the person leaves the box, or on Save — which then sends nothing and
//    keeps the rest of the form. A swatch clears it.
//  - The same colour in other letter case is not a change; an unrelated save never sends `color`.
//  - A failed save keeps the chosen colour; the retry sends it once.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import type { ClassRow } from "@/app/dashboard/timetable/page";
import { CLASS_COLOURS } from "@/lib/class-colours";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/dashboard/timetable",
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

function makeClass(id: string, name: string, color: string | null): ClassRow {
  return {
    id, name, coachName: null, coachUserId: null, coachUser: null, location: null, locationId: null,
    duration: 60, maxCapacity: null, color, description: null,
    requiredRankId: null, requiredRank: null, maxRankId: null, maxRank: null,
    schedules: [{ id: `${id}-s`, dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
    roster: [], allowedTiers: [],
  };
}
const props = (classes: ClassRow[]) => ({
  initialClasses: classes, rankSystems: [], coachUsers: [], membershipTiers: [],
  primaryColor: "#3b82f6", role: "owner", currentUserId: "u1",
});

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let failPatches = 0;
function stubFetch() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/api/locations") || url.includes("/api/coach/today")) return { ok: true, json: async () => ({}) };
    if (init?.method === "PATCH" && !url.includes("dryRun") && failPatches > 0) {
      failPatches--;
      return { ok: false, status: 500, json: async () => ({ error: "Couldn't save the class." }) };
    }
    return { ok: true, json: async () => ({ ...makeClass("c1", "Advanced", null), ...JSON.parse(String(init?.body ?? "{}")), scheduleChange: null }) };
  }));
}
const patches = () => calls.filter((c) => c.init?.method === "PATCH" && !c.url.includes("dryRun"));
const lastPatchBody = () => JSON.parse(patches().at(-1)!.init!.body as string) as Record<string, unknown>;

beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); failPatches = 0; });
afterEach(() => { cleanup(); });

async function openEdit(cls: ClassRow) {
  stubFetch();
  render(<TimetableManager {...props([cls])} />);
  fireEvent.click(screen.getAllByLabelText(`Edit ${cls.name}`)[0]);
  const group = await screen.findByRole("group", { name: "Colour" });
  return group;
}
function openCustom() {
  const toggle = screen.getByRole("button", { name: "Custom colour…" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  return { hex: screen.getByLabelText("Custom colour: hex code") as HTMLInputElement, picker: screen.getByLabelText("Custom colour: pick a shade") as HTMLInputElement };
}
const pressed = (group: HTMLElement) => within(group).getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("aria-label"));
async function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(patches().length).toBeGreaterThan(0));
}

describe("+ Custom colour…", () => {
  it("sits under the swatches, opens in place (no second dialog) with a labelled picker, a hex box and a preview", async () => {
    const group = await openEdit(makeClass("c1", "Advanced", "#3b82f6"));
    const dialogsBefore = screen.queryAllByRole("dialog").length;
    expect(within(group).queryByRole("button", { name: "Custom colour…" })).toBeNull();
    const { hex, picker } = openCustom();
    expect(screen.queryAllByRole("dialog").length).toBe(dialogsBefore);
    expect(picker.type).toBe("color");
    expect(picker.value).toBe("#3b82f6");
    expect(hex.value).toBe("#3b82f6");
    const preview = screen.getByTestId("class-colour-preview");
    expect(preview.getAttribute("aria-hidden")).toBe("true");
    expect(preview.textContent).toContain("Advanced");
    expect(preview.textContent).toContain("18:00");
    // The swatches are unchanged: all 14, in order.
    expect(within(group).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(CLASS_COLOURS.map((c) => `Class colour: ${c.name}`));
  });

  it("a typed code (any case, with or without #) is chosen, shown as a pressed Custom colour swatch, and saved as #rrggbb", async () => {
    const group = await openEdit(makeClass("c1", "Advanced", "#3b82f6"));
    const { hex, picker } = openCustom();
    fireEvent.change(hex, { target: { value: "1A2B3C" } });
    expect(pressed(group)).toEqual(["Class colour: Custom colour"]);
    expect(screen.getByTestId("class-colour-name").textContent).toBe("Custom colour #1a2b3c");
    expect(picker.value).toBe("#1a2b3c");
    expect((screen.getByTestId("class-colour-preview").querySelector("button") as HTMLElement).style.background).toContain("26, 43, 60");
    await save();
    expect(lastPatchBody().color).toBe("#1a2b3c");
  });

  it("the native picker edits the same colour, and the box follows it", async () => {
    const group = await openEdit(makeClass("c1", "Advanced", "#3b82f6"));
    const { hex, picker } = openCustom();
    fireEvent.change(picker, { target: { value: "#00ff88" } });
    expect(hex.value).toBe("#00ff88");
    expect(pressed(group)).toEqual(["Class colour: Custom colour"]);
    await save();
    expect(lastPatchBody().color).toBe("#00ff88");
  });

  it("typing a swatch's own code chooses that swatch: no duplicate custom swatch", async () => {
    const group = await openEdit(makeClass("c1", "Advanced", "#94a3b8"));
    const { hex } = openCustom();
    fireEvent.change(hex, { target: { value: "#1E3A8A" } });
    expect(pressed(group)).toEqual(["Class colour: Navy"]);
    expect(within(group).queryByRole("button", { name: "Class colour: Custom colour" })).toBeNull();
    await save();
    expect(lastPatchBody().color).toBe("#1e3a8a");
  });

  it("preset → custom → preset on one class sends only the last preset", async () => {
    const group = await openEdit(makeClass("c1", "Advanced", "#3b82f6"));
    fireEvent.click(within(group).getByRole("button", { name: "Class colour: Teal" }));
    const { hex } = openCustom();
    fireEvent.change(hex, { target: { value: "#abcdef" } });
    expect(pressed(group)).toEqual(["Class colour: Custom colour"]);
    fireEvent.click(within(group).getByRole("button", { name: "Class colour: Red" }));
    expect(pressed(group)).toEqual(["Class colour: Red"]);
    expect(within(group).queryByRole("button", { name: "Class colour: Custom colour" })).toBeNull();
    expect(hex.value).toBe("#ef4444");
    await save();
    expect(lastPatchBody().color).toBe("#ef4444");
  });
});

describe("a code that is not one", () => {
  it("is not called wrong while typing; it is once the box is left", async () => {
    await openEdit(makeClass("c1", "Advanced", "#3b82f6"));
    const { hex } = openCustom();
    fireEvent.change(hex, { target: { value: "1a2" } });
    expect(screen.queryByTestId("class-colour-hex-error")).toBeNull();
    fireEvent.blur(hex);
    expect(screen.getByTestId("class-colour-hex-error").getAttribute("role")).toBe("alert");
    expect(hex.getAttribute("aria-invalid")).toBe("true");
    expect(hex.getAttribute("aria-describedby")).toBe("class-colour-hex-error");
  });

  it("Save sends nothing, says why beside the box, focuses it, and keeps the rest of the form", async () => {
    const group = await openEdit(makeClass("c1", "Advanced", "#3b82f6"));
    fireEvent.change(screen.getByPlaceholderText("e.g. Beginner BJJ"), { target: { value: "Advanced Gi" } });
    const { hex } = openCustom();
    fireEvent.change(hex, { target: { value: "#12345g" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(patches()).toHaveLength(0);
    expect(screen.getByTestId("class-colour-hex-error")).toBeTruthy();
    expect(document.activeElement).toBe(hex);
    expect((screen.getByDisplayValue("Advanced Gi") as HTMLInputElement).value).toBe("Advanced Gi");
    // The colour chosen before is still the chosen one.
    expect(pressed(group)).toEqual(["Class colour: Blue"]);
  });

  it("choosing a swatch clears the half-typed code and its error, and the save goes through", async () => {
    const group = await openEdit(makeClass("c1", "Advanced", "#3b82f6"));
    const { hex } = openCustom();
    fireEvent.change(hex, { target: { value: "zz" } });
    fireEvent.blur(hex);
    expect(screen.getByTestId("class-colour-hex-error")).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "Class colour: Purple" }));
    expect(screen.queryByTestId("class-colour-hex-error")).toBeNull();
    expect(hex.value).toBe("#8b5cf6");
    await save();
    expect(lastPatchBody().color).toBe("#8b5cf6");
  });

  it("closing the panel drops a half-typed code, and the save goes through without a colour", async () => {
    await openEdit(makeClass("c1", "Advanced", "#3b82f6"));
    const { hex } = openCustom();
    fireEvent.change(hex, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Custom colour…" }));
    expect(screen.queryByTestId("class-colour-custom")).toBeNull();
    await save();
    expect(lastPatchBody()).not.toHaveProperty("color");
  });
});

describe("saved colours are left alone", () => {
  it("a custom colour saved earlier reopens as the Current colour with its code; re-typing it in other case sends nothing", async () => {
    const group = await openEdit(makeClass("c1", "Advanced", "#ABCDEF"));
    expect(pressed(group)).toEqual(["Class colour: Current colour"]);
    expect(screen.getByTestId("class-colour-name").textContent).toBe("Current colour #ABCDEF");
    const { hex, picker } = openCustom();
    expect(picker.value).toBe("#abcdef");
    fireEvent.change(hex, { target: { value: "abcdef" } });
    expect(pressed(group)).toEqual(["Class colour: Current colour"]);
    await save();
    expect(lastPatchBody()).not.toHaveProperty("color");
  });

  it("a preset stored in capitals: picking that swatch is not a change", async () => {
    const group = await openEdit(makeClass("c1", "Advanced", "#3B82F6"));
    expect(pressed(group)).toEqual(["Class colour: Blue"]);
    fireEvent.click(within(group).getByRole("button", { name: "Class colour: Blue" }));
    await save();
    expect(lastPatchBody()).not.toHaveProperty("color");
  });

  it("a class with no colour of its own: opening the panel chooses nothing, and the save sends no colour", async () => {
    const group = await openEdit(makeClass("c1", "Imported", null));
    const { hex } = openCustom();
    expect(hex.value).toBe("");
    expect(pressed(group)).toEqual([]);
    await save();
    expect(lastPatchBody()).not.toHaveProperty("color");
  });

  it("a stored value that is not a hex code is kept on an unrelated save", async () => {
    await openEdit(makeClass("c1", "Advanced", "teal"));
    await save();
    expect(lastPatchBody()).not.toHaveProperty("color");
  });
});

describe("a failed save", () => {
  it("keeps the chosen custom colour, and the retry sends it once", async () => {
    failPatches = 1;
    const group = await openEdit(makeClass("c1", "Advanced", "#3b82f6"));
    const { hex } = openCustom();
    fireEvent.change(hex, { target: { value: "#224466" } });
    await save();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy());
    expect(pressed(group)).toEqual(["Class colour: Custom colour"]);
    expect((screen.getByLabelText("Custom colour: hex code") as HTMLInputElement).value).toBe("#224466");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(lastPatchBody().color).toBe("#224466");
  });
});
