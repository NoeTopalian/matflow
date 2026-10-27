// @vitest-environment jsdom
//
// T7: the desk register when a member's plan allowance is used up (owner
// decision, 27 Oct 2026): there is no "Admit anyway". The mark goes to the
// server once; the server refuses with the staff sentence (or a class pack
// pays and the mark is recorded); a refusal is shown in the register's error
// line in the server's own words, exactly as the tier refusal is, and nothing
// is resent.
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

const STAFF_SENTENCE =
  "Ava Green has used all 4 classes this 4-week period (resets on Monday 26 October) and has no class-pack credit, so they can't be checked in.";
const ALLOWANCE_REFUSAL = {
  status: 403,
  body: {
    error: STAFF_SENTENCE,
    reason: "allowance_reached",
    allowance: {
      used: 4, limit: 4, basis: "weeks", weeks: 4, period: { start: "2026-09-28", end: "2026-10-26" }, resetsOn: "2026-10-26",
    },
  },
};

type Candidate = { id: string; name: string; accountType: string; onHold?: boolean };
const AVA: Candidate = { id: "m1", name: "Ava Green", accountType: "adult" };

async function renderPanel(candidates: Candidate[] = [AVA]) {
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

describe("RegisterPanel - plan allowance used (no override)", () => {
  beforeEach(() => { vi.useFakeTimers(); postResponses = []; });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("shows the server's staff sentence beside the member, asks nothing and sends one POST without an acknowledgement", async () => {
    postResponses = [ALLOWANCE_REFUSAL];
    const input = await renderPanel();
    await markByEnter(input, "Ava");
    await act(async () => {});
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0].init!.body as string)).not.toHaveProperty("acknowledged");
    expect(screen.queryByText(/Admit anyway/)).toBeNull();
    expect(screen.queryByText("Class allowance used")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(STAFF_SENTENCE);
  });

  it("an old server's askable flag changes nothing: still one POST and the refusal shown", async () => {
    postResponses = [{ status: 403, body: { ...ALLOWANCE_REFUSAL.body, askable: true } }];
    const input = await renderPanel();
    await markByEnter(input, "Ava");
    await act(async () => {});
    expect(posts()).toHaveLength(1);
    expect(screen.queryByText(/Admit anyway/)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(STAFF_SENTENCE);
  });

  it("the other asks are kept: an on-hold member is still asked, and allowance_reached never travels with the mark", async () => {
    postResponses = [ALLOWANCE_REFUSAL];
    const input = await renderPanel([{ ...AVA, onHold: true }]);
    await markByEnter(input, "Ava");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Admit anyway/ })); });
    await act(async () => {});
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0].init!.body as string).acknowledged).toEqual(["on_hold"]);
    expect(screen.getByRole("alert").textContent).toContain(STAFF_SENTENCE);
  });

  it("a mark a class pack paid for is recorded like any other (no question, no error)", async () => {
    postResponses = [{ status: 201, body: { success: true, record: { id: "rec-1" }, coverage: { kind: "pack", creditsRemaining: 2 } } }];
    const input = await renderPanel();
    await markByEnter(input, "Ava");
    expect(posts()).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
