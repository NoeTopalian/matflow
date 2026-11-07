// @vitest-environment jsdom
//
// The class form's Location (Noe, 7 Nov 2026: "The location field should save
// whats written into it as a Location and then when you do it again it lets
// you select from a previous list or add a new one, very simply"). One select:
// the club's saved locations (its mats) in the club's order, then the places
// typed on its classes that are not mats yet, "No location", and "Add a new
// location…", which reveals a box for the name. What is sent matters as much
// as what is shown: a saved location is sent by id, a typed place or a new
// name by name (the server finds or adds the mat), and an edit that does not
// change the Location sends nothing about it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import { PROPS, cls, stubFetch, type Call } from "./helpers/timetable-fixture";
import { LOCATION_ERRORS } from "@/lib/mats";

const { refresh, toast } = vi.hoisted(() => ({ refresh: vi.fn(), toast: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const MATS = [{ id: "m1", name: "Mat 1" }, { id: "m2", name: "Mat 2" }];
const select = () => screen.getByLabelText("Location") as HTMLSelectElement;
const newBox = (label = "Name of the new location") => screen.queryByLabelText(label) as HTMLInputElement | null;
const options = () => Array.from(select().options).map((o) => [o.value, o.textContent]);
const saves = (calls: Call[]) => calls.filter((c) => c.url.startsWith("/api/classes") && !c.url.includes("dryRun") && (c.method === "POST" || c.method === "PATCH"));
const LOCATION_KEYS = ["matId", "matName", "location"];
const locationPart = (body: Record<string, unknown> | undefined) =>
  Object.fromEntries(Object.entries(body ?? {}).filter(([k]) => LOCATION_KEYS.includes(k)));

let calls: Call[] = [];
const answerSaves = (status = 200, refusal: Record<string, unknown> = { error: "Failed to update class" }) =>
  stubFetch((call) => {
    if (!call.url.startsWith("/api/classes")) return undefined;
    if (status >= 400) return { ok: false, status, json: async () => refusal };
    return { ok: true, status: call.method === "POST" ? 201 : 200, json: async () => ({ ...cls(String(call.body?.name ?? "Gi"), null, [[1, "18:00", "19:00"]]), ...call.body, instancesCreated: 8 }) };
  });

/** Sean's club: two mats, and places typed on classes that are not on one. */
const CLUB = () => [
  cls("Gi", "Mat 1", [[1, "18:00", "19:00"]], { matId: "m1" }),
  cls("Yoga", "Sports hall", [[2, "10:00", "11:00"]]),
  cls("No-Gi", "upstairs", [[3, "19:00", "20:00"]]),
  cls("Open mat", "Upstairs", [[4, "19:00", "20:00"]]),
  cls("Upstairs drills", "Upstairs", [[5, "19:00", "20:00"]]),
  // Typed, and it names a mat: it is not offered as a place (the mat is).
  cls("Kids", "mat 2", [[6, "10:00", "11:00"]]),
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 5, 10, 0));
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  calls = answerSaves();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function createClass(name: string) {
  fireEvent.click(screen.getAllByRole("button", { name: "Add class" })[0]);
  fireEvent.change(screen.getByLabelText("Class Name"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Add day" }));
}
const edit = (name: string) => fireEvent.click(screen.getAllByRole("button", { name: new RegExp(`^Edit ${name}`) })[0]);
const submit = (label: "Create class" | "Save changes") => fireEvent.click(screen.getByRole("button", { name: label }));
const choose = (value: string) => fireEvent.change(select(), { target: { value } });

describe("the Location list", () => {
  it("a club with nothing saved or typed: No location and Add a new location…; a new name is sent by name", async () => {
    render(<TimetableManager initialClasses={[cls("Gi", null, [[1, "18:00", "19:00"]])]} {...PROPS} />);
    await createClass("No-Gi");
    expect(options()).toEqual([["none", "No location"], ["new", "Add a new location…"]]);
    expect(select().value).toBe("none");
    expect(newBox()).toBeNull();
    choose("new");
    fireEvent.change(newBox()!, { target: { value: " Mat 1 " } });
    submit("Create class");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(locationPart(saves(calls)[0].body)).toEqual({ matName: "Mat 1" });
  });

  it("lists the saved locations in the club's order, then the typed places that are not saved yet (one per name), then No location and Add new", async () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    await createClass("Wrestling");
    expect(options()).toEqual([
      ["mat:m1", "Mat 1"],
      ["mat:m2", "Mat 2"],
      ["place:Sports hall", "Sports hall"],
      ["place:Upstairs", "Upstairs"],
      ["none", "No location"],
      ["new", "Add a new location…"],
    ]);
    expect(select().value).toBe("none");
  });

  it("a place typed only on a paused class is offered; one on an archived class is not", async () => {
    render(
      <TimetableManager
        initialClasses={[cls("Gi", "Mat 1", [[1, "18:00", "19:00"]], { matId: "m1" })]}
        initialInactiveClasses={[
          cls("Summer camp", "Field", [[1, "09:00", "10:00"]], { lifecycle: "paused" }),
          cls("Old class", "Basement", [[1, "09:00", "10:00"]], { lifecycle: "archived", archivedAt: "2026-10-01T00:00:00.000Z" }),
        ]}
        mats={MATS}
        {...PROPS}
      />,
    );
    await createClass("Wrestling");
    const values = options().map(([v]) => v);
    expect(values).toContain("place:Field");
    expect(values).not.toContain("place:Basement");
  });

  it("there is one field: no Mat select and no separate place box", async () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    await createClass("Wrestling");
    expect(screen.queryByLabelText("Mat")).toBeNull();
    expect(screen.queryByLabelText("Place (not on a mat)")).toBeNull();
  });
});

describe("what a new class sends", () => {
  it("picking a saved location sends its id, and nothing else about the place", async () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    await createClass("Wrestling");
    choose("mat:m2");
    submit("Create class");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(locationPart(saves(calls)[0].body)).toEqual({ matId: "m2" });
  });

  it("picking a typed place sends it by name (the server makes it a saved location for this class only)", async () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    await createClass("Wrestling");
    choose("place:Upstairs");
    submit("Create class");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(locationPart(saves(calls)[0].body)).toEqual({ matName: "Upstairs" });
  });

  it("a new name is sent as a name, and an empty one cannot be saved", async () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    await createClass("Wrestling");
    choose("new");
    expect(newBox()).not.toBeNull();
    expect(screen.getByText(/a name for the new location/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create class" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(newBox()!, { target: { value: "Cage" } });
    submit("Create class");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(locationPart(saves(calls)[0].body)).toEqual({ matName: "Cage" });
  });

  it("No location sends no mat and no place", async () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    await createClass("Wrestling");
    submit("Create class");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(locationPart(saves(calls)[0].body)).toEqual({ matId: null, location: null });
  });

  it("a location added by a save is a saved location in the next form at once, and the owner is told", async () => {
    calls = stubFetch((call) => {
      if (call.url !== "/api/classes" || call.method !== "POST") return undefined;
      return { ok: true, status: 201, json: async () => ({ ...cls("Wrestling", "Mat 3", [[1, "18:00", "19:00"]], { matId: "m3" }), instancesCreated: 8, locationAdded: { id: "m3", name: "Mat 3" } }) };
    });
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    await createClass("Wrestling");
    choose("new");
    fireEvent.change(newBox()!, { target: { value: "Mat 3" } });
    submit("Create class");
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("“Mat 3” is saved as a location."), "success"));
    await createClass("Judo");
    expect(options().slice(0, 3)).toEqual([["mat:m1", "Mat 1"], ["mat:m2", "Mat 2"], ["mat:m3", "Mat 3"]]);
    expect(options().map(([v]) => v)).not.toContain("place:Mat 3");
  });
});

describe("a location added from the form, then removed", () => {
  it("is gone from the list as soon as the server's mats no longer have it", async () => {
    calls = stubFetch((call) => {
      if (call.url !== "/api/classes" || call.method !== "POST") return undefined;
      return { ok: true, status: 201, json: async () => ({ ...cls("Wrestling", "Mat 3", [[1, "18:00", "19:00"]], { matId: "m3" }), instancesCreated: 8, locationAdded: { id: "m3", name: "Mat 3" } }) };
    });
    const classes = CLUB();
    const view = render(<TimetableManager initialClasses={classes} mats={MATS} {...PROPS} />);
    await createClass("Wrestling");
    choose("new");
    fireEvent.change(newBox()!, { target: { value: "Mat 3" } });
    submit("Create class");
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("“Mat 3” is saved as a location."), "success"));
    await createClass("Judo");
    expect(options().map(([v]) => v)).toContain("mat:m3");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // The refresh after Mat 3 was removed in the Mats sheet: a new list without it.
    view.rerender(<TimetableManager initialClasses={classes} mats={[...MATS]} {...PROPS} />);
    await createClass("Judo");
    expect(options().map(([v]) => v)).not.toContain("mat:m3");
    expect(options().slice(0, 2)).toEqual([["mat:m1", "Mat 1"], ["mat:m2", "Mat 2"]]);
  });
});

describe("what an edit sends", () => {
  it("a class on a mat starts on it, and an edit that leaves it there sends nothing about the place", async () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    edit("Gi");
    expect(select().value).toBe("mat:m1");
    fireEvent.change(screen.getByLabelText("Class Name"), { target: { value: "Gi Fundamentals" } });
    submit("Save changes");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(saves(calls)[0].body).toMatchObject({ name: "Gi Fundamentals" });
    expect(locationPart(saves(calls)[0].body)).toEqual({});
  });

  it("moving a class to another saved location sends only its id", async () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    edit("Gi");
    choose("mat:m2");
    submit("Save changes");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(locationPart(saves(calls)[0].body)).toEqual({ matId: "m2" });
  });

  it("No location takes the class off its mat and clears its place", async () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    edit("Gi");
    choose("none");
    submit("Save changes");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(locationPart(saves(calls)[0].body)).toEqual({ matId: null, location: null });
  });

  it("a class with a typed place starts on that place, and an edit that keeps it does not make it a saved location", async () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    edit("Yoga");
    expect(select().value).toBe("place:Sports hall");
    fireEvent.change(screen.getByLabelText("Class Name"), { target: { value: "Yin Yoga" } });
    submit("Save changes");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(locationPart(saves(calls)[0].body)).toEqual({});
  });

  it("a class whose typed place is a saved location's name opens on its typed place, and an unrelated edit does not move it", async () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    edit("Kids");
    expect(select().value).toBe("keep");
    expect(select().selectedOptions[0].textContent).toBe("mat 2");
    fireEvent.change(screen.getByLabelText("Class Name"), { target: { value: "Kids BJJ" } });
    submit("Save changes");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(locationPart(saves(calls)[0].body)).toEqual({});
  });

  it("the same class is moved onto the saved location only when it is picked", async () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    edit("Kids");
    choose("mat:m2");
    submit("Save changes");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(locationPart(saves(calls)[0].body)).toEqual({ matId: "m2" });
  });

  it("a typed place too long to be a saved location is shown as it is and kept", async () => {
    const long = "The sports hall down the road";
    render(<TimetableManager initialClasses={[...CLUB(), cls("Beach", long, [[0, "09:00", "10:00"]])]} mats={MATS} {...PROPS} />);
    edit("Beach");
    expect(select().value).toBe("keep");
    expect(select().selectedOptions[0].textContent).toBe(long);
    submit("Save changes");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(locationPart(saves(calls)[0].body)).toEqual({});
  });
});

describe("refusals and failures", () => {
  it("a failed save keeps the typed name and the form; the retry sends it once", async () => {
    calls = answerSaves(500, { error: "Failed to create class" });
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    await createClass("Wrestling");
    choose("new");
    fireEvent.change(newBox()!, { target: { value: "Cage" } });
    submit("Create class");
    await screen.findByTestId("class-form-save-error");
    expect(select().value).toBe("new");
    expect(newBox()?.value).toBe("Cage");
    expect(saves(calls)).toHaveLength(1);
    const retry = answerSaves();
    submit("Create class");
    await waitFor(() => expect(saves(retry)).toHaveLength(1));
    expect(locationPart(saves(retry)[0].body)).toEqual({ matName: "Cage" });
  });

  it("a refused Location (twelve already) is said beside the field, not under the buttons, with the typed name kept and focused", async () => {
    const limit = LOCATION_ERRORS.limit;
    calls = answerSaves(409, { error: limit, reason: "location" });
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    await createClass("Wrestling");
    choose("new");
    fireEvent.change(newBox()!, { target: { value: "Cage" } });
    submit("Create class");
    const said = await screen.findByTestId("class-form-location-error");
    expect(said.textContent).toBe(limit);
    expect(screen.queryByTestId("class-form-save-error")).toBeNull();
    expect(newBox()?.value).toBe("Cage");
    expect(newBox()?.getAttribute("aria-describedby")).toBe("class-form-location-error");
    expect(newBox()?.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(newBox());
    expect(limit).toMatch(/Remove a location under Mats/);
    // Changing what was typed clears the refusal until the next save.
    fireEvent.change(newBox()!, { target: { value: "Cage 2" } });
    expect(screen.queryByTestId("class-form-location-error")).toBeNull();
    expect(newBox()?.getAttribute("aria-invalid")).toBeNull();
    expect(newBox()?.getAttribute("aria-describedby")).toBeNull();
    // A second refused save says it again.
    submit("Create class");
    expect((await screen.findByTestId("class-form-location-error")).textContent).toBe(limit);
    // Changing the select clears it too.
    choose("mat:m1");
    expect(screen.queryByTestId("class-form-location-error")).toBeNull();
    expect(select().getAttribute("aria-invalid")).toBeNull();
  });

  it("the box for a new name has a visible label and no example text standing in for one", async () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    await createClass("Wrestling");
    choose("new");
    const box = newBox()!;
    const label = document.querySelector(`label[for="${box.id}"]`);
    expect(label?.textContent).toBe("Name of the new location");
    expect(box.getAttribute("placeholder")).toBeNull();
  });
});

describe("who can use it", () => {
  it("in a support session the last option is 'Type a place', and the box says it stays this class's place", async () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} supportSession {...PROPS} />);
    await createClass("Wrestling");
    expect(options().at(-1)).toEqual(["new", "Type a place"]);
    expect(options().map(([, t]) => t)).not.toContain("Add a new location…");
    choose("new");
    const box = newBox("Place for this class")!;
    expect(box).not.toBeNull();
    const hint = screen.getByTestId("class-form-new-location-hint");
    expect(hint.textContent).toMatch(/can.t add saved locations/);
    expect(box.getAttribute("aria-describedby")).toBe(hint.id);
    fireEvent.change(box, { target: { value: "The beach" } });
    submit("Create class");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    // Sent by name as ever; the server keeps it as this class's typed place.
    expect(locationPart(saves(calls)[0].body)).toEqual({ matName: "The beach" });
  });

  it("an owner sees 'Add a new location…' and no support hint", async () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    await createClass("Wrestling");
    expect(options().at(-1)).toEqual(["new", "Add a new location…"]);
    choose("new");
    expect(screen.queryByTestId("class-form-new-location-hint")).toBeNull();
  });

  it("a coach has no class form, so a coach cannot type a new location or add one", () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} role="coach" />);
    expect(screen.queryAllByRole("button", { name: "Add class" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /^Edit / })).toHaveLength(0);
    expect(screen.queryByLabelText("Location")).toBeNull();
  });
});
