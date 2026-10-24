// @vitest-environment jsdom
//
// T6a: "Who can attend" on the class form. None ticked = Everyone; ticks are
// sent as allowedTierIds; a deactivated tier still attached is read-only; a
// narrowing that would remove bookings is previewed (dryRun) and confirmed;
// the class card shows who the class is for.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import type { ClassRow } from "@/app/dashboard/timetable/page";

const toastSpy = vi.fn();
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

const CLASS: ClassRow = {
  id: "c1", name: "Advanced", coachName: null, coachUserId: null, coachUser: null, location: null, locationId: null,
  duration: 60, maxCapacity: null, color: null, description: null,
  requiredRankId: null, requiredRank: null, maxRankId: null, maxRank: null,
  schedules: [{ id: "s1", dayOfWeek: 1, startTime: "19:00", endTime: "20:00" }],
  roster: [],
  allowedTiers: [],
};
const TIERS = [
  { id: "t-beg", name: "Beginners Unlimited", isActive: true },
  { id: "t-adv", name: "Advanced Unlimited", isActive: true },
  { id: "t-old", name: "Legacy Unlimited", isActive: false },
];
const props = (cls: ClassRow) => ({
  initialClasses: [cls], rankSystems: [], coachUsers: [], membershipTiers: TIERS,
  primaryColor: "var(--color-primary)", role: "owner", currentUserId: "u1",
});

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
/** D2: the dry run's restriction preview; bookings are kept. */
const restrictionFor = (booked: string[], notBooked = 0) => ({
  bookingsKept: true,
  booked: booked.map((id) => ({ memberId: id, name: `Member ${id}`, reasons: ["tier_not_included"], newlyRefused: true, staffDoorsAdmit: false })),
  notBooked: notBooked > 0
    ? [{ key: "no_plan", label: "No membership plan", count: notBooked, attendedThisClassCount: 1, recentlyActiveCount: 1, members: [{ memberId: "n1", name: "Nia Plan", attendedThisClass: true, recentlyActive: true }] }]
    : [],
  notBookedTotal: notBooked,
});
function stubFetch(dryRunAffected: string[] = [], notBooked = 0) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("dryRun=1")) return { ok: true, json: async () => ({ dryRun: true, tierAffectedMemberIds: dryRunAffected, restriction: restrictionFor(dryRunAffected, notBooked) }) };
    if (url.includes("/api/locations") || url.includes("/api/coach/today")) return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({ ...CLASS, allowedTiers: [TIERS[1]], scheduleChange: null }) };
  }));
}
const patches = () => calls.filter((c) => c.init?.method === "PATCH" && !c.url.includes("dryRun"));

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("class form — Who can attend", () => {
  it("shows Everyone when nothing is ticked, offers active tiers, hides an unattached deactivated one", async () => {
    stubFetch();
    render(<TimetableManager {...props(CLASS)} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    expect(await screen.findByText(/Everyone — any member can book and check in/)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Beginners Unlimited" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Legacy Unlimited" })).toBeNull();
  });

  it("sends the ticked tiers as allowedTierIds", async () => {
    stubFetch();
    render(<TimetableManager {...props(CLASS)} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Advanced Unlimited" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(patches()[0].init!.body as string).allowedTierIds).toEqual(["t-adv"]);
  });

  it("an edit that does not touch the ticks does not send allowedTierIds", async () => {
    stubFetch();
    render(<TimetableManager {...props({ ...CLASS, allowedTiers: [TIERS[1]] })} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(patches()[0].init!.body as string)).not.toHaveProperty("allowedTierIds");
  });

  it("clearing every tick sends [] (Everyone)", async () => {
    stubFetch();
    render(<TimetableManager {...props({ ...CLASS, allowedTiers: [TIERS[1]] })} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Advanced Unlimited" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(patches()[0].init!.body as string).allowedTierIds).toEqual([]);
  });

  it("an attached deactivated tier is shown read-only", async () => {
    stubFetch();
    render(<TimetableManager {...props({ ...CLASS, allowedTiers: [TIERS[2]] })} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    const box = await screen.findByRole("checkbox", { name: "Legacy Unlimited" });
    expect((box as HTMLButtonElement).disabled).toBe(true);
    expect(box.getAttribute("aria-checked")).toBe("true");
  });

  it("D2: previews who a narrowing turns away — bookings kept — and saves only once confirmed", async () => {
    stubFetch(["m1", "m2"], 3);
    render(<TimetableManager {...props(CLASS)} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Advanced Unlimited" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Check who this change turns away")).toBeTruthy();
    expect(screen.getByText(/Bookings are kept\./)).toBeTruthy();
    expect(screen.getByText(/Booked and would not be admitted \(2\)/)).toBeTruthy();
    expect(screen.getAllByTestId("restriction-booked-row").map((r) => r.textContent)).toEqual([
      "Member m1 — Membership not included",
      "Member m2 — Membership not included",
    ]);
    expect(screen.getByText(/Not booked but would be refused \(3\)/)).toBeTruthy();
    expect(screen.getByTestId("restriction-group-no_plan").textContent).toMatch(/No membership plan — 3 members, 1 of them attended this class in the last 8 weeks/);
    // Nothing promises a removal any more.
    expect(screen.getByTestId("restriction-preview").textContent).not.toMatch(/remov/i);
    expect(patches()).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save — bookings are kept" })); });
    await waitFor(() => expect(patches()).toHaveLength(1));
  });

  it("D2: cancelling the preview saves nothing", async () => {
    stubFetch(["m1"]);
    render(<TimetableManager {...props(CLASS)} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Advanced Unlimited" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const title = await screen.findByText("Check who this change turns away");
    const dialog = title.closest("[role='dialog']") as HTMLElement;
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })); });
    await waitFor(() => expect(screen.queryByText("Check who this change turns away")).toBeNull());
    expect(patches()).toHaveLength(0);
  });

  it("D2: a change that turns no one away saves without asking", async () => {
    stubFetch([]);
    render(<TimetableManager {...props(CLASS)} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Advanced Unlimited" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(calls.filter((c) => c.url.includes("dryRun=1"))).toHaveLength(1);
    expect(screen.queryByText("Check who this change turns away")).toBeNull();
  });

  it("D2: an edit that changes nothing about who can attend is not previewed", async () => {
    stubFetch(["m1"]);
    render(<TimetableManager {...props({ ...CLASS, allowedTiers: [TIERS[1]] })} />);
    fireEvent.click(screen.getAllByLabelText("Edit Advanced")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(calls.filter((c) => c.url.includes("dryRun=1"))).toHaveLength(0);
  });

  it("the class card says who the class is for", () => {
    stubFetch();
    render(<TimetableManager {...props({ ...CLASS, allowedTiers: [TIERS[1]] })} />);
    expect(screen.getAllByTestId("class-card-tiers")[0].textContent).toBe("For: Advanced Unlimited");
  });
});
