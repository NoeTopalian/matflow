// @vitest-environment jsdom
//
// T6a (Q3), acceptance 3: the register shows a plan mismatch and asks
// "Advanced isn't included in Ava's Beginners Unlimited membership. Admit
// anyway?"; on confirm the mark carries acknowledged: ["tier_not_included"].
// If the class's memberships changed after the list loaded, the server's
// askable refusal puts the same question and the mark is resent once.
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

type Candidate = { id: string; name: string; accountType: string; tierNotIncluded?: boolean; membershipTierName?: string | null };

async function renderPanel(candidates: Candidate[], expected: unknown[] = []) {
  calls = [];
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/register")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          instance: { name: "Advanced", maxCapacity: 20, isKids: false, allowedTiers: [{ id: "t-adv", name: "Advanced Unlimited" }] },
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

const AVA: Candidate = { id: "m1", name: "Ava Beginner", accountType: "adult", tierNotIncluded: true, membershipTierName: "Beginners Unlimited" };
const BEN: Candidate = { id: "m2", name: "Ben Advanced", accountType: "adult", tierNotIncluded: false, membershipTierName: "Advanced Unlimited" };

describe("RegisterPanel — a class outside the member's membership", () => {
  beforeEach(() => { vi.useFakeTimers(); postResponses = []; });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("shows who the class is for", async () => {
    await renderPanel([AVA, BEN]);
    expect(screen.getByTestId("register-allowed-tiers").textContent).toBe("For: Advanced Unlimited");
  });

  it("asks, naming the class and the plan, and records nothing until confirmed", async () => {
    const input = await renderPanel([AVA, BEN]);
    await markByEnter(input, "Ava");
    expect(screen.getByText("Advanced isn't included in Ava Beginner's Beginners Unlimited membership. Admit anyway?")).toBeTruthy();
    expect(posts()).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ })); });
    await act(async () => {});
    expect(posts()).toHaveLength(0);
  });

  it("admits once confirmed, and the override travels with the mark", async () => {
    const input = await renderPanel([AVA, BEN]);
    await markByEnter(input, "Ava");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Admit anyway/ })); });
    await act(async () => {});
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0].init!.body as string).acknowledged).toEqual(["tier_not_included"]);
  });

  it("does not ask about a member whose plan is included", async () => {
    const input = await renderPanel([AVA, BEN]);
    await markByEnter(input, "Ben");
    expect(screen.queryByText(/Admit anyway\?/)).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  it("when the server asks (list was stale), asks the same question and resends once with the override", async () => {
    postResponses = [
      { status: 403, body: { error: "Advanced isn't included in your Beginners Unlimited membership.", reason: "tier_not_included", askable: true } },
      { status: 201, body: { success: true, record: { id: "rec-1" } } },
    ];
    const input = await renderPanel([{ ...AVA, tierNotIncluded: false }, BEN]);
    await markByEnter(input, "Ava");
    expect(posts()).toHaveLength(1);
    expect(screen.getByText(/isn't included in Ava Beginner's Beginners Unlimited membership\. Admit anyway\?/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Admit anyway/ })); });
    await act(async () => {});
    expect(posts()).toHaveLength(2);
    expect(JSON.parse(posts()[1].init!.body as string).acknowledged).toEqual(["tier_not_included"]);
  });

  it("flags the mismatch on a booked row", async () => {
    await renderPanel([], [{
      memberId: "m1", name: "Ava Beginner", accountType: "adult", waiverAccepted: true, rank: null,
      attended: false, attendedMethod: null, lastVisitAt: null, medicalConditions: null,
      tierNotIncluded: true, membershipTierName: "Beginners Unlimited",
    }]);
    expect(screen.getByTestId("register-tier-not-included").textContent).toBe("NOT ON BEGINNERS UNLIMITED");
  });
});
