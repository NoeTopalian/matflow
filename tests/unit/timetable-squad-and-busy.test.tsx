// @vitest-environment jsdom
//
// Three timetable UX defects found while tracing Sean's missing Gi day:
//
//  1. "Switch back to rank gate" on a squad class, saved with no rank chosen,
//     left the squad in force while the form said anyone could attend.
//  2. A just-saved squad class reopened showing no squad: the save's reply
//     carried no roster, so the row kept its old one.
//  3. Archive read the class's history for seconds before asking, with no
//     busy state — a second click could stack a second confirmation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import type { ClassRow } from "@/app/dashboard/timetable/page";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const makeClass = (over: Partial<ClassRow> = {}): ClassRow => ({
  id: "c1", name: "Gi", coachName: null, coachUserId: null, coachUser: null,
  location: null, locationId: null, duration: 60, maxCapacity: null, color: null,
  description: null, requiredRankId: null, requiredRank: null, maxRankId: null, maxRank: null,
  schedules: [{ id: "s1", dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
  roster: [], lifecycle: "active", archivedAt: null,
  ...over,
});
const SQUAD = makeClass({ roster: [{ memberId: "m1", name: "Member 1" }] });
const RANKS = [{ id: "r-blue", name: "Blue", color: null, discipline: "BJJ" }];
const PROPS = { rankSystems: [], coachUsers: [], primaryColor: "#2563eb", role: "owner", currentUserId: null };
const MEMBERS = [
  { id: "m1", name: "Member 1", email: "m1@example.test" },
  { id: "m2", name: "Member 2", email: "m2@example.test" },
];

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
let calls: Call[];
// Archive's history read; a test may hold it open to look at the busy state.
let countsGate: Promise<void>;
let countsOk: boolean;
beforeEach(() => {
  calls = [];
  countsGate = Promise.resolve();
  countsOk = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url === "/api/locations") return { ok: true, json: async () => ({ locations: [] }) };
    if (url.startsWith("/api/members?")) return { ok: true, json: async () => ({ members: MEMBERS, nextCursor: null }) };
    if (method === "DELETE" && url.includes("dryRun=1")) {
      await countsGate;
      return countsOk
        ? { ok: true, json: async () => ({ dryRun: true, state: "active", attendanceCount: 2, rosterCount: 0, bookingCount: 0 }) }
        : { ok: false, json: async () => ({ error: "Synthetic failure" }) };
    }
    if (url.includes("dryRun=1")) return { ok: true, json: async () => ({ dryRun: true, restriction: null }) };
    if (method === "PATCH") {
      // As the server now replies: the class's roster after the save.
      const roster = Array.isArray(body?.roster)
        ? (body!.roster as { memberId: string }[]).map((r) => ({ memberId: r.memberId, name: MEMBERS.find((m) => m.id === r.memberId)?.name }))
        : undefined;
      return { ok: true, json: async () => ({ id: "c1", ...(roster ? { roster } : {}) }) };
    }
    return { ok: true, json: async () => [] };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const lastPatch = () => calls.filter((c) => c.method === "PATCH" && !c.url.includes("dryRun")).at(-1)!.body!;
async function openEdit() {
  fireEvent.click(screen.getAllByRole("button", { name: "Edit Gi" })[0]);
  await screen.findByLabelText("Class Name");
}
async function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && !c.url.includes("dryRun"))).toBe(true));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe("switching a squad class back to open", () => {
  it("with no rank chosen sends an empty roster, so the squad is cleared", async () => {
    render(<TimetableManager {...PROPS} initialClasses={[SQUAD]} initialInactiveClasses={[]} />);
    await openEdit();
    fireEvent.click(screen.getByRole("button", { name: "Switch back to rank gate" }));
    await save();
    expect(lastPatch().roster).toEqual([]);
  });

  it("with a rank chosen omits the roster and keeps the rank (the rank gate clears the squad)", async () => {
    render(<TimetableManager {...PROPS} rankSystems={RANKS} initialClasses={[SQUAD]} initialInactiveClasses={[]} />);
    await openEdit();
    fireEvent.click(screen.getByRole("button", { name: "Switch back to rank gate" }));
    fireEvent.change(screen.getByLabelText("Required Rank (min)"), { target: { value: "r-blue" } });
    await save();
    expect("roster" in lastPatch()).toBe(false);
    expect(lastPatch().requiredRankId).toBe("r-blue");
  });

  it("a class that never had a squad still omits the roster on an unrelated edit", async () => {
    render(<TimetableManager {...PROPS} initialClasses={[makeClass()]} initialInactiveClasses={[]} />);
    await openEdit();
    fireEvent.change(screen.getAllByLabelText("Start time")[0], { target: { value: "19:00" } });
    await save();
    expect("roster" in lastPatch()).toBe(false);
  });

  it("after clearing, the class reopens as open to everyone", async () => {
    render(<TimetableManager {...PROPS} initialClasses={[SQUAD]} initialInactiveClasses={[]} />);
    await openEdit();
    fireEvent.click(screen.getByRole("button", { name: "Switch back to rank gate" }));
    await save();
    await openEdit();
    expect(screen.queryByRole("button", { name: "Switch back to rank gate" })).toBeNull();
    expect(screen.getByRole("button", { name: "+ Select specific people (comp class)" })).toBeTruthy();
  });
});

describe("a just-saved squad reopens as a squad", () => {
  it("uses the roster in the save's reply, without waiting for a page refresh", async () => {
    render(<TimetableManager {...PROPS} initialClasses={[makeClass()]} initialInactiveClasses={[]} />);
    await openEdit();
    fireEvent.click(screen.getByRole("button", { name: "+ Select specific people (comp class)" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Member 1/ }));
    await save();
    await openEdit();
    expect(screen.getByRole("button", { name: "Switch back to rank gate" })).toBeTruthy();
    expect((await screen.findByRole("checkbox", { name: /Member 1/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Member 2/ }) as HTMLInputElement).checked).toBe(false);
  });
});

describe("Archive shows it is working from the click", () => {
  it("is busy while the history is read; a second click reads nothing more; cancelling clears it", async () => {
    let release!: () => void;
    countsGate = new Promise((r) => { release = r; });
    render(<TimetableManager {...PROPS} initialClasses={[makeClass()]} initialInactiveClasses={[]} />);
    const archive = screen.getByRole("button", { name: "Archive Gi" }) as HTMLButtonElement;
    fireEvent.click(archive);
    await waitFor(() => expect(archive.getAttribute("aria-busy")).toBe("true"));
    expect(archive.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Pause Gi" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(archive);
    expect(calls.filter((c) => c.method === "DELETE" && c.url.includes("dryRun")).length).toBe(1);
    release();
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(archive.disabled).toBe(false));
    expect(archive.getAttribute("aria-busy")).toBeNull();
    expect(calls.some((c) => c.method === "DELETE" && !c.url.includes("dryRun"))).toBe(false);
  });

  it("a failed history read clears the busy state and archives nothing", async () => {
    countsOk = false;
    render(<TimetableManager {...PROPS} initialClasses={[makeClass()]} initialInactiveClasses={[]} />);
    const archive = screen.getByRole("button", { name: "Archive Gi" }) as HTMLButtonElement;
    fireEvent.click(archive);
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() => expect(archive.disabled).toBe(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((c) => c.method === "DELETE" && !c.url.includes("dryRun"))).toBe(false);
  });
});
