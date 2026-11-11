// @vitest-environment jsdom
//
// The class form's colour picker and the colour on the timetable (11 Nov 2026).
//  - Every swatch is a named button ("Class colour: Light yellow"), pressed when chosen, with a tick, and the chosen
//    colour is said in words under the swatches: the choice never rests on colour alone.
//  - Picking a colour sends it; an unrelated edit leaves a saved colour exactly as it was, including a colour the
//    palette does not hold (offered first as "Current colour").
//  - On the class card a pale colour's dot is ringed and its schedule pills' text is darkened to 4.5:1.
//  - On the week chip a pale colour's dot is ringed and the live edge reaches 3:1.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup, within } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import { WeekChip } from "@/components/schedule/WeekChip";
import type { ClassRow } from "@/app/dashboard/timetable/page";
import { CLASS_COLOURS } from "@/lib/class-colours";
import { contrastRatio, tintOver } from "@/lib/color";

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
function stubFetch() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/api/locations") || url.includes("/api/coach/today")) return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({ ...makeClass("c1", "Advanced", null), ...JSON.parse(String(init?.body ?? "{}")), scheduleChange: null }) };
  }));
}
const patchBody = () => JSON.parse(calls.find((c) => c.init?.method === "PATCH")!.init!.body as string) as Record<string, unknown>;
/** "rgb(r, g, b)" → "#rrggbb". */
const toHex = (rgb: string) => "#" + (rgb.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");

beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
afterEach(() => { cleanup(); });

async function openEdit(cls: ClassRow) {
  stubFetch();
  render(<TimetableManager {...props([cls])} />);
  fireEvent.click(screen.getAllByLabelText(`Edit ${cls.name}`)[0]);
  return screen.findByRole("group", { name: "Colour" });
}

describe("class form — colour picker", () => {
  it("offers every palette colour by name, the class's own pressed with a tick and named in words", async () => {
    const group = await openEdit(makeClass("c1", "Advanced", "#fde68a"));
    const swatches = within(group).getAllByRole("button");
    expect(swatches.map((b) => b.getAttribute("aria-label"))).toEqual(CLASS_COLOURS.map((c) => `Class colour: ${c.name}`));
    const pressed = swatches.filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed.map((b) => b.getAttribute("aria-label"))).toEqual(["Class colour: Light yellow"]);
    expect(pressed[0].querySelector("svg")).not.toBeNull();
    expect(screen.getByTestId("class-colour-name").textContent).toBe("Light yellow");
  });

  it("picking Grey sends it, and the words follow", async () => {
    const group = await openEdit(makeClass("c1", "Advanced", "#3b82f6"));
    fireEvent.click(within(group).getByRole("button", { name: "Class colour: Grey" }));
    expect(within(group).getByRole("button", { name: "Class colour: Grey" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("class-colour-name").textContent).toBe("Grey");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    expect(patchBody().color).toBe("#94a3b8");
  });

  it("a colour the palette does not hold is kept: offered first as Current colour, and an unrelated save sends it unchanged", async () => {
    const group = await openEdit(makeClass("c1", "Advanced", "#123456"));
    const first = within(group).getAllByRole("button")[0];
    expect(first.getAttribute("aria-label")).toBe("Class colour: Current colour");
    expect(first.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    expect(patchBody().color).toBe("#123456");
  });
});

describe("class card — pale colours stay visible", () => {
  it("light yellow: the dot is ringed and the schedule pill text reaches 4.5:1 on its tint", async () => {
    stubFetch();
    const { container } = render(<TimetableManager {...props([makeClass("c1", "Sunrise", "#fde68a")])} />);
    await act(async () => {});
    const pill = Array.from(container.querySelectorAll("span")).find((s) => s.textContent === "Mon 18:00" && (s as HTMLElement).style.color);
    expect(pill).toBeTruthy();
    const ink = toHex((pill as HTMLElement).style.color);
    expect(contrastRatio(ink, tintOver("#fde68a", 0.12))!).toBeGreaterThanOrEqual(4.5);
    const dot = Array.from(container.querySelectorAll("div.rounded-full")).find((d) => (d as HTMLElement).style.boxShadow.includes("var(--tx-3)"));
    expect(dot).toBeTruthy();
  });
});

describe("week chip — pale colours stay visible", () => {
  it("light yellow, live: the dot is ringed and the live edge reaches 3:1 on white", () => {
    render(<WeekChip name="Sunrise" dayName="Monday" startTime="18:00" endTime="19:00" color="#fde68a" place={null} showPlace={false} state="live" canManage onEdit={() => {}} />);
    const chip = screen.getByRole("button", { name: /Edit Sunrise/ });
    const edge = toHex(chip.style.borderLeftColor);
    expect(contrastRatio(edge, "#ffffff")!).toBeGreaterThanOrEqual(3);
    const dot = chip.querySelector("span[aria-hidden='true'].rounded-full") as HTMLElement;
    expect(dot.style.boxShadow).toBe("0 0 0 1px var(--tx-3)");
  });

  it("blue, live: unchanged — no ring, the edge is the colour itself", () => {
    render(<WeekChip name="Advanced" dayName="Monday" startTime="18:00" endTime="19:00" color="#3b82f6" place={null} showPlace={false} state="live" canManage onEdit={() => {}} />);
    const chip = screen.getByRole("button", { name: /Edit Advanced/ });
    expect(toHex(chip.style.borderLeftColor)).toBe("#3b82f6");
    const dot = chip.querySelector("span[aria-hidden='true'].rounded-full") as HTMLElement;
    expect(dot.style.boxShadow).toBe("");
  });
});
