// @vitest-environment jsdom
//
// D2 (booking preservation, approved 21 Oct 2026): a booking kept after the
// member lost access is VISIBLE —
//  - the member's schedule API marks the booked class with the door's own
//    sentence, and no longer hides a squad class the member is booked on;
//  - the member's schedule shows "Not eligible: <sentence>" on the booked
//    class, and the member can still cancel the booking;
//  - the coach register flags a booked member the door now turns away.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import React from "react";
import { ROSTER_REFUSAL_SENTENCE, tierRefusalSentence } from "@/lib/class-tier-gate";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/member/schedule",
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const db = vi.hoisted(() => ({
  class: { findMany: vi.fn() },
  classInstance: { findMany: vi.fn() },
  memberRank: { findMany: vi.fn() },
  classRoster: { findMany: vi.fn(), groupBy: vi.fn() },
  member: { findFirst: vi.fn() },
  classSubscription: { findMany: vi.fn() },
}));
const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
}));

import { GET as scheduleGET } from "@/app/api/member/schedule/route";
import MemberSchedulePage from "@/app/member/schedule/page";
import RegisterPanel from "@/components/dashboard/RegisterPanel";

const cls = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, color: "#3b82f6", coachName: "Coach", coachUser: null, location: "Mat 1", maxCapacity: 20, isKids: false, category: null,
  requiredRank: null, maxRank: null,
  schedules: [{ id: `${id}-s`, dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
  allowedTiers: [], ...over,
});

describe("GET /api/member/schedule — booked classes the member is now turned away from", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { tenantId: "t1", memberId: "me" } });
    db.classInstance.findMany.mockResolvedValue([]);
    db.memberRank.findMany.mockResolvedValue([{ rankSystem: { id: "r1", discipline: "BJJ", order: 1 } }]);
    db.member.findFirst.mockResolvedValue({ accountType: "adult", membershipTierId: "t-beg", membershipTier: { name: "Beginners" } });
    db.classRoster.findMany.mockResolvedValue([]); // the member is on no squad list
    db.classRoster.groupBy.mockResolvedValue([{ classId: "squad", _count: { _all: 3 } }, { classId: "squad-unbooked", _count: { _all: 2 } }]);
    db.class.findMany.mockResolvedValue([
      cls("squad", "Comp Squad"),
      cls("squad-unbooked", "Other Squad"),
      cls("adv", "Advanced", { allowedTiers: [{ tierId: "t-adv" }] }),
      cls("blue", "Blue Belts", { requiredRank: { id: "r2", name: "Blue", discipline: "BJJ", order: 2 } }),
      cls("open", "Open Mat"),
    ]);
    db.classSubscription.findMany.mockResolvedValue([{ classId: "squad" }, { classId: "adv" }, { classId: "blue" }, { classId: "open" }]);
  });

  it("marks each booked class with the door's sentence; a booked squad class is shown, an unbooked one stays hidden", async () => {
    const rows = (await (await scheduleGET(new Request("http://test/api/member/schedule"))).json()) as Array<{ classId: string; bookedIneligible: { reason: string; sentence: string } | null }>;
    const by = new Map(rows.map((r) => [r.classId, r.bookedIneligible]));
    expect(by.has("squad-unbooked")).toBe(false);
    expect(by.get("squad")).toEqual({ reason: "roster_not_listed", sentence: ROSTER_REFUSAL_SENTENCE });
    expect(by.get("adv")).toEqual({ reason: "tier_not_included", sentence: tierRefusalSentence("Advanced", "Beginners") });
    expect(by.get("blue")).toEqual({ reason: "rank_below", sentence: "Your current rank is below this class's required rank." });
    expect(by.get("open")).toBeNull();
    // The member's own bookings are read inside the club only.
    expect(db.classSubscription.findMany.mock.calls[0][0].where).toEqual({ memberId: "me", class: { tenantId: "t1" } });
  });
});

describe("member schedule page — a booked class marked Not eligible", () => {
  const row = {
    id: "c1-s1", classId: "c1", scheduleId: "s1", name: "Advanced", color: "#3b82f6", startTime: "18:00", endTime: "19:00",
    coach: "Coach", location: "Mat 1", capacity: 20, dayOfWeek: new Date().getDay(), classInstanceId: null,
    eligibility: "tier_not_included", requiredRankName: null, maxRankName: null,
    bookedIneligible: { reason: "tier_not_included", sentence: tierRefusalSentence("Advanced", "Beginners") },
  };
  beforeEach(() => {
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function scrollIntoView() {};
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/member/schedule")) return { ok: true, status: 200, json: async () => [row] } as Response;
      if (url.startsWith("/api/member/me/subscriptions")) return { ok: true, status: 200, json: async () => ({ classIds: ["c1"] }) } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }));
  });

  it("shows the door's sentence, says the booking is kept, and still lets the member cancel it", async () => {
    render(<MemberSchedulePage />);
    await waitFor(() => expect(screen.getAllByTestId("schedule-cell-booked-ineligible").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(/Advanced/)[0]);
    const note = await screen.findByTestId("schedule-booked-ineligible");
    expect(note.textContent).toContain(`Not eligible: ${tierRefusalSentence("Advanced", "Beginners")}`);
    expect(note.textContent).toContain("Your booking is kept");
    const cancel = screen.getByRole("button", { name: /unsubscribe/i }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
  });
});

describe("coach register — booked members the door now turns away", () => {
  const INSTANCE = {
    id: "inst-1", classId: "c1", name: "Advanced", coachName: "Cian", location: "Mat 1", color: "#3b82f6",
    startTime: "19:00", endTime: "20:00", maxCapacity: 20, attendedCount: 0, waitlistCount: 0,
    status: "ongoing" as const, isCancelled: false, cancellationReason: null, isMine: true,
  };
  const booked = (extra: Record<string, unknown>) => ({
    memberId: "m1", name: "Ava Booked", accountType: "adult", waiverAccepted: true, rank: null,
    attended: false, attendedMethod: null, lastVisitAt: null, medicalConditions: null, walkIn: false, ...extra,
  });
  const renderPanel = async (expected: unknown[]) => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/register")) {
        return Promise.resolve({ ok: true, json: async () => ({ instance: { name: "Advanced", maxCapacity: 20, isKids: false, allowedTiers: [] }, expected, waitlist: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    }) as unknown as typeof fetch;
    render(<RegisterPanel instance={INSTANCE} primaryColor="#3b82f6" onCountChange={() => {}} />);
    await act(async () => {});
  };

  it("flags a booked member refused on rank, and says staff can still mark them in", async () => {
    await renderPanel([booked({ bookedIneligible: { reasons: ["rank_below"], sentence: "Your current rank is below this class's required rank.", staffDoorsAdmit: true } })]);
    const chip = await screen.findByTestId("register-booked-ineligible");
    expect(chip.textContent).toMatch(/Booked · not eligible/i);
    expect(chip.getAttribute("title")).toBe("Booked, but not eligible: Your current rank is below this class's required rank.");
    expect(screen.getByTestId("register-booked-rank-note").textContent).toMatch(/staff can still mark them in/);
  });

  it("a walk-in is never flagged as a kept booking", async () => {
    await renderPanel([booked({ walkIn: true, bookedIneligible: null })]);
    expect(screen.queryByTestId("register-booked-ineligible")).toBeNull();
  });
});
