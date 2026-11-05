// @vitest-environment jsdom
//
// The class form and mats (plan §4.10). A club with no mats sees the form it
// always had. A club with mats chooses a Mat instead of typing a Location;
// "No mat" keeps a typed place possible. What is sent matters as much as what
// is shown: on a mat the server writes the place, and an edit that does not
// move the class does not name a mat at all.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import { PROPS, cls, stubFetch, type Call } from "./helpers/timetable-fixture";

const { refresh, toast } = vi.hoisted(() => ({ refresh: vi.fn(), toast: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const MATS = [{ id: "m1", name: "Mat 1" }, { id: "m2", name: "Mat 2" }];
const matSelect = () => screen.getByLabelText("Mat") as HTMLSelectElement;
const placeBox = () => screen.queryByLabelText("Place (not on a mat)") as HTMLInputElement | null;
const saves = (calls: Call[]) => calls.filter((c) => c.url.startsWith("/api/classes") && !c.url.includes("dryRun") && (c.method === "POST" || c.method === "PATCH"));

let calls: Call[] = [];
const answerSaves = (status = 200) =>
  stubFetch((call) => {
    if (!call.url.startsWith("/api/classes")) return undefined;
    if (status >= 400) return { ok: false, status, json: async () => ({ error: "Failed to update class" }) };
    return { ok: true, status: call.method === "POST" ? 201 : 200, json: async () => ({ ...cls(String(call.body?.name ?? "Gi"), null, [[1, "18:00", "19:00"]]), ...call.body }) };
  });

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
const submit = (label: "Create class" | "Save changes") => fireEvent.click(screen.getByRole("button", { name: label }));

describe("a club with no mats", () => {
  it("has the form it always had: a typed Location, no Mat select, and nothing about mats is sent", async () => {
    render(<TimetableManager initialClasses={[cls("Gi", null, [[1, "18:00", "19:00"]])]} {...PROPS} />);
    await createClass("No-Gi");
    expect(screen.queryByLabelText("Mat")).toBeNull();
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: " Mat 1 " } });
    submit("Create class");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(saves(calls)[0].body).toMatchObject({ name: "No-Gi", location: "Mat 1" });
    expect(saves(calls)[0].body).not.toHaveProperty("matId");
  });
});

describe("a club with mats", () => {
  it("a new class chooses a mat from the club's list, in the club's order, starting on No mat with a place box", async () => {
    render(<TimetableManager initialClasses={[cls("Gi", "Mat 1", [[1, "18:00", "19:00"]], { matId: "m1" })]} mats={MATS} {...PROPS} />);
    await createClass("No-Gi");
    expect(screen.queryByLabelText("Location")).toBeNull();
    expect(Array.from(matSelect().options).map((o) => [o.value, o.textContent])).toEqual([["", "No mat"], ["m1", "Mat 1"], ["m2", "Mat 2"]]);
    expect(matSelect().value).toBe("");
    expect(placeBox()).not.toBeNull();
    fireEvent.change(matSelect(), { target: { value: "m2" } });
    // On a mat there is no place to type: the mat's name is the place.
    expect(placeBox()).toBeNull();
    submit("Create class");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(saves(calls)[0].body).toMatchObject({ name: "No-Gi", matId: "m2" });
    expect(saves(calls)[0].body).not.toHaveProperty("location");
  });

  it("a new class on no mat sends its typed place and says it is on no mat", async () => {
    render(<TimetableManager initialClasses={[cls("Gi", "Mat 1", [[1, "18:00", "19:00"]], { matId: "m1" })]} mats={MATS} {...PROPS} />);
    await createClass("Beach wrestling");
    fireEvent.change(placeBox()!, { target: { value: "The beach" } });
    submit("Create class");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(saves(calls)[0].body).toMatchObject({ matId: null, location: "The beach" });
  });

  it("editing a class on a mat without moving it names no mat and sends no place", async () => {
    render(<TimetableManager initialClasses={[cls("Gi", "Mat 1", [[1, "18:00", "19:00"]], { matId: "m1" })]} mats={MATS} {...PROPS} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Gi/ })[0]);
    expect(matSelect().value).toBe("m1");
    expect(placeBox()).toBeNull();
    fireEvent.change(screen.getByLabelText("Class Name"), { target: { value: "Gi Fundamentals" } });
    submit("Save changes");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(saves(calls)[0].body).toMatchObject({ name: "Gi Fundamentals" });
    expect(saves(calls)[0].body).not.toHaveProperty("matId");
    expect(saves(calls)[0].body).not.toHaveProperty("location");
  });

  it("moving a class to another mat sends only the mat", async () => {
    render(<TimetableManager initialClasses={[cls("Gi", "Mat 1", [[1, "18:00", "19:00"]], { matId: "m1" })]} mats={MATS} {...PROPS} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Gi/ })[0]);
    fireEvent.change(matSelect(), { target: { value: "m2" } });
    submit("Save changes");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(saves(calls)[0].body).toMatchObject({ matId: "m2" });
    expect(saves(calls)[0].body).not.toHaveProperty("location");
  });

  it("choosing No mat reveals the place box and empties the name of the mat just left", async () => {
    render(<TimetableManager initialClasses={[cls("Gi", "Mat 1", [[1, "18:00", "19:00"]], { matId: "m1" })]} mats={MATS} {...PROPS} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Gi/ })[0]);
    fireEvent.change(matSelect(), { target: { value: "" } });
    expect(placeBox()?.value).toBe("");
    submit("Save changes");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(saves(calls)[0].body).toMatchObject({ matId: null, location: null });
  });

  it("a class with a typed place and no mat keeps its place in the box, and an edit sends the place but names no mat", async () => {
    render(<TimetableManager initialClasses={[cls("Yoga", "Sports hall", [[2, "10:00", "11:00"]]), cls("Gi", "Mat 1", [[1, "18:00", "19:00"]], { matId: "m1" })]} mats={MATS} {...PROPS} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Yoga/ })[0]);
    expect(matSelect().value).toBe("");
    expect(placeBox()?.value).toBe("Sports hall");
    fireEvent.change(placeBox()!, { target: { value: "Studio" } });
    submit("Save changes");
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(saves(calls)[0].body).toMatchObject({ location: "Studio" });
    expect(saves(calls)[0].body).not.toHaveProperty("matId");
  });

  it("a place that is not the mat's name survives a round trip through the select", async () => {
    render(<TimetableManager initialClasses={[cls("Yoga", "Sports hall", [[2, "10:00", "11:00"]]), cls("Gi", "Mat 1", [[1, "18:00", "19:00"]], { matId: "m1" })]} mats={MATS} {...PROPS} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Yoga/ })[0]);
    fireEvent.change(matSelect(), { target: { value: "m1" } });
    fireEvent.change(matSelect(), { target: { value: "" } });
    expect(placeBox()?.value).toBe("Sports hall");
  });

  it("a failed save keeps the form open with the mat that was chosen; the retry sends it once", async () => {
    calls = answerSaves(500);
    render(<TimetableManager initialClasses={[cls("Gi", "Mat 1", [[1, "18:00", "19:00"]], { matId: "m1" })]} mats={MATS} {...PROPS} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Gi/ })[0]);
    fireEvent.change(matSelect(), { target: { value: "m2" } });
    submit("Save changes");
    await screen.findByRole("alert");
    expect(matSelect().value).toBe("m2");
    expect(saves(calls)).toHaveLength(1);
    // The server recovers; the same form is sent again.
    const retry = answerSaves();
    submit("Save changes");
    await waitFor(() => expect(saves(retry)).toHaveLength(1));
    expect(saves(retry)[0].body).toMatchObject({ matId: "m2" });
  });
});
