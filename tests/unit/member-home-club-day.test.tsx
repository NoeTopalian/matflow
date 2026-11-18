// @vitest-environment jsdom
//
// Round 6 close-out (13 Nov 2026): the member home lists the CLUB's today, the day /api/member/home paired the
// sessions with (`today.dayOfWeek`), not the device's weekday. The check-in sends that class's session.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/member/home" }));

import MemberHomePage from "@/app/member/home/page";

const fetchMock = vi.fn();
const deviceDow = new Date().getDay();
const clubDow = (deviceDow + 1) % 7;

function setupFetch(today: { date: string; dayOfWeek: number } | undefined) {
  const row = (id: string, name: string, dayOfWeek: number) => ({
    id, name, startTime: "23:00", endTime: "23:59", coach: "Coach", location: "Mat 1",
    capacity: null, dayOfWeek, classInstanceId: `i-${id}`, eligibility: "ok",
  });
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/member/home")) {
      return new Response(JSON.stringify({
        me: { name: "Member", primaryColor: "#3b82f6", onboardingCompleted: true, accountType: "adult", nextClass: null },
        schedule: [row("club", "Club Day Gi", clubDow), row("device", "Device Day Gi", deviceDow)],
        children: [],
        announcements: { announcements: [] },
        ...(today ? { today } : {}),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

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

describe("member home: today's classes are the club's day", () => {
  it("lists the class of the club's weekday from the answer, not the device's", async () => {
    setupFetch({ date: "2026-11-14", dayOfWeek: clubDow });
    render(<MemberHomePage />);
    await waitFor(() => expect(screen.getAllByText(/Club Day Gi/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/Device Day Gi/)).toBeNull();
  });

  it("an older server without `today`: the device's weekday, as before", async () => {
    setupFetch(undefined);
    render(<MemberHomePage />);
    await waitFor(() => expect(screen.getAllByText(/Device Day Gi/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/Club Day Gi/)).toBeNull();
  });
});
