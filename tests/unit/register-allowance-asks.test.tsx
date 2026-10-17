// @vitest-environment jsdom
//
// T7: the desk register ASKS when a member's plan allowance is used up. The
// server answers an unconfirmed staff mark with 403 allowance_reached,
// askable, and the count; the register puts the question with the count and
// the date it frees up, and on confirm resends once with
// acknowledged: ["allowance_reached"]. Cancel records nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import RegisterPanel from "@/components/dashboard/RegisterPanel";

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const INSTANCE = {
  id: "inst-1", classId: "c1", name: "Fundamentals", coachName: "Cian", location: "Mat 1", color: "#3b82f6",
  startTime: "18:00", endTime: "19:00", maxCapacity: 20, attendedCount: 0, waitlistCount: 0,
  status: "ongoing" as const, isCancelled: false, cancellationReason: null, isMine: true,
};

let calls: Array<{ url: string; init?: RequestInit }> = [];
const posts = () => calls.filter((c) => c.url === "/api/checkin" && c.init?.method === "POST");
let postResponses: Array<{ status: number; body: unknown }> = [];

const ALLOWANCE_REFUSAL = {
  status: 403,
  body: {
    error: "4 of 4 classes used in the last 4 weeks; next free on Monday 2 November from 18:00. Ask staff if you need to train before then.",
    reason: "allowance_reached",
    askable: true,
    allowance: { used: 4, limit: 4, weeks: 4, nextFree: { date: "2026-11-02", time: "18:00" } },
  },
};

async function renderPanel() {
  calls = [];
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/register")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ instance: { name: "Fundamentals", maxCapacity: 20, isKids: false, allowedTiers: [] }, expected: [], waitlist: [] }),
      });
    }
    if (url.includes("/api/checkin/members")) {
      return Promise.resolve({ ok: true, json: async () => [{ id: "m1", name: "Ava Green", accountType: "adult" }] });
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

const QUESTION = "Ava Green has used 4 of 4 classes in the last 4 weeks (next free on Monday 2 November from 18:00). Admit anyway?";

describe("RegisterPanel - plan allowance used", () => {
  beforeEach(() => { vi.useFakeTimers(); postResponses = []; });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("asks with the count and the free date, and resends once with the override on confirm", async () => {
    postResponses = [ALLOWANCE_REFUSAL, { status: 201, body: { success: true, record: { id: "rec-1" } } }];
    const input = await renderPanel();
    await markByEnter(input, "Ava");
    expect(posts()).toHaveLength(1);
    expect(screen.getByText(QUESTION)).toBeTruthy();
    expect(screen.getByText("Class allowance used")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Admit anyway/ })); });
    await act(async () => {});
    expect(posts()).toHaveLength(2);
    expect(JSON.parse(posts()[1].init!.body as string).acknowledged).toEqual(["allowance_reached"]);
  });

  it("cancel records nothing more", async () => {
    postResponses = [ALLOWANCE_REFUSAL];
    const input = await renderPanel();
    await markByEnter(input, "Ava");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ })); });
    await act(async () => {});
    expect(posts()).toHaveLength(1);
  });

  it("a refusal that is not askable is shown as the refusal it is, with no question", async () => {
    postResponses = [{ status: 403, body: { ...ALLOWANCE_REFUSAL.body, askable: undefined } }];
    const input = await renderPanel();
    await markByEnter(input, "Ava");
    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(screen.getByText(/4 of 4 classes used in the last 4 weeks/)).toBeTruthy();
  });
});
