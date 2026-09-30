// @vitest-environment jsdom
//
// End-user round 2 (30 Sep 2026) — the screen halves:
//  - the register's words (cancelled member, undo credit sentence) and its
//    re-read on focus / visibility (4.4b, 4.6, 4.8)
//  - the member welcome sheet: Skip sticks, and its class list is the club's own (3.2)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import React from "react";
import RegisterPanel from "@/components/dashboard/RegisterPanel";
import {
  clubClassNames, onboardingSkipped, shouldShowOnboarding, skipOnboarding, suppressOnboarding,
} from "@/lib/member-onboarding";

const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

const INSTANCE = {
  id: "inst-1",
  classId: "c1",
  name: "Kids BJJ",
  coachName: "Colm Coach",
  location: null,
  color: "#3b82f6",
  startTime: "12:00",
  endTime: "12:45",
  maxCapacity: 3,
  attendedCount: 0,
  waitlistCount: 0,
  status: "ongoing" as const,
  isCancelled: false,
  cancellationReason: null,
  isMine: true,
};

type Row = { memberId: string; name: string; attended: boolean; usedPackCredit?: boolean };
let calls: string[] = [];

function registerRow(r: Row) {
  return {
    accountType: "adult",
    waiverAccepted: true,
    rank: null,
    attendedMethod: r.attended ? "admin" : null,
    lastVisitAt: null,
    medicalConditions: null,
    ...r,
  };
}

function installFetch(rows: Row[], candidates: Array<Record<string, unknown>>) {
  calls = [];
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/register")) {
      return Promise.resolve({ ok: true, json: async () => ({ expected: rows.map(registerRow), waitlist: [] }) });
    }
    if (url.includes("/api/checkin/members")) {
      return Promise.resolve({ ok: true, json: async () => ({ members: candidates, nextCursor: null }) });
    }
    return Promise.resolve({ ok: true, status: 201, json: async () => ({ success: true }) });
  }) as unknown as typeof fetch;
}

async function renderPanel(rows: Row[], candidates: Array<Record<string, unknown>> = []) {
  installFetch(rows, candidates);
  render(<RegisterPanel instance={INSTANCE} primaryColor="#3b82f6" onCountChange={() => {}} />);
  await act(async () => {});
}

const registerLoads = () => calls.filter((c) => c.includes("/register")).length;
const candidateLoads = () => calls.filter((c) => c.includes("/api/checkin/members")).length;
const posts = () => calls.filter((c) => c === "POST /api/checkin");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the register — a cancelled member", () => {
  it("asks the search list for cancelled members too", async () => {
    await renderPanel([], []);
    expect(calls.some((c) => c.includes("/api/checkin/members") && c.includes("includeCancelled=1"))).toBe(true);
  });

  it("is named as cancelled, not blamed on the spelling, and cannot be marked", async () => {
    await renderPanel([], [
      { id: "cody", name: "Cody Cancel", cancelled: true },
      { id: "ava", name: "Ava Eligible" },
    ]);
    const input = screen.getByPlaceholderText(/Search members/i);
    fireEvent.change(input, { target: { value: "Cody" } });
    expect(screen.queryByText(/No one matches/)).toBeNull();
    expect(screen.getByText("Cody Cancel is cancelled")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Cody Cancel/ })).toBeNull();
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await act(async () => {});
    expect(posts()).toHaveLength(0);
  });

  it("a name nobody has still says to check the spelling", async () => {
    await renderPanel([], [{ id: "ava", name: "Ava Eligible" }]);
    fireEvent.change(screen.getByPlaceholderText(/Search members/i), { target: { value: "Zed" } });
    expect(screen.getByText(/No one matches — check the spelling/)).toBeTruthy();
  });
});

describe("the register — undo", () => {
  it("does not promise a class-pack credit to a monthly member", async () => {
    await renderPanel([{ memberId: "pia", name: "Pia Parent", attended: true, usedPackCredit: false }]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Mark Pia Parent absent" })); });
    expect(screen.getByText(/Pia Parent will no longer be marked as attending this session\.$/)).toBeTruthy();
    expect(screen.queryByText(/class-pack credit/)).toBeNull();
  });

  it("does say the credit comes back when the check-in spent one", async () => {
    await renderPanel([{ memberId: "pam", name: "Pam Pack", attended: true, usedPackCredit: true }]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Mark Pam Pack absent" })); });
    expect(screen.getByText(/The class-pack credit it used is given back\./)).toBeTruthy();
  });
});

describe("the register — re-read when the coach comes back to it", () => {
  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  it("re-reads the register and the search list when the window regains focus", async () => {
    await renderPanel([], []);
    expect(registerLoads()).toBe(1);
    now += 10_000;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(registerLoads()).toBe(2);
    expect(candidateLoads()).toBe(2);
  });

  it("re-reads when the page becomes visible again", async () => {
    await renderPanel([], []);
    now += 10_000;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(registerLoads()).toBe(2);
  });

  it("does not re-read while hidden, and focus plus visibility together read once", async () => {
    await renderPanel([], []);
    now += 10_000;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(registerLoads()).toBe(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(registerLoads()).toBe(2);
  });

  it("does not poll", async () => {
    vi.useFakeTimers();
    try {
      await renderPanel([], []);
      await act(async () => { vi.advanceTimersByTime(120_000); });
      expect(registerLoads()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the member welcome sheet", () => {
  // Node's own half-built `localStorage` global shadows jsdom's here, so the
  // device storage is a plain in-memory Storage for these cases.
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("Skip for now sticks for that member on this device", () => {
    const me = { id: "ava", onboardingCompleted: false };
    expect(shouldShowOnboarding(me)).toBe(true);
    skipOnboarding("ava");
    expect(onboardingSkipped("ava")).toBe(true);
    expect(shouldShowOnboarding(me)).toBe(false);
  });

  it("one member skipping does not hide the sheet from another on the same device", () => {
    skipOnboarding("ava");
    expect(shouldShowOnboarding({ id: "pia", onboardingCompleted: false })).toBe(true);
  });

  it("a finished member never sees it; the post-finish suppressor still works", () => {
    expect(shouldShowOnboarding({ id: "x", onboardingCompleted: true })).toBe(false);
    suppressOnboarding("y");
    expect(shouldShowOnboarding({ id: "y", onboardingCompleted: false })).toBe(false);
  });

  it("the class question lists the club's own classes, once each", () => {
    const schedule = [
      { name: "Kids BJJ", dayOfWeek: 3 },
      { name: "Adult BJJ", dayOfWeek: 3 },
      { name: "Kids BJJ", dayOfWeek: 6 },
      { name: "Adult BJJ", dayOfWeek: 6 },
    ];
    expect(clubClassNames(schedule)).toEqual(["Kids BJJ", "Adult BJJ"]);
    expect(clubClassNames({ error: "x" })).toEqual([]);
  });

  it("the welcome sheet no longer carries a fixed class list", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/member/home/page.tsx", "utf8");
    expect(src).not.toMatch(/"Beginner BJJ", "No-Gi", "Open Mat", "Kids BJJ", "Intermediate", "Wrestling"/);
    expect(src).toMatch(/skipOnboarding\(memberId\)/);
    expect(src).toMatch(/fetch\("\/api\/member\/schedule"\)/);
  });
});
