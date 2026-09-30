// @vitest-environment jsdom
//
// The "Add someone" search on the attendance hub's RegisterPanel. Until
// 30 Sep 2026 a unique match marked itself 600 ms after typing stopped; the
// end-user simulation typed "Wad" and put an unsigned adult into the kids
// class. Now typing never marks: the unique match is highlighted, and Enter
// or a tap marks it. A member without a signed waiver is asked about first,
// exactly as a held member is.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import RegisterPanel from "@/components/dashboard/RegisterPanel";

const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

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

type Cand = { id: string; name: string; onHold?: boolean; waiverRequired?: boolean };

function installFetch(candidates: Array<Cand>, checkin: { status: number; body: unknown } = { status: 201, body: { success: true, record: { id: "rec-1" } } }) {
  calls = [];
  toastSpy.mockClear();
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/register")) {
      return Promise.resolve({ ok: true, json: async () => ({ expected: [], waitlist: [] }) });
    }
    if (url.includes("/api/checkin/members")) {
      return Promise.resolve({ ok: true, json: async () => candidates });
    }
    return Promise.resolve({ ok: checkin.status < 300, status: checkin.status, json: async () => checkin.body });
  }) as unknown as typeof fetch;
}

const posts = () => calls.filter((c) => c.url === "/api/checkin" && c.init?.method === "POST");

async function renderPanel(candidates: Array<Cand>, checkin?: { status: number; body: unknown }) {
  installFetch(candidates, checkin);
  render(<RegisterPanel instance={INSTANCE} primaryColor="#3b82f6" onCountChange={() => {}} />);
  // Flush the two mount loads (register, candidates) — promise resolution is
  // not timer-based, so fake timers do not hold it.
  await act(async () => {});
  return screen.getByPlaceholderText(/Search members/i) as HTMLInputElement;
}

describe("RegisterPanel search never marks by typing alone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a unique match is highlighted but NOT marked, however long the coach waits", async () => {
    const input = await renderPanel(UNIQUE_NOE_T);
    fireEvent.change(input, { target: { value: "Noe T" } });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(posts()).toHaveLength(0);
    const row = screen.getByRole("button", { name: /Noe Topalian/ });
    expect(row.style.outline).toMatch(/dashed/);
  });

  it("Enter marks the unique match, against the selected session", async () => {
    const input = await renderPanel(UNIQUE_NOE_T);
    fireEvent.change(input, { target: { value: "Noe T" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await act(async () => {});
    expect(posts()).toHaveLength(1);
    const body = JSON.parse(posts()[0].init!.body as string);
    expect(body).toMatchObject({ memberId: "m1", classInstanceId: "inst-1", checkInMethod: "admin" });
    expect(body.acknowledged).toBeUndefined();
    expect(toastSpy).toHaveBeenCalledWith("Marked in: Noe Topalian", "success");
  });

  it("Enter does nothing when the query matches more than one member", async () => {
    const input = await renderPanel(TWO_NOES);
    fireEvent.change(input, { target: { value: "Noe" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(posts()).toHaveLength(0);
  });

  it("a tap marks the member tapped", async () => {
    const input = await renderPanel(TWO_NOES);
    fireEvent.change(input, { target: { value: "Noe" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Noe Tisson/ }));
    });
    await act(async () => {});
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0].init!.body as string).memberId).toBe("m2");
  });
});

describe("RegisterPanel marks tell the truth", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("shows no success toast when the server refuses the check-in", async () => {
    const input = await renderPanel(UNIQUE_NOE_T, { status: 409, body: { error: "Class has been cancelled", reason: "class_cancelled" } });
    fireEvent.change(input, { target: { value: "Noe T" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await act(async () => {});
    expect(posts()).toHaveLength(1);
    expect(toastSpy.mock.calls.some(([m]) => String(m).startsWith("Marked in"))).toBe(false);
    expect(screen.getByRole("alert").textContent).toMatch(/cancelled/i);
  });

  it("asks before admitting an on-hold member found by search, and records nothing until confirmed", async () => {
    const input = await renderPanel([{ id: "m1", name: "Holly Hold", onHold: true }, { id: "m2", name: "Sarah Adams" }]);
    fireEvent.change(input, { target: { value: "Holly" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await act(async () => {});
    expect(screen.getByText(/This membership is on hold/)).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it("asks before admitting a member with no signed waiver, and records nothing if cancelled", async () => {
    const input = await renderPanel([{ id: "m1", name: "Wade Nowaiver", waiverRequired: true }, { id: "m2", name: "Sarah Adams" }]);
    fireEvent.change(input, { target: { value: "Wad" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await act(async () => {});
    expect(screen.getByText("Wade Nowaiver hasn't signed the waiver. Admit anyway?")).toBeTruthy();
    expect(posts()).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ })); });
    await act(async () => {});
    expect(posts()).toHaveLength(0);
  });

  it("admits a no-waiver member once confirmed, and the reason travels with the mark", async () => {
    const input = await renderPanel([{ id: "m1", name: "Wade Nowaiver", waiverRequired: true }, { id: "m2", name: "Sarah Adams" }]);
    fireEvent.change(input, { target: { value: "Wad" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Admit anyway/ })); });
    await act(async () => {});
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0].init!.body as string).acknowledged).toEqual(["waiver_unsigned"]);
  });
});
