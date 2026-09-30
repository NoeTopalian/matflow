// @vitest-environment jsdom
//
// Decision 2 (30 Sep 2026): marking an adult into a kids class on the register
// asks first — "{name} is an adult — this is a kids class. Admit anyway?" —
// and the answer travels as `acknowledged: ["kids_class"]`, like the waiver
// and hold overrides. Staff may still admit. A child is not asked about.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import RegisterPanel from "@/components/dashboard/RegisterPanel";

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const INSTANCE = {
  id: "inst-1", classId: "c1", name: "Kids BJJ", coachName: "Cian", location: "Mat 1", color: "#3b82f6",
  startTime: "14:00", endTime: "14:45", maxCapacity: 12, attendedCount: 0, waitlistCount: 0,
  status: "ongoing" as const, isCancelled: false, cancellationReason: null, isMine: true,
};

let calls: Array<{ url: string; init?: RequestInit }> = [];
const posts = () => calls.filter((c) => c.url === "/api/checkin" && c.init?.method === "POST");

async function renderPanel(isKids: boolean, candidates: Array<{ id: string; name: string; accountType: string }>) {
  calls = [];
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/register")) {
      return Promise.resolve({ ok: true, json: async () => ({ instance: { maxCapacity: 12, isKids }, expected: [], waitlist: [] }) });
    }
    if (url.includes("/api/checkin/members")) {
      return Promise.resolve({ ok: true, json: async () => candidates });
    }
    return Promise.resolve({ ok: true, status: 201, json: async () => ({ success: true, record: { id: "rec-1" } }) });
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

describe("RegisterPanel — an adult into a kids class", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("asks, and records nothing until confirmed", async () => {
    const input = await renderPanel(true, [{ id: "m1", name: "Ava Eligible", accountType: "adult" }, { id: "m2", name: "Kai Parent", accountType: "kids" }]);
    await markByEnter(input, "Ava");
    expect(screen.getByText("Ava Eligible is an adult — this is a kids class. Admit anyway?")).toBeTruthy();
    expect(posts()).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ })); });
    await act(async () => {});
    expect(posts()).toHaveLength(0);
  });

  it("admits once confirmed, and the reason travels with the mark", async () => {
    const input = await renderPanel(true, [{ id: "m1", name: "Ava Eligible", accountType: "adult" }, { id: "m2", name: "Kai Parent", accountType: "kids" }]);
    await markByEnter(input, "Ava");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Admit anyway/ })); });
    await act(async () => {});
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0].init!.body as string).acknowledged).toEqual(["kids_class"]);
  });

  it("does not ask about a child", async () => {
    const input = await renderPanel(true, [{ id: "m1", name: "Ava Eligible", accountType: "adult" }, { id: "m2", name: "Kai Parent", accountType: "kids" }]);
    await markByEnter(input, "Kai");
    expect(screen.queryByText(/this is a kids class/)).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  it("does not ask about an adult in an ordinary class", async () => {
    const input = await renderPanel(false, [{ id: "m1", name: "Ava Eligible", accountType: "adult" }, { id: "m2", name: "Kai Parent", accountType: "kids" }]);
    await markByEnter(input, "Ava");
    expect(screen.queryByText(/this is a kids class/)).toBeNull();
    expect(posts()).toHaveLength(1);
  });
});
