// @vitest-environment jsdom
//
// Round 11 (baseline 5.3): a guardian's child timetable marked "Today" against the UTC date
// (new Date().toISOString()), and the server's 7-day window also started on the UTC date. East of
// UTC every morning, and in UK summer 00:00 to 01:00, "Today" sat on the wrong day. Both now use the
// club's calendar date, which /api/member/home returns as `today` (added by PR #92; this change
// depends on it).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
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
import { buildMemberChildren } from "@/lib/member-home";

// 23:00 UTC on 17 Nov = 07:00 on 18 Nov in Bali (club time UTC+8).
const NOW = new Date("2026-11-17T23:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const store: Record<string, string> = {};
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = String(v); },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => {},
      key: () => null,
      length: 0,
    },
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("buildMemberChildren: the 7-day window starts on the club's date", () => {
  function fakeTx(capture: (args: unknown) => void) {
    return {
      member: { findMany: async () => [{ id: "k1", name: "Mia", dateOfBirth: null, accountType: "kids", waiverAccepted: true, memberRanks: [], _count: { attendances: 0 } }] },
      classSubscription: { findMany: async () => [{ memberId: "k1", classId: "c1" }] },
      classInstance: { findMany: async (args: unknown) => { capture(args); return []; } },
    } as never;
  }
  it("with the club's date (18 Nov), the window is 18 to 25 Nov, not from the UTC 17 Nov", async () => {
    let where: { date: { gte: Date; lt: Date } } | null = null;
    await buildMemberChildren(fakeTx((a) => { where = (a as { where: typeof where }).where; }), { tenantId: "t1", memberId: "p1", includeTimetable: true, clubToday: "2026-11-18" });
    expect(where!.date.gte.toISOString()).toBe("2026-11-18T00:00:00.000Z");
    expect(where!.date.lt.toISOString()).toBe("2026-11-25T00:00:00.000Z");
  });
  it("without it (an older caller) the UTC date is used, as before", async () => {
    let where: { date: { gte: Date } } | null = null;
    await buildMemberChildren(fakeTx((a) => { where = (a as { where: typeof where }).where; }), { tenantId: "t1", memberId: "p1", includeTimetable: true });
    expect(where!.date.gte.toISOString()).toBe("2026-11-17T00:00:00.000Z");
  });
});

describe("guardian home: the child's 'Today' is the club's day", () => {
  it("at 07:00 club time (23:00 UTC the day before), the club's today's class is labelled Today and tomorrow's is not", async () => {
    const kid = {
      id: "k1", name: "Mia Lee", belt: null, totalClasses: 0, dateOfBirth: null,
      timetable: [
        { classInstanceId: "i0", classId: "c1", className: "Kids BJJ", date: "2026-11-18", startTime: "16:00", endTime: "17:00", coach: null, location: null, isCancelled: false },
        { classInstanceId: "i1", classId: "c1", className: "Kids BJJ", date: "2026-11-19", startTime: "16:00", endTime: "17:00", coach: null, location: null, isCancelled: false },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.startsWith("/api/member/home")) {
        return json({
          me: { name: "Parent", primaryColor: "#3b82f6", onboardingCompleted: true, accountType: "parent", nextClass: null },
          schedule: [], children: [kid], announcements: { announcements: [] },
          today: { date: "2026-11-18", dayOfWeek: 3 },
        });
      }
      if (url.startsWith("/api/member/me/children")) return json([kid]);
      return json({});
    }));
    render(<MemberHomePage />);
    await act(async () => {});
    fireEvent.click(await screen.findByRole("button", { name: "Show Mia Lee's timetable" }));
    // The day column shows the first word of the label: "Today" for the 18th, "Thu" for the 19th.
    expect(await screen.findAllByText("Today", { selector: "div" })).toHaveLength(1);
    expect(screen.getAllByText("Thu", { selector: "div" })).toHaveLength(1);
  });
});
