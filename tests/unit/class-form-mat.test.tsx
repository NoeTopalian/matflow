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
import TimetableManager, { locationCounts, savedAsLocation } from "@/components/dashboard/TimetableManager";
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

describe("a location added from the form", () => {
  const SAVED_AT = "2026-11-05T10:00:05.000Z";
  const answerAdd = (extra: Record<string, unknown> = {}) =>
    stubFetch((call) => {
      if (call.url !== "/api/classes" || call.method !== "POST") return undefined;
      return { ok: true, status: 201, json: async () => ({ ...cls("Wrestling", "Mat 3", [[1, "18:00", "19:00"]], { matId: "m3" }), instancesCreated: 8, locationAdded: { id: "m3", name: "Mat 3", classIds: [], savedAt: SAVED_AT, ...extra } }) };
    });
  async function addMat3() {
    await createClass("Wrestling");
    choose("new");
    fireEvent.change(newBox()!, { target: { value: "Mat 3" } });
    submit("Create class");
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("“Mat 3” is saved as a location."), "success"));
  }
  const listed = async () => {
    await createClass("Judo");
    const values = options().map(([v]) => v);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    return values;
  };

  it("is kept through a refresh that was read before the save, and dropped by one read after it that lacks it", async () => {
    calls = answerAdd();
    const classes = CLUB();
    const view = render(<TimetableManager initialClasses={classes} mats={MATS} matsReadAt="2026-11-05T09:59:00.000Z" {...PROPS} />);
    await addMat3();
    expect(await listed()).toContain("mat:m3");
    // A refresh that was already in flight: read before the save, so it does not know of Mat 3 yet.
    view.rerender(<TimetableManager initialClasses={classes} mats={[...MATS]} matsReadAt="2026-11-05T10:00:04.000Z" {...PROPS} />);
    expect(await listed()).toContain("mat:m3");
    // Read after the save and still without it: Mat 3 was removed (the Mats sheet, another tab).
    view.rerender(<TimetableManager initialClasses={classes} mats={[...MATS]} matsReadAt="2026-11-05T10:00:06.000Z" {...PROPS} />);
    const after = await listed();
    expect(after).not.toContain("mat:m3");
    expect(after.slice(0, 2)).toEqual(["mat:m1", "mat:m2"]);
  });

  it("is listed once when the server's list brings it", async () => {
    calls = answerAdd();
    const classes = CLUB();
    const view = render(<TimetableManager initialClasses={classes} mats={MATS} {...PROPS} />);
    await addMat3();
    view.rerender(<TimetableManager initialClasses={classes} mats={[...MATS, { id: "m3", name: "Mat 3" }]} matsReadAt="2026-11-05T10:00:06.000Z" {...PROPS} />);
    expect((await listed()).filter((v) => v === "mat:m3")).toHaveLength(1);
  });

  /** A save of Wrestling picking "Upstairs": the server's answer, with the classes it took. */
  const answerUpstairs = (classIds: string[]) =>
    stubFetch((call) => {
      if (call.url !== "/api/classes" || call.method !== "POST") return undefined;
      return { ok: true, status: 201, json: async () => ({ ...cls("Wrestling", "Upstairs", [[1, "18:00", "19:00"]], { matId: "m9" }), instancesCreated: 8, locationAdded: { id: "m9", name: "Upstairs", classIds, savedAt: SAVED_AT } }) };
    });
  const upstairsOf = (classes: ReturnType<typeof CLUB>) => classes.filter((c) => c.location?.toLowerCase().trim() === "upstairs").map((c) => c.id);

  it("counts only the classes on the timetable, and says how many paused or archived ones went with them", async () => {
    const classes = CLUB();
    const paused = cls("Summer upstairs", "Upstairs", [[1, "09:00", "10:00"]], { lifecycle: "paused" });
    const archived = cls("Old upstairs", "upstairs", [[1, "09:00", "10:00"]], { lifecycle: "archived", archivedAt: "2026-10-01T00:00:00.000Z" });
    calls = answerUpstairs([...upstairsOf(classes), paused.id, archived.id]);
    render(<TimetableManager initialClasses={classes} initialInactiveClasses={[paused, archived]} mats={MATS} {...PROPS} />);
    await createClass("Wrestling");
    choose("place:Upstairs");
    submit("Create class");
    // Wrestling plus the three live classes typing it: 4; the paused and the archived one: 2 more.
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("“Upstairs” is saved as a location. 4 classes are now on it (and 2 not on the timetable)."), "success"));
  });

  it("says the split changed when the classes it took put a second mat in use", async () => {
    const classes = CLUB(); // Gi on Mat 1: one mat in use, so by time until someone chooses.
    calls = answerUpstairs(upstairsOf(classes));
    render(<TimetableManager initialClasses={classes} mats={MATS} {...PROPS} />);
    expect(screen.getByTestId("week-grid").getAttribute("data-mats")).toBeNull();
    await createClass("Wrestling");
    choose("place:Upstairs");
    submit("Create class");
    await waitFor(() => expect(toast).toHaveBeenCalledWith("The timetable is now split by mat.", "info"));
    expect(screen.getByTestId("week-grid").getAttribute("data-mats")).toBe("true");
  });

  it("keeps the classes it took on the new mat through a refresh read before the save, so the split does not flicker", async () => {
    const classes = CLUB();
    const typed = upstairsOf(classes);
    calls = answerUpstairs(typed);
    const view = render(<TimetableManager initialClasses={classes} mats={MATS} matsReadAt="2026-11-05T09:59:00.000Z" {...PROPS} />);
    await createClass("Wrestling");
    choose("place:Upstairs");
    submit("Create class");
    await waitFor(() => expect(toast).toHaveBeenCalledWith("The timetable is now split by mat.", "info"));
    // A refresh that was in flight: read before the save, so its classes still type "Upstairs" on no mat.
    view.rerender(<TimetableManager initialClasses={CLUB().map((c, i) => ({ ...c, id: classes[i].id }))} mats={[...MATS]} matsReadAt="2026-11-05T10:00:04.000Z" {...PROPS} />);
    expect(screen.getByTestId("week-grid").getAttribute("data-mats")).toBe("true");
    edit("Open mat");
    expect(select().value).toBe("mat:m9");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(toast.mock.calls.filter(([t]) => /now split by/.test(String(t)))).toEqual([["The timetable is now split by mat.", "info"]]);
  });

  it("takes the club's other classes that type its name with it, says how many, and lists the name once", async () => {
    // Yoga and two Upstairs classes: the server put Open mat and Upstairs drills (typed "Upstairs") on the new mat.
    const classes = CLUB();
    const typed = classes.filter((c) => c.location?.toLowerCase().trim() === "upstairs").map((c) => c.id);
    calls = stubFetch((call) => {
      if (call.url !== "/api/classes" || call.method !== "POST") return undefined;
      return { ok: true, status: 201, json: async () => ({ ...cls("Wrestling", "Upstairs", [[1, "18:00", "19:00"]], { matId: "m9" }), instancesCreated: 8, locationAdded: { id: "m9", name: "Upstairs", classIds: typed, savedAt: SAVED_AT } }) };
    });
    render(<TimetableManager initialClasses={classes} mats={MATS} {...PROPS} />);
    await createClass("Wrestling");
    choose("place:Upstairs");
    submit("Create class");
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining(`“Upstairs” is saved as a location. ${typed.length + 1} classes are now on it.`), "success"));
    // The classes that typed it are shown on it at once: one of them opens on the saved location, listed once.
    edit("Open mat");
    expect(select().value).toBe("mat:m9");
    const texts = options().map(([, t]) => t);
    expect(texts.filter((t) => t === "Upstairs")).toHaveLength(1);
    expect(texts).not.toContain("upstairs");
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
    // Never the same text as the saved location beside it.
    expect(select().selectedOptions[0].textContent).toBe("mat 2 (typed on this class only)");
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

describe("what the toast says about a new location", () => {
  it("never says 0 classes: a paused class saved alone is counted as not on the timetable", () => {
    // The saved class is paused and took nothing with it.
    expect(locationCounts(false, [], new Set())).toEqual({ live: 0, notLive: 1 });
    expect(savedAsLocation("Upstairs", 0, 1)).toBe("“Upstairs” is saved as a location. 1 class not on the timetable is on it.");
    // Paused, with two archived ones typing the name.
    expect(savedAsLocation("Upstairs", 0, 3)).toBe("“Upstairs” is saved as a location. 3 classes not on the timetable are on it.");
  });

  it("counts the saved class when it is on the timetable, and the others by whether they are", () => {
    const live = new Set(["a", "b"]);
    expect(locationCounts(true, ["a", "x"], live)).toEqual({ live: 2, notLive: 1 });
    // A paused class saved, taking a live one: one on the timetable, the saved one not.
    expect(locationCounts(false, ["a"], live)).toEqual({ live: 1, notLive: 1 });
    expect(savedAsLocation("Cage", 1, 0)).toBe("“Cage” is saved as a location. 1 class is now on it.");
    expect(savedAsLocation("Cage", 2, 1)).toBe("“Cage” is saved as a location. 2 classes are now on it (and 1 not on the timetable).");
  });
});

describe("no two options read the same", () => {
  it("whichever class is opened", () => {
    const classes = [...CLUB(), cls("Late", "Mat 1", [[0, "09:00", "10:00"]]), cls("Beach", "The sports hall down the road", [[0, "11:00", "12:00"]])];
    render(<TimetableManager initialClasses={classes} mats={MATS} {...PROPS} />);
    for (const c of classes) {
      edit(c.name);
      const texts = options().map(([, t]) => (t ?? "").trim().toLowerCase());
      expect(new Set(texts).size, `${c.name}: ${texts.join(" | ")}`).toBe(texts.length);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    }
  });
});

describe("refusals and failures", () => {
  it("a pasted name longer than a location can be is sent whole, and the refusal is said beside the field", async () => {
    const thirty = "x".repeat(30);
    calls = answerSaves(400, { error: LOCATION_ERRORS.tooLong, reason: "location" });
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    await createClass("Wrestling");
    choose("new");
    expect(newBox()!.getAttribute("maxlength")).toBeNull();
    fireEvent.change(newBox()!, { target: { value: thirty } });
    expect(newBox()!.value).toBe(thirty);
    submit("Create class");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(locationPart(saves(calls)[0].body)).toEqual({ matName: thirty });
    expect((await screen.findByTestId("class-form-location-error")).textContent).toBe(LOCATION_ERRORS.tooLong);
    expect(LOCATION_ERRORS.tooLong).toMatch(/Use a shorter name/);
    expect(newBox()!.value).toBe(thirty);
  });

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
    // Focus is moved by an effect, which React runs after the commit that showed the sentence: wait for it.
    await waitFor(() => expect(document.activeElement).toBe(newBox()));
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
  // A MatFlow support session is signed in as the owner, and the page renders the owner's form for it (Noe, 7 Nov
  // 2026: "Yes, allow support"; app/dashboard/timetable/page.tsx passes nothing about support any more).
  it("an owner, and so a support session, sees 'Add a new location…', no support wording, and the saved-location toast", async () => {
    calls = stubFetch((call) => {
      if (call.url !== "/api/classes" || call.method !== "POST") return undefined;
      return { ok: true, status: 201, json: async () => ({ ...cls("Wrestling", "The beach", [[1, "18:00", "19:00"]], { matId: "m9" }), instancesCreated: 8, locationAdded: { id: "m9", name: "The beach", classIds: [] } }) };
    });
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} />);
    await createClass("Wrestling");
    expect(options().at(-1)).toEqual(["new", "Add a new location…"]);
    expect(options().map(([, t]) => t)).not.toContain("Type a place");
    choose("new");
    expect(screen.queryByTestId("class-form-new-location-hint")).toBeNull();
    expect(screen.queryByLabelText("Place for this class")).toBeNull();
    fireEvent.change(newBox()!, { target: { value: "The beach" } });
    submit("Create class");
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("“The beach” is saved as a location."), "success"));
    expect(locationPart(saves(calls)[0].body)).toEqual({ matName: "The beach" });
  });

  it("a coach has no class form, so a coach cannot type a new location or add one", () => {
    render(<TimetableManager initialClasses={CLUB()} mats={MATS} {...PROPS} role="coach" />);
    expect(screen.queryAllByRole("button", { name: "Add class" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /^Edit / })).toHaveLength(0);
    expect(screen.queryByLabelText("Location")).toBeNull();
  });
});
