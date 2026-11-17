// @vitest-environment jsdom
//
// Round 11 (baseline 5.1): a child with no classes said "View the timetable", linking to
// the member schedule, where "Subscribe to class" books the signed-in guardian, not the
// child, and nothing on the class sheet said whose booking it was. The child's card now
// says to ask the club (no booking link), and a guardian's class sheet says the booking
// is theirs, naming the children it is not for. Booking for a child is a separate
// product choice (N-1) and is not added here.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import React from "react";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/member/home",
}));
vi.mock("@/components/member/SignaturePad", () => ({
  __esModule: true,
  default: React.forwardRef(function MockPad() { return <div data-testid="signature-pad" />; }),
}));

import MemberHomePage from "@/app/member/home/page";
import MemberSchedulePage from "@/app/member/schedule/page";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
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
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function scrollIntoView() {};
});

describe("guardian home: a child with no classes", () => {
  it("says to ask the club and offers no link to booking", async () => {
    const kid = { id: "kid-1", name: "Mia Lee", belt: null, totalClasses: 0, dateOfBirth: null };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/member/home")) {
        return json({
          me: { name: "Parent Member", primaryColor: "#3b82f6", onboardingCompleted: true, accountType: "parent", nextClass: null },
          schedule: [], children: [kid], announcements: { announcements: [] },
        });
      }
      if (url.startsWith("/api/member/me/children")) return json([kid]);
      if (url.startsWith("/api/member/schedule")) return json([]);
      return json({});
    }) as typeof fetch;
    render(<MemberHomePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Show Mia Lee's timetable" }));
    const line = await screen.findByTestId("child-no-classes");
    expect(line.textContent).toBe("Mia Lee isn't on any classes yet. Ask your club to add Mia Lee to a class.");
    expect(within(line).queryByRole("link")).toBeNull();
    expect(screen.queryByText("View the timetable")).toBeNull();
  });
});

function scheduleFetch(children: unknown, childrenStatus = 200) {
  const now = new Date();
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/member/schedule")) {
      return json([{
        id: "c1-s1", classId: "c1", scheduleId: "s1", name: "Beginner BJJ", color: "#3b82f6", startTime: "18:00", endTime: "19:00",
        coach: "Sam Doe", location: "Mat 1", capacity: 20, dayOfWeek: now.getDay(), classInstanceId: null, eligibility: "ok",
        requiredRankName: null, maxRankName: null,
      }]);
    }
    if (url.startsWith("/api/member/me/children")) return json(children, childrenStatus);
    if (url.startsWith("/api/member/me/subscriptions")) return json({ classIds: [] });
    return json({});
  }) as typeof fetch;
}

async function openSheet() {
  render(<MemberSchedulePage />);
  await waitFor(() => expect(screen.getAllByText(/Beginner BJJ/i).length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByText(/Beginner BJJ/i)[0]);
  await screen.findByRole("button", { name: /subscribe to class/i });
}

describe("member schedule: whose booking it is", () => {
  it("a guardian's class sheet says it books them, not their children", async () => {
    vi.stubGlobal("fetch", scheduleFetch([{ name: "Mia Lee" }, { name: "Sam Lee" }]));
    await openSheet();
    expect((await screen.findByTestId("books-you")).textContent).toBe("This books you, not Mia Lee or Sam Lee.");
  });

  it("a member with no children sees no such line", async () => {
    vi.stubGlobal("fetch", scheduleFetch([]));
    await openSheet();
    expect(screen.queryByTestId("books-you")).toBeNull();
  });

  it("if the children cannot be read, the line is left off and booking still works", async () => {
    vi.stubGlobal("fetch", scheduleFetch({ error: "nope" }, 500));
    await openSheet();
    expect(screen.queryByTestId("books-you")).toBeNull();
    expect(screen.getByRole("button", { name: /subscribe to class/i })).toBeTruthy();
  });
});
