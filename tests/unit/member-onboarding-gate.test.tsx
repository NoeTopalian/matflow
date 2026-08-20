// @vitest-environment jsdom
//
// The first-run wizard's OPEN gate on /member/home.
//
// The defect these tests lock down: the wizard used to open from the ABSENCE of
// a localStorage key ("bjj_onboarded"), read in a microtask before the
// /api/member/home fetch had even been issued. The server flag could therefore
// only ever SHUT it afterwards. An already-onboarded member on a new device, a
// new browser, a private window or after clearing site data got the whole
// nine-step wizard again — briefly if the fetch was quick, forever if it
// failed, because the catch only sets loadError. And because the key was not
// namespaced, on a shared or kiosk device the second member to log in inherited
// the first member's key and never saw the wizard at all.
//
// RULES §2: Member.onboardingCompleted from the server is the only thing that
// may open it, and only on an explicit `false`. Unknown means SHUT.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/member/home",
}));

import MemberHomePage from "@/app/member/home/page";

/** Step 0 of the wizard. Present === the blocking wizard is on screen. */
const WIZARD = "onboarding-i-train";
/** Rendered whether or not the wizard is up — proves the page has settled. */
const PAGE_LANDMARK = /Sign In to Class/i;

let store: Record<string, string> = {};

/**
 * `me` is spread into the /api/member/home payload. `null` models "the member
 * row is gone"; omitting onboardingCompleted models an older/partial payload.
 */
function homePayload(me: Record<string, unknown> | null) {
  return JSON.stringify({ me, schedule: [], children: [], announcements: { announcements: [] } });
}

/**
 * Like setupFetch, but /api/member/home hangs until the caller resolves it.
 * The wizard's whole failure mode lives in that window: the old gate opened it
 * from empty localStorage before the fetch was even issued, so a slow answer
 * meant a visible flash and no answer meant it never came down.
 */
function deferredHomeFetch() {
  let release!: (me: Record<string, unknown> | null) => void;
  const answered = new Promise<Record<string, unknown> | null>((res) => { release = res; });

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/member/home")) {
      const me = await answered;
      return new Response(homePayload(me), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  return { release };
}

function setupFetch(me: Record<string, unknown> | null, { homeStatus = 200 } = {}) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/member/home")) {
      if (homeStatus !== 200) {
        return new Response("{}", { status: homeStatus, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        me,
        schedule: [],
        children: [],
        announcements: { announcements: [] },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("member home — the wizard's open gate is the server flag", () => {
  beforeEach(() => {
    // This repo's vitest jsdom wraps localStorage in a non-functional store
    // (the --localstorage-file warning on every run), so the page's suppressor
    // reads would silently no-op. Give it a real one.
    store = {};
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

  it("an ONBOARDED member never sees the wizard, even with no localStorage key at all", async () => {
    // The headline regression: new device / private window / cleared site data.
    //
    // Asserted against a fetch held OPEN, because the old gate's failure was
    // transient: it opened the wizard immediately and the server shut it again
    // once the payload landed. Asserting only after the payload lands passes
    // against the broken code too — that assertion was vacuous, and this is
    // what replaced it.
    const home = deferredHomeFetch();
    render(<MemberHomePage />);

    await waitFor(() => expect(screen.getByText(PAGE_LANDMARK)).toBeTruthy());
    // Still in flight. The answer is unknown, so the wizard must be shut.
    expect(store).toEqual({});
    expect(screen.queryByTestId(WIZARD)).toBeNull();

    home.release({ id: "member-1", name: "Sam Reed", onboardingCompleted: true });
    await waitFor(() => expect(screen.getByText("Sam")).toBeTruthy());
    expect(screen.queryByTestId(WIZARD)).toBeNull();
  });

  it("the wizard stays shut for the whole time a slow fetch is in flight", async () => {
    // Same window, the not-onboarded member. Nothing may render the blocking
    // wizard until the server has actually said `false`.
    const home = deferredHomeFetch();
    render(<MemberHomePage />);

    await waitFor(() => expect(screen.getByText(PAGE_LANDMARK)).toBeTruthy());
    expect(screen.queryByTestId(WIZARD)).toBeNull();

    home.release({ id: "member-1", name: "Sam Reed", onboardingCompleted: false });
    await waitFor(() => expect(screen.getByTestId(WIZARD)).toBeTruthy());
  });

  it("a NOT-onboarded member does see the wizard", async () => {
    setupFetch({ id: "member-1", name: "Sam Reed", onboardingCompleted: false });
    render(<MemberHomePage />);

    await waitFor(() => expect(screen.getByTestId(WIZARD)).toBeTruthy());
  });

  it("a failed /api/member/home leaves the wizard SHUT and shows the retry banner", async () => {
    // Previously the wizard was already up by this point and the catch never
    // cleared it, so a broken page was covered by an undismissable wizard.
    setupFetch(null, { homeStatus: 500 });
    render(<MemberHomePage />);

    // Waiting on the error banner proves the fetch settled — so "no wizard" is
    // a real verdict, not just "the fetch has not resolved yet".
    await waitFor(() => expect(screen.getByText(/Couldn't load your details/i)).toBeTruthy());
    expect(screen.queryByTestId(WIZARD)).toBeNull();
  });

  it("a payload with no member row leaves the wizard SHUT (unknown is not 'not onboarded')", async () => {
    setupFetch(null);
    render(<MemberHomePage />);

    await waitFor(() => expect(screen.getByText(PAGE_LANDMARK)).toBeTruthy());
    expect(screen.queryByTestId(WIZARD)).toBeNull();
  });

  it("a payload that omits onboardingCompleted leaves the wizard SHUT", async () => {
    setupFetch({ id: "member-1", name: "Sam Reed" });
    render(<MemberHomePage />);

    await waitFor(() => expect(screen.getByText(PAGE_LANDMARK)).toBeTruthy());
    expect(screen.queryByTestId(WIZARD)).toBeNull();
  });

  it("the suppressor is per member — another member's key on a shared device does not suppress", async () => {
    // The kiosk case. Under the old un-namespaced key this member saw nothing.
    store["bjj_onboarded:member-A"] = "true";
    setupFetch({ id: "member-B", name: "Sam Reed", onboardingCompleted: false });
    render(<MemberHomePage />);

    await waitFor(() => expect(screen.getByTestId(WIZARD)).toBeTruthy());
  });

  it("the suppressor still works for the member it belongs to", async () => {
    store["bjj_onboarded:member-B"] = "true";
    setupFetch({ id: "member-B", name: "Sam Reed", onboardingCompleted: false });
    render(<MemberHomePage />);

    await waitFor(() => expect(screen.getByText(PAGE_LANDMARK)).toBeTruthy());
    expect(screen.queryByTestId(WIZARD)).toBeNull();
  });

  it("the legacy un-namespaced key no longer suppresses anything", async () => {
    // Members carrying the old key must still be gated by the server, not by a
    // stale browser value that says nothing about who is logged in.
    store["bjj_onboarded"] = "true";
    setupFetch({ id: "member-1", name: "Sam Reed", onboardingCompleted: false });
    render(<MemberHomePage />);

    await waitFor(() => expect(screen.getByTestId(WIZARD)).toBeTruthy());
  });
});
