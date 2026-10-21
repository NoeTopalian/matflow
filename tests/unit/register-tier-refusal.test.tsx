// @vitest-environment jsdom
//
// The register and a class outside the member's membership (owner decision,
// 20 Oct 2026): there is no "Admit anyway" for the plan. The mark goes to the
// server as any other, carries no tier confirmation, and the server's refusal
// is shown in the register's error line in the server's own words. A row the
// register already knows will be refused says so, and says what to change.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import RegisterPanel from "@/components/dashboard/RegisterPanel";

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const INSTANCE = {
  id: "inst-1", classId: "c1", name: "Advanced", coachName: "Cian", location: "Mat 1", color: "#3b82f6",
  startTime: "19:00", endTime: "20:00", maxCapacity: 20, attendedCount: 0, waitlistCount: 0,
  status: "ongoing" as const, isCancelled: false, cancellationReason: null, isMine: true,
};

let calls: Array<{ url: string; init?: RequestInit }> = [];
const posts = () => calls.filter((c) => c.url === "/api/checkin" && c.init?.method === "POST");
let postResponses: Array<{ status: number; body: unknown }> = [];

type Candidate = { id: string; name: string; accountType: string; tierNotIncluded?: boolean; membershipTierName?: string | null; onHold?: boolean };

async function renderPanel(candidates: Candidate[], expected: unknown[] = [], instanceExtra: Record<string, unknown> = {}) {
  calls = [];
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/register")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          instance: { name: "Advanced", maxCapacity: 20, isKids: false, allowedTiers: [{ id: "t-adv", name: "Advanced Unlimited" }], ...instanceExtra },
          expected,
          waitlist: [],
        }),
      });
    }
    if (url.includes("/api/checkin/members")) {
      return Promise.resolve({ ok: true, json: async () => candidates });
    }
    const next = postResponses.shift() ?? { status: 201, body: { success: true, record: { id: "rec-1" } } };
    return Promise.resolve({ ok: next.status < 300, status: next.status, json: async () => next.body });
  }) as unknown as typeof fetch;
  render(<RegisterPanel instance={INSTANCE} primaryColor="#3b82f6" onCountChange={() => {}} />);
  await act(async () => {});
  return screen.getByPlaceholderText(/Search members/i) as HTMLInputElement;
}

async function markByEnter(input: HTMLInputElement, q: string) {
  fireEvent.change(input, { target: { value: q } });
  await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
  await act(async () => {});
}

const TIER_SENTENCE = "Advanced isn't included in your Beginners Unlimited membership. Ask staff about a membership that includes it.";
const AVA: Candidate = { id: "m1", name: "Ava Beginner", accountType: "adult", tierNotIncluded: true, membershipTierName: "Beginners Unlimited" };
const BEN: Candidate = { id: "m2", name: "Ben Advanced", accountType: "adult", tierNotIncluded: false, membershipTierName: "Advanced Unlimited" };
const bookedRow = (extra: Record<string, unknown>) => ({
  memberId: "m1", name: "Ava Beginner", accountType: "adult", waiverAccepted: true, rank: null,
  attended: false, attendedMethod: null, lastVisitAt: null, medicalConditions: null, ...extra,
});

describe("RegisterPanel — no override for the membership list or the squad list", () => {
  beforeEach(() => { vi.useFakeTimers(); postResponses = []; });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("shows who the class is for", async () => {
    await renderPanel([AVA, BEN]);
    expect(screen.getByTestId("register-allowed-tiers").textContent).toBe("For: Advanced Unlimited");
  });

  it("never asks 'Admit anyway' about a plan: the mark is sent without a tier confirmation and the refusal is shown", async () => {
    postResponses = [{ status: 403, body: { error: TIER_SENTENCE, reason: "tier_not_included" } }];
    const input = await renderPanel([AVA, BEN]);
    await markByEnter(input, "Ava");
    expect(screen.queryByText(/Admit anyway/)).toBeNull();
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0].init!.body as string)).not.toHaveProperty("acknowledged");
    expect(screen.getByRole("alert").textContent).toContain(TIER_SENTENCE);
  });

  it("a refusal is not retried: one POST, no second attempt with an override", async () => {
    postResponses = [{ status: 403, body: { error: TIER_SENTENCE, reason: "tier_not_included", askable: true } }];
    const input = await renderPanel([{ ...AVA, tierNotIncluded: false }, BEN]);
    await markByEnter(input, "Ava");
    await act(async () => {});
    expect(posts()).toHaveLength(1);
    expect(screen.queryByText(/Admit anyway/)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(TIER_SENTENCE);
  });

  it("the other asks are kept: an on-hold member is still asked, and only on_hold travels with the mark", async () => {
    const input = await renderPanel([{ ...AVA, onHold: true }, BEN]);
    await markByEnter(input, "Ava");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Admit anyway/ })); });
    await act(async () => {});
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0].init!.body as string).acknowledged).toEqual(["on_hold"]);
  });

  it("a member whose plan is included is marked without any question", async () => {
    const input = await renderPanel([AVA, BEN]);
    await markByEnter(input, "Ben");
    expect(screen.queryByText(/Admit anyway/)).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  it("a booked row on an excluded plan is flagged, and says the mark will be refused and what to change", async () => {
    await renderPanel([], [bookedRow({ tierNotIncluded: true, membershipTierName: "Beginners Unlimited" })]);
    const chip = screen.getByTestId("register-tier-not-included");
    expect(chip.textContent).toBe("NOT ON BEGINNERS UNLIMITED");
    expect(chip.getAttribute("title")).toMatch(/will be refused — change their membership/);
    expect(screen.getByTestId("register-will-be-refused").textContent).toMatch(/change their membership first/);
  });

  it("a booked row not on the squad list says to edit the squad list", async () => {
    await renderPanel([], [bookedRow({ notOnRoster: true })], { rosterOnly: true });
    expect(screen.getByTestId("register-not-on-roster").getAttribute("title")).toMatch(/will be refused — edit the squad list/);
    expect(screen.getByTestId("register-will-be-refused").textContent).toMatch(/edit the squad list first/);
  });

  it("a squad class with memberships ticked shows both lines: Squad only and who it is for", async () => {
    await renderPanel([], [], { rosterOnly: true });
    expect(screen.getByTestId("register-squad-only").textContent).toMatch(/Only members on the squad list can book or be checked in/);
    expect(screen.getByTestId("register-allowed-tiers").textContent).toBe("For: Advanced Unlimited");
  });
});
