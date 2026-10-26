// @vitest-environment jsdom
//
// T6a scope 8: Home shows a class the member's plan does not include as
// locked — in "Today's classes" and in the sign-in sheet — the same as the
// schedule does, instead of offering it and refusing at the door.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";
import { isTierLockedForSelf, TIER_LOCKED_LABEL } from "@/lib/class-tier-gate";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/member/home",
}));

import MemberHomePage from "@/app/member/home/page";

const fetchMock = vi.fn();

function setupFetch() {
  const dow = new Date().getDay();
  const row = (id: string, name: string, eligibility: string) => ({
    id, name, startTime: "23:00", endTime: "23:59", coach: "Coach", location: "Mat 1",
    capacity: null, dayOfWeek: dow, classInstanceId: `i-${id}`, eligibility,
  });
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/member/home")) {
      return new Response(JSON.stringify({
        me: { name: "Member", primaryColor: "#3b82f6", onboardingCompleted: true, accountType: "adult", nextClass: null },
        schedule: [row("adv", "Advanced", "tier_not_included"), row("fun", "Fundamentals", "ok")],
        children: [],
        announcements: { announcements: [] },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

describe("Home — tier-locked class", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    const store: Record<string, string> = {};
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = String(v); },
        removeItem: (k: string) => { delete store[k]; },
        clear: () => { for (const k of Object.keys(store)) delete store[k]; },
        key: (i: number) => Object.keys(store)[i] ?? null,
        get length() { return Object.keys(store).length; },
      },
    });
  });

  it("marks the locked class in Today's classes and disables it in the sign-in sheet", async () => {
    setupFetch();
    render(<MemberHomePage />);

    await waitFor(() => expect(screen.getByTestId("home-today-tier-locked")).toBeTruthy());
    expect(screen.getByTestId("home-today-tier-locked").textContent).toContain(TIER_LOCKED_LABEL);
    // Only the locked class carries the chip.
    expect(screen.getAllByTestId("home-today-tier-locked")).toHaveLength(1);

    fireEvent.click(screen.getByText(/Sign In to Class/i));
    const locked = await screen.findByTestId("signin-tier-locked");
    expect((locked as HTMLButtonElement).disabled).toBe(true);
    expect(locked.textContent).toContain("Advanced");
    expect(locked.textContent).toContain(TIER_LOCKED_LABEL);

    // No check-in request goes out for the locked class.
    fireEvent.click(locked);
    const checkinCalls = fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/checkin"));
    expect(checkinCalls).toHaveLength(0);
  });
});

describe("isTierLockedForSelf", () => {
  it("locks a class the member's plan does not include when signing in as themselves", () => {
    expect(isTierLockedForSelf({ eligibility: "tier_not_included" }, null)).toBe(true);
    expect(isTierLockedForSelf({ eligibility: "ok" }, null)).toBe(false);
    expect(isTierLockedForSelf({}, null)).toBe(false);
  });

  it("does not apply the parent's lock when signing a child in (the child's plan decides at the door)", () => {
    expect(isTierLockedForSelf({ eligibility: "tier_not_included" }, "kid-1")).toBe(false);
  });
});
