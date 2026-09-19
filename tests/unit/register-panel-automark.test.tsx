// @vitest-environment jsdom
//
// The unique-match auto-mark, carried from the old Mark Attendance into the
// attendance hub's RegisterPanel (18 Sep 2026): when the "Add someone" query
// names exactly one not-yet-marked member, they are marked after 600 ms — a
// window to keep typing if someone else was meant. Two matches, a one-letter
// query, or a query that keeps changing must never fire.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import RegisterPanel from "@/components/dashboard/RegisterPanel";

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const INSTANCE = {
  id: "inst-1",
  classId: "c1",
  name: "Beginner BJJ",
  coachName: "Coach Mike",
  location: "Mat 1",
  color: "#3b82f6",
  startTime: "10:00",
  endTime: "11:00",
  maxCapacity: 20,
  attendedCount: 0,
  waitlistCount: 0,
  status: "ongoing" as const,
  isCancelled: false,
  cancellationReason: null,
  isMine: false,
};

const TWO_NOES = [
  { id: "m1", name: "Noe Topalian" },
  { id: "m2", name: "Noe Tisson" },
  { id: "m3", name: "Bob Smith" },
];
const UNIQUE_NOE_T = [
  { id: "m1", name: "Noe Topalian" },
  { id: "m2", name: "Sarah Adams" },
];

let calls: Array<{ url: string; init?: RequestInit }> = [];

function installFetch(candidates: Array<{ id: string; name: string }>) {
  calls = [];
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/register")) {
      return Promise.resolve({ ok: true, json: async () => ({ expected: [], waitlist: [] }) });
    }
    if (url.includes("/api/checkin/members")) {
      return Promise.resolve({ ok: true, json: async () => candidates });
    }
    return Promise.resolve({ ok: true, status: 201, json: async () => ({ success: true, record: { id: "rec-1" } }) });
  }) as unknown as typeof fetch;
}

const posts = () => calls.filter((c) => c.url === "/api/checkin" && c.init?.method === "POST");

async function renderPanel(candidates: Array<{ id: string; name: string }>) {
  installFetch(candidates);
  render(<RegisterPanel instance={INSTANCE} primaryColor="#3b82f6" onCountChange={() => {}} />);
  // Flush the two mount loads (register, candidates) — promise resolution is
  // not timer-based, so fake timers do not hold it.
  await act(async () => {});
  return screen.getByPlaceholderText(/Search members/i) as HTMLInputElement;
}

describe("RegisterPanel unique-match auto-mark", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("marks the one match after the 600 ms window, against the selected session", async () => {
    const input = await renderPanel(UNIQUE_NOE_T);
    fireEvent.change(input, { target: { value: "Noe T" } });
    expect(posts()).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    expect(posts()).toHaveLength(1);
    const body = JSON.parse(posts()[0].init!.body as string);
    expect(body).toMatchObject({ memberId: "m1", classInstanceId: "inst-1", checkInMethod: "admin" });
  });

  it("does NOT fire when the query matches more than one member", async () => {
    const input = await renderPanel(TWO_NOES);
    fireEvent.change(input, { target: { value: "Noe" } });
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(posts()).toHaveLength(0);
  });

  it("does NOT fire on a one-character query", async () => {
    const input = await renderPanel(UNIQUE_NOE_T);
    fireEvent.change(input, { target: { value: "N" } });
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(posts()).toHaveLength(0);
  });

  it("rapid typing cancels the earlier window — only the final unique match fires, once", async () => {
    const input = await renderPanel(UNIQUE_NOE_T);
    fireEvent.change(input, { target: { value: "No" } });
    await act(async () => { vi.advanceTimersByTime(200); });
    fireEvent.change(input, { target: { value: "Noe " } });
    await act(async () => { vi.advanceTimersByTime(200); });
    fireEvent.change(input, { target: { value: "Noe T" } });
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(posts()).toHaveLength(1);
  });
});
