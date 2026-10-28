// @vitest-environment jsdom
//
// G5 (owner decision, 27 Oct 2026): when the club turns off check-in from the
// app, the member home hides its "Sign In to Class" control (the one place the
// member app offers check-in, for the member and, through the sheet's picker,
// for a parent's children). The timetable stays: today's classes and the next
// class still render. The flag arrives on the payload the page already loads
// (/api/member/home → me.memberAppCheckin); no extra request is made.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { APP_CHECKIN_OFF_MESSAGE } from "@/lib/checkin-outcome";
import React from "react";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/member/home",
}));

import MemberHomePage from "@/app/member/home/page";

const fetchMock = vi.fn();

function setupFetch(me: Record<string, unknown>) {
  const dow = new Date().getDay();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/member/home")) {
      return new Response(JSON.stringify({
        me: { name: "Member", primaryColor: "#3b82f6", onboardingCompleted: true, accountType: "parent", nextClass: null, ...me },
        schedule: [{
          id: "fun", name: "Fundamentals", startTime: "23:00", endTime: "23:59", coach: "Coach", location: "Mat 1",
          capacity: null, dayOfWeek: dow, classInstanceId: "i-fun", eligibility: "ok",
        }],
        children: [{ id: "kid-1", name: "Kid One", belt: null, totalClasses: 0, dateOfBirth: null, timetable: [] }],
        announcements: { announcements: [] },
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

describe("Member home — app check-in switch", () => {
  it("off: no check-in control, but the timetable and the children still show", async () => {
    setupFetch({ memberAppCheckin: false });
    render(<MemberHomePage />);
    await waitFor(() => expect(screen.getByText("Fundamentals")).toBeTruthy());
    expect(screen.getByText("Kid One")).toBeTruthy();
    expect(screen.queryByText(/Sign In to Class/i)).toBeNull();
    expect(screen.queryByTestId("home-checkin-cta")).toBeNull();
    // The flag came on the one home payload: no extra request was made for it.
    const homeCalls = fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/member/home"));
    expect(homeCalls).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/checkin"))).toBe(false);
  });

  it("on: the check-in control shows", async () => {
    setupFetch({ memberAppCheckin: true });
    render(<MemberHomePage />);
    await waitFor(() => expect(screen.getByText(/Sign In to Class/i)).toBeTruthy());
    expect(screen.getByTestId("home-checkin-cta")).toBeTruthy();
  });

  it("an older payload without the field: treated as on (the default), the route still decides", async () => {
    setupFetch({});
    render(<MemberHomePage />);
    await waitFor(() => expect(screen.getByText(/Sign In to Class/i)).toBeTruthy());
  });

  it("opened while home is loading at a club with it off: the sheet shows the club's sentence, it does not vanish", async () => {
    let release!: () => void;
    const answered = new Promise<void>((res) => { release = res; });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/member/home")) {
        await answered;
        return new Response(JSON.stringify({
          me: { name: "Member", primaryColor: "#3b82f6", onboardingCompleted: true, accountType: "adult", nextClass: null, memberAppCheckin: false },
          schedule: [], children: [], announcements: { announcements: [] },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<MemberHomePage />);
    // The control shows while loading; the member opens the sheet.
    fireEvent.click(await screen.findByText(/Sign In to Class/i));
    expect(screen.getByText(/Sign in to a class/i)).toBeTruthy();
    release();
    const off = await screen.findByTestId("signin-app-checkin-off");
    expect(off.textContent).toContain(APP_CHECKIN_OFF_MESSAGE);
    expect(APP_CHECKIN_OFF_MESSAGE).toBe("Check-ins from the app are turned off at this club. Please check in at the desk or the kiosk.");
    // The sheet stayed, offers no class to confirm, and the page control is gone.
    expect(screen.queryByText(/Confirm Sign In/i)).toBeNull();
    expect(screen.queryByTestId("home-checkin-cta")).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/checkin"))).toBe(false);
  });
});
