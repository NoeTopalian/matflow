// @vitest-environment jsdom
//
// Regression guard: the member schedule must subscribe with the real Class id.
//
// /api/member/schedule returns ONE ROW PER SCHEDULE, so its `id` is a composite
// `${classId}-${scheduleId}` used for grid selection and React keys — and it
// returns the real `classId` alongside it. The page dropped `classId` in its
// mapping and used the composite everywhere, which broke the feature three
// separate ways:
//
//   subscribe  POST /api/member/class-subscriptions/<classId>-<scheduleId>
//              resolved no Class -> 404 -> rolled back with "it may be
//              invite-only". Subscribing could never succeed.
//   unsubscribe DELETE used deleteMany, which matches nothing and still returns
//              200 {removed: 0}. The UI reported success while deleting nothing.
//   read-back  the subscribed set holds REAL class ids, compared against
//              composites — so even a subscription that did exist rendered as
//              un-subscribed.
//
// The hand-written response type in the page omitted `classId`, so dropping it
// was invisible to tsc. These tests assert the URL actually requested, because
// that is the thing that was wrong.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/member/schedule",
}));

import MemberSchedulePage from "@/app/member/schedule/page";

const CLASS_ID = "cls_real_cuid";
const SCHEDULE_ID = "sch_real_cuid";
const COMPOSITE = `${CLASS_ID}-${SCHEDULE_ID}`;

/** One row, shaped exactly as app/api/member/schedule/route.ts returns it. */
function scheduleRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: COMPOSITE,
    classId: CLASS_ID,
    scheduleId: SCHEDULE_ID,
    name: "Beginner BJJ",
    color: "#3b82f6",
    startTime: "18:00",
    endTime: "19:00",
    coach: "Sam Doe",
    location: "Mat 1",
    capacity: 20,
    dayOfWeek: now.getDay(),
    classInstanceId: null,
    eligibility: "ok",
    requiredRankName: null,
    maxRankName: null,
    ...overrides,
  };
}

let calls: Array<{ url: string; method: string }>;

function mockFetch(subscribedClassIds: string[] = []) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, method: init?.method ?? "GET" });

    if (url.startsWith("/api/member/schedule")) {
      return { ok: true, status: 200, json: async () => [scheduleRow()] } as Response;
    }
    if (url.startsWith("/api/member/me/subscriptions")) {
      return { ok: true, status: 200, json: async () => ({ classIds: subscribedClassIds }) } as Response;
    }
    if (url.startsWith("/api/member/class-subscriptions/")) {
      // The real route 404s on an id that resolves no Class. Mirror that, so a
      // regression to the composite fails here rather than passing silently.
      const sent = decodeURIComponent(url.split("/").pop() ?? "");
      if (sent !== CLASS_ID) {
        return { ok: false, status: 404, json: async () => ({ error: "Class not found" }) } as Response;
      }
      return { ok: true, status: 201, json: async () => ({ success: true }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

beforeEach(() => {
  calls = [];
  // jsdom implements neither of these; the grid auto-scrolls to "now" on mount.
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = function scrollTo() {};
  }
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function scrollIntoView() {};
  vi.stubGlobal("fetch", mockFetch());
});

describe("member schedule — subscription keys off the Class id, not the grid-row id", () => {
  it("renders a class as SUBSCRIBED when the server reports its real classId", async () => {
    // The subscribed set holds real class ids. Before the fix this was compared
    // against the composite, so this class always rendered un-subscribed.
    vi.stubGlobal("fetch", mockFetch([CLASS_ID]));
    render(<MemberSchedulePage />);

    await waitFor(() => expect(screen.getAllByText(/Beginner BJJ/i).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(/Beginner BJJ/i)[0]);

    // The sheet offers "Unsubscribe" only when it recognises the existing
    // subscription. Keying off the composite made this read "Subscribe to
    // class" for a member who WAS subscribed — so a member could never tell,
    // and tapping it POSTed a duplicate.
    expect(await screen.findByRole("button", { name: /unsubscribe/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /subscribe to class/i })).toBeNull();
  });

  it("POSTs the real classId, never the composite grid-row id", async () => {
    render(<MemberSchedulePage />);
    await waitFor(() => expect(screen.getAllByText(/Beginner BJJ/i).length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByText(/Beginner BJJ/i)[0]);

    const subscribeBtn = await screen.findByRole("button", { name: /subscribe/i });
    fireEvent.click(subscribeBtn);

    await waitFor(() => {
      const sub = calls.find((c) => c.url.includes("/api/member/class-subscriptions/"));
      expect(sub, "no subscribe request was made").toBeTruthy();
      expect(sub!.url).toContain(CLASS_ID);
      expect(sub!.url).not.toContain(COMPOSITE);
      expect(sub!.url).not.toContain(SCHEDULE_ID);
    });
  });
});
