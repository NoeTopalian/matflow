// @vitest-environment jsdom
//
// The Mats sheet (plan §4.8): every row of its behaviour table, against a
// small stand-in for the mats routes that keeps real state, so a test reads
// "the club has this, the owner does that, the club now has this".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MatsSheet } from "@/components/dashboard/MatsSheet";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

type Mat = { id: string; name: string; classCount: number };
type Place = { name: string; key: string; classCount: number; tooLong: boolean; matId: string | null };
type Call = { url: string; method: string; body: Record<string, unknown> | undefined };

const place = (name: string, classCount: number, over: Partial<Place> = {}): Place => ({ name, key: name.toLowerCase(), classCount, tooLong: name.length > 24, matId: null, ...over });

let server: {
  mats: Mat[];
  places: Place[];
  noPlaceCount: number;
  /** "METHOD /path" → a status to answer with, or "network" to reject. Cleared by the test when the fault is over. */
  fail: Record<string, number | "network">;
  /** What a refusal says. */
  errorText: Record<string, string>;
  adoptAnswer: { matsAdded: number; classesAttached: number; layoutChanged: boolean; layout: { effective: "mat" | "time" } };
  seq: number;
};
let calls: Call[] = [];
const sent = (method: string, path?: string) => calls.filter((c) => c.method === method && (path === undefined || c.url === path));

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  calls = [];
  server = {
    mats: [], places: [], noPlaceCount: 0, fail: {}, errorText: {},
    adoptAnswer: { matsAdded: 2, classesAttached: 21, layoutChanged: true, layout: { effective: "mat" } },
    seq: 0,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      const key = `${method} ${url.replace(/\/api\/mats\/(?!order|adopt|suggestions)[^/]+$/, "/api/mats/:id")}`;
      const fault = server.fail[key];
      if (fault === "network") throw new TypeError("Failed to fetch");
      if (typeof fault === "number") return { ok: false, status: fault, json: async () => ({ error: server.errorText[key] }) };
      const ok = (data: unknown, status = 200) => ({ ok: true, status, json: async () => data });
      // Copies, as a response is: the sheet must never share an array with the "server".
      if (key === "GET /api/mats") return ok({ mats: server.mats.map((m) => ({ ...m })), layout: { stored: null, effective: "time" } });
      if (key === "GET /api/mats/suggestions") return ok({ suggestions: server.places.map((p) => ({ ...p })), noPlaceCount: server.noPlaceCount, matCount: server.mats.length });
      if (key === "POST /api/mats") {
        const mat = { id: `new-${++server.seq}`, name: String(body?.name), classCount: 0 };
        server.mats.push(mat);
        return ok(mat, 201);
      }
      if (key === "PATCH /api/mats/:id") {
        const mat = server.mats.find((m) => url.endsWith(`/${m.id}`))!;
        mat.name = String(body?.name);
        return ok({ id: mat.id, name: mat.name, changed: true });
      }
      if (key === "DELETE /api/mats/:id") {
        server.mats = server.mats.filter((m) => !url.endsWith(`/${m.id}`));
        return ok({ ok: true });
      }
      if (key === "PUT /api/mats/order") {
        const ids = body?.ids as string[];
        server.mats = ids.map((id) => server.mats.find((m) => m.id === id)!);
        return ok({ ok: true, changed: true });
      }
      if (key === "POST /api/mats/adopt") {
        for (const k of body?.keys as string[]) {
          const p = server.places.find((x) => x.key === k);
          if (!p) continue;
          const existing = server.mats.find((m) => m.id === p.matId);
          if (existing) existing.classCount += p.classCount;
          else server.mats.push({ id: `new-${++server.seq}`, name: p.name, classCount: p.classCount });
          server.places = server.places.filter((x) => x !== p);
        }
        return ok(server.adoptAnswer);
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
});
afterEach(cleanup);

const onChanged = vi.fn();
const onClose = vi.fn();
async function open() {
  const view = render(<MatsSheet open onClose={onClose} onChanged={onChanged} />);
  await waitFor(() => expect(screen.queryByText("Loading your mats…")).toBeNull());
  return view;
}
const three = (): Mat[] => [{ id: "m1", name: "Mat 1", classCount: 9 }, { id: "m2", name: "Mat 2", classCount: 1 }, { id: "m3", name: "Mat 3", classCount: 0 }];
const rows = () => screen.getAllByTestId("mats-row");
const names = () => rows().map((r) => (within(r).getByRole("textbox") as HTMLInputElement).value);
const field = (name: string) => screen.getByLabelText(`${name} name`) as HTMLInputElement;
const live = () => screen.getByTestId("mats-live").textContent;

describe("first run: the club has typed places and no mats", () => {
  beforeEach(() => {
    server.places = [place("Mat 1", 9), place("Mat 2", 12), place("The big hall behind reception", 2)];
    server.noPlaceCount = 3;
  });

  it("lists each typed place with its class count, ticked; a place too long for a mat name is unticked with its reason", async () => {
    await open();
    expect(screen.getByRole("heading", { name: "Places typed on your classes" })).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((b) => [b.getAttribute("aria-checked"), (b as HTMLButtonElement).disabled])).toEqual([["true", false], ["true", false], ["false", true]]);
    expect(screen.getByText("Mat 1 · 9 classes")).toBeTruthy();
    expect(screen.getByText("Mat 2 · 12 classes")).toBeTruthy();
    expect(screen.getByText("Too long for a mat name (24 characters at most)")).toBeTruthy();
    expect(screen.getByText("3 classes have no place. They will show under No mat.")).toBeTruthy();
  });

  it("offers at most twelve: the thirteenth place is unticked with its reason", async () => {
    server.places = Array.from({ length: 13 }, (_, i) => place(`Area ${i + 1}`, 1));
    await open();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.filter((b) => b.getAttribute("aria-checked") === "true")).toHaveLength(12);
    expect((boxes[12] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("You can have up to 12 mats")).toBeTruthy();
  });

  it("'Add these as mats' sends only the ticked places, then shows the list, says what happened and puts focus on the heading", async () => {
    await open();
    fireEvent.click(screen.getAllByRole("checkbox")[1]); // untick Mat 2
    server.adoptAnswer = { matsAdded: 1, classesAttached: 9, layoutChanged: false, layout: { effective: "time" } };
    fireEvent.click(screen.getByRole("button", { name: "Add these as mats" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your mats" })).toBeTruthy());
    expect(sent("POST", "/api/mats/adopt").map((c) => c.body)).toEqual([{ keys: ["mat 1"] }]);
    expect(screen.getByTestId("mats-notice").textContent).toBe("1 mat added. 9 classes are now on a mat.");
    expect(live()).toBe("1 mat added. 9 classes are now on a mat.");
    expect(names()).toEqual(["Mat 1"]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Your mats" })));
    // The page is told; nothing about the split changed, so it may say so itself if it ever does.
    expect(onChanged).toHaveBeenCalledWith({ quiet: false });
  });

  it("says the week is now split by mat when adding the mats changed it, and tells the page it has said so", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Add these as mats" }));
    await waitFor(() => expect(screen.getByTestId("mats-notice").textContent).toBe("2 mats added. 21 classes are now on a mat. The week is now split by mat."));
    expect(sent("POST", "/api/mats/adopt")[0].body).toEqual({ keys: ["mat 1", "mat 2"] });
    expect(onChanged).toHaveBeenCalledWith({ quiet: true });
  });

  it("with nothing ticked the button cannot be pressed", async () => {
    await open();
    for (const box of screen.getAllByRole("checkbox").slice(0, 2)) fireEvent.click(box);
    expect((screen.getByRole("button", { name: "Add these as mats" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a failed 'Add these as mats' keeps the boxes ticked and says so; pressing again sends one more request", async () => {
    server.fail["POST /api/mats/adopt"] = 500;
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Add these as mats" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't add the mats. Try again.");
    expect(screen.getAllByRole("checkbox").map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "true", "false"]);
    expect(onChanged).not.toHaveBeenCalled();
    delete server.fail["POST /api/mats/adopt"];
    fireEvent.click(screen.getByRole("button", { name: "Add these as mats" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your mats" })).toBeTruthy());
    expect(sent("POST", "/api/mats/adopt")).toHaveLength(2);
  });

  it("'Add a mat myself' goes to the empty list with a new, focused row", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Add a mat myself" }));
    expect(screen.getByRole("heading", { name: "Your mats" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("New mat name"));
    expect(sent("POST")).toEqual([]);
  });

  it("says so when the typed places cannot be loaded, and Try again reads them again", async () => {
    server.fail["GET /api/mats/suggestions"] = 500;
    await open();
    expect(screen.getByText("Couldn’t load your typed places.")).toBeTruthy();
    delete server.fail["GET /api/mats/suggestions"];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Mat 1 · 9 classes")).toBeTruthy());
  });
});

describe("no mats and nothing typed", () => {
  it("says what a mat is for and offers 'Add a mat'", async () => {
    await open();
    expect(screen.getByText("No mats yet. Add each training area, for example Mat 1 and Mat 2.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a mat" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Places typed on your classes" })).toBeNull();
  });

  it("says so when the mats themselves cannot be loaded", async () => {
    server.fail["GET /api/mats"] = 500;
    await open();
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t load your mats.");
    delete server.fail["GET /api/mats"];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your mats" })).toBeTruthy());
  });
});

describe("the list", () => {
  beforeEach(() => {
    server.mats = three();
  });

  it("shows the mats in order with labelled fields; the first cannot move up and the last cannot move down, but both stay buttons", async () => {
    await open();
    expect(screen.getByText("The order here is the order of the columns.")).toBeTruthy();
    expect(names()).toEqual(["Mat 1", "Mat 2", "Mat 3"]);
    expect(field("Mat 1").maxLength).toBe(24);
    expect(screen.getByRole("button", { name: "Move Mat 1 up" }).getAttribute("aria-disabled")).toBe("true");
    expect((screen.getByRole("button", { name: "Move Mat 1 up" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Move Mat 1 down" }).getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByRole("button", { name: "Move Mat 3 down" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Remove Mat 2" })).toBeTruthy();
  });

  it("renames on Enter: one request, 'Saved' beside the row and announced, and the page is told", async () => {
    await open();
    fireEvent.change(field("Mat 2"), { target: { value: "  Cage " } });
    fireEvent.keyDown(field("Mat 2"), { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("mats-saved")).toBeTruthy());
    expect(sent("PATCH").map((c) => [c.url, c.body])).toEqual([["/api/mats/m2", { name: "Cage" }]]);
    expect(names()).toEqual(["Mat 1", "Cage", "Mat 3"]);
    expect(live()).toBe("Saved");
    expect(onChanged).toHaveBeenCalledTimes(1);
    // Leaving the field afterwards sends nothing more.
    fireEvent.blur(field("Cage"));
    expect(sent("PATCH")).toHaveLength(1);
  });

  it("renames on leaving the field; an unchanged name sends nothing", async () => {
    await open();
    fireEvent.change(field("Mat 2"), { target: { value: "Cage" } });
    fireEvent.blur(field("Mat 2"));
    await waitFor(() => expect(sent("PATCH")).toHaveLength(1));
    fireEvent.change(field("Mat 1"), { target: { value: "Mat 1 " } });
    fireEvent.blur(field("Mat 1"));
    fireEvent.focus(field("Mat 3"));
    fireEvent.blur(field("Mat 3"));
    expect(sent("PATCH")).toHaveLength(1);
  });

  it("Enter and then leaving the field while the save is in flight is one request", async () => {
    await open();
    fireEvent.change(field("Mat 2"), { target: { value: "Cage" } });
    fireEvent.keyDown(field("Mat 2"), { key: "Enter" });
    fireEvent.blur(screen.getAllByRole("textbox")[1]);
    await waitFor(() => expect(screen.getByTestId("mats-saved")).toBeTruthy());
    expect(sent("PATCH")).toHaveLength(1);
  });

  it("Escape drops an unsaved change and keeps the sheet open; nothing is sent", async () => {
    await open();
    fireEvent.change(field("Mat 2"), { target: { value: "Cage" } });
    const stopped = !fireEvent.keyDown(field("Mat 2"), { key: "Escape" });
    expect(names()).toEqual(["Mat 1", "Mat 2", "Mat 3"]);
    expect(sent("PATCH")).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    // (the key is not cancelled, only kept from the sheet: nothing depends on preventDefault)
    expect(stopped).toBe(false);
  });

  it("an empty name is refused beside the field without a request", async () => {
    await open();
    fireEvent.change(field("Mat 2"), { target: { value: "   " } });
    fireEvent.keyDown(field("Mat 2"), { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toBe("Give the mat a name.");
    expect(sent("PATCH")).toEqual([]);
  });

  it("a failed save keeps what was typed and says which mat, tied to the field", async () => {
    server.fail["PATCH /api/mats/:id"] = "network";
    await open();
    fireEvent.change(field("Mat 2"), { target: { value: "Cage" } });
    fireEvent.keyDown(field("Mat 2"), { key: "Enter" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn't save Mat 2. Try again.");
    const input = screen.getAllByRole("textbox")[1] as HTMLInputElement;
    expect(input.value).toBe("Cage");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    expect(live()).toBe("Couldn't save Mat 2. Try again.");
    expect(onChanged).not.toHaveBeenCalled();
    // One retry, one request.
    delete server.fail["PATCH /api/mats/:id"];
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("mats-saved")).toBeTruthy());
    expect(sent("PATCH")).toHaveLength(2);
  });

  it("a name the club already has is refused in the server's words, after the list is read again", async () => {
    server.fail["PATCH /api/mats/:id"] = 409;
    server.errorText["PATCH /api/mats/:id"] = "You already have a mat called Mat 1.";
    await open();
    const reads = sent("GET", "/api/mats").length;
    fireEvent.change(field("Mat 2"), { target: { value: "mat 1" } });
    fireEvent.keyDown(field("Mat 2"), { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toBe("You already have a mat called Mat 1.");
    expect(sent("GET", "/api/mats").length).toBe(reads + 1);
  });

  it("moving a mat sends the whole new order, announces where it is now and keeps focus with it", async () => {
    await open();
    const up = screen.getByRole("button", { name: "Move Mat 2 up" });
    up.focus();
    fireEvent.click(up);
    await waitFor(() => expect(live()).toBe("Mat 2 is now 1 of 3"));
    expect(sent("PUT", "/api/mats/order").map((c) => c.body)).toEqual([{ ids: ["m2", "m1", "m3"] }]);
    expect(names()).toEqual(["Mat 2", "Mat 1", "Mat 3"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Mat 2 up" }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("pressing a move that cannot happen sends nothing", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Move Mat 1 up" }));
    fireEvent.click(screen.getByRole("button", { name: "Move Mat 3 down" }));
    expect(sent("PUT")).toEqual([]);
  });

  it("a failed move leaves the list as it was and says so", async () => {
    server.fail["PUT /api/mats/order"] = 500;
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Move Mat 3 up" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't save that. Try again.", "error"));
    expect(names()).toEqual(["Mat 1", "Mat 2", "Mat 3"]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it.each([
    ["Mat 1", "Its 9 classes stay on the timetable with no mat."],
    ["Mat 2", "Its 1 class stays on the timetable with no mat."],
    ["Mat 3", "No classes use it."],
  ])("removing %s asks first and says what happens to its classes", async (name, sentence) => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: `Remove ${name}` }));
    const dialog = await screen.findByRole("dialog", { name: `Remove ${name}?` });
    expect(within(dialog).getByText(sentence)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Remove mat" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: `Remove ${name}?` })).toBeNull());
    expect(sent("DELETE")).toEqual([]);
    expect(names()).toHaveLength(3);
  });

  it("removing a mat takes it off the list and puts focus on the next row, or on 'Add a mat' after the last", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Remove Mat 2" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove Mat 2?" })).getByRole("button", { name: "Remove mat" }));
    await waitFor(() => expect(names()).toEqual(["Mat 1", "Mat 3"]));
    expect(sent("DELETE").map((c) => c.url)).toEqual(["/api/mats/m2"]);
    await waitFor(() => expect(document.activeElement).toBe(field("Mat 3")));
    expect(live()).toBe("Mat 2 removed");
    expect(onChanged).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove Mat 3" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove Mat 3?" })).getByRole("button", { name: "Remove mat" }));
    await waitFor(() => expect(names()).toEqual(["Mat 1"]));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a mat" })));
  });

  it("a failed removal leaves the list as it was and says so", async () => {
    server.fail["DELETE /api/mats/:id"] = 500;
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Remove Mat 2" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove Mat 2?" })).getByRole("button", { name: "Remove mat" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't save that. Try again.", "error"));
    expect(names()).toEqual(["Mat 1", "Mat 2", "Mat 3"]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("'Add a mat' adds an empty, focused row that becomes a mat on Enter, with focus on its name", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Add a mat" }));
    const fresh = screen.getByLabelText("New mat name") as HTMLInputElement;
    expect(document.activeElement).toBe(fresh);
    expect(fresh.maxLength).toBe(24);
    fireEvent.change(fresh, { target: { value: " Upstairs " } });
    fireEvent.keyDown(fresh, { key: "Enter" });
    await waitFor(() => expect(names()).toEqual(["Mat 1", "Mat 2", "Mat 3", "Upstairs"]));
    expect(sent("POST", "/api/mats").map((c) => c.body)).toEqual([{ name: "Upstairs" }]);
    expect(screen.queryByLabelText("New mat name")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(field("Upstairs")));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("a new row left empty goes away without a request; Escape drops it too", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Add a mat" }));
    fireEvent.blur(screen.getByLabelText("New mat name"));
    await waitFor(() => expect(screen.queryByLabelText("New mat name")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Add a mat" }));
    fireEvent.change(screen.getByLabelText("New mat name"), { target: { value: "Half typed" } });
    fireEvent.keyDown(screen.getByLabelText("New mat name"), { key: "Escape" });
    expect(screen.queryByLabelText("New mat name")).toBeNull();
    expect(sent("POST")).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    [409, "You already have a mat called Mat 1.", "You already have a mat called Mat 1."],
    [409, "You can have up to 12 mats.", "You can have up to 12 mats."],
    [500, undefined, "Couldn't save Mat 1. Try again."],
  ])("a refused new mat (%s) keeps what was typed and says why", async (status, said, shown) => {
    server.fail["POST /api/mats"] = status;
    if (said) server.errorText["POST /api/mats"] = said;
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Add a mat" }));
    fireEvent.change(screen.getByLabelText("New mat name"), { target: { value: "Mat 1" } });
    fireEvent.keyDown(screen.getByLabelText("New mat name"), { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toBe(shown);
    expect((screen.getByLabelText("New mat name") as HTMLInputElement).value).toBe("Mat 1");
    expect(names()).toEqual(["Mat 1", "Mat 2", "Mat 3"]);
  });

  it("classes that say a mat's name but are not on it can be put on it in one press", async () => {
    server.places = [place("mat 1", 9, { key: "mat 1", matId: "m1" }), place("Sauna", 1)];
    server.adoptAnswer = { matsAdded: 0, classesAttached: 9, layoutChanged: false, layout: { effective: "time" } };
    await open();
    const stray = screen.getByTestId("mats-stray");
    expect(stray.textContent).toContain("9 classes say “Mat 1” but are not on it.");
    fireEvent.click(within(stray).getByRole("button", { name: "Put them on Mat 1" }));
    await waitFor(() => expect(screen.getByTestId("mats-notice").textContent).toBe("9 classes are now on Mat 1."));
    expect(sent("POST", "/api/mats/adopt").map((c) => c.body)).toEqual([{ keys: ["mat 1"] }]);
    expect(screen.queryByTestId("mats-stray")).toBeNull();
  });

  it("says how to put a class on a mat while none is on one", async () => {
    server.mats = [{ id: "m1", name: "Mat 1", classCount: 0 }];
    await open();
    expect(screen.getByText("Put a class on a mat: open a class and choose its mat.")).toBeTruthy();
    cleanup();
    server.mats = three();
    await open();
    expect(screen.queryByText("Put a class on a mat: open a class and choose its mat.")).toBeNull();
  });

  it("has one polite live region", async () => {
    await open();
    const region = screen.getByTestId("mats-live");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
  });
});

describe("opening and closing", () => {
  it("reads nothing while closed, and starts afresh each time it opens", async () => {
    server.mats = three();
    const view = render(<MatsSheet open={false} onClose={onClose} onChanged={onChanged} />);
    expect(calls).toEqual([]);
    view.rerender(<MatsSheet open onClose={onClose} onChanged={onChanged} />);
    await waitFor(() => expect(names()).toHaveLength(3));
    fireEvent.change(field("Mat 2"), { target: { value: "Half typed" } });
    view.rerender(<MatsSheet open={false} onClose={onClose} onChanged={onChanged} />);
    view.rerender(<MatsSheet open onClose={onClose} onChanged={onChanged} />);
    await waitFor(() => expect(names()).toEqual(["Mat 1", "Mat 2", "Mat 3"]));
  });
});
