// @vitest-environment jsdom
//
// T6d — squad (roster-only) classes shown consistently.
//  - Kiosk: a squad class carries the "Squad only" badge (acceptance 1); the
//    name search names the tapped class so only its roster is listed; an empty
//    search at a squad class says why rather than "keep typing".
//  - Register: "Squad only" (acceptance 3) and a "Not on the squad list" chip
//    on a row whose member is not on the roster.
//  - Session picker: the "Squad only" tag.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import React from "react";
import KioskPage from "@/components/kiosk/KioskPage";
import RegisterPanel from "@/components/dashboard/RegisterPanel";
import SessionPicker, { type TodaySession } from "@/components/dashboard/SessionPicker";
import { NOT_ON_SQUAD_LABEL, SQUAD_NO_MATCH_SENTENCE, SQUAD_ONLY_LABEL } from "@/lib/class-tier-gate";

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const TENANT = { name: "Total BJJ", primaryColor: "#38f", bgColor: "#111", textColor: "#fff", logoUrl: null, fontFamily: "Inter" };

const SESSION: TodaySession = {
  id: "inst-1", classId: "c1", name: "Comp Squad", coachName: null, location: null, color: null,
  startTime: "18:00", endTime: "19:00", maxCapacity: null, attendedCount: 0, waitlistCount: 0,
  status: "ongoing", isCancelled: false, cancellationReason: null, isMine: false,
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("KioskPage — squad classes", () => {
  let urls: string[] = [];
  beforeEach(() => {
    urls = [];
    global.fetch = vi.fn().mockImplementation((url: string) => {
      urls.push(url);
      if (url.endsWith("/classes")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            classes: [
              { id: "inst-squad", name: "Comp Squad", startTime: "18:00", endTime: "19:00", date: "2026-10-17T00:00:00.000Z", requiredRank: null, maxRank: null, rosterOnly: true },
              { id: "inst-open", name: "Fundamentals", startTime: "19:00", endTime: "20:00", date: "2026-10-17T00:00:00.000Z", requiredRank: null, maxRank: null, rosterOnly: false },
            ],
          }),
        });
      }
      if (url.includes("/members?")) return Promise.resolve({ ok: true, json: async () => ({ members: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }) as unknown as typeof fetch;
  });

  it("acceptance 1: badges the squad class only", async () => {
    render(<KioskPage token="kiosk_token_abcdefghijklmnop" tenant={TENANT} />);
    await act(async () => {});
    const badges = screen.getAllByTestId("kiosk-squad-only");
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe(SQUAD_ONLY_LABEL);
    expect(badges[0].closest("button")?.textContent).toContain("Comp Squad");
  });

  it("searches names for the tapped squad class, and an empty result says only the squad can check in", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<KioskPage token="kiosk_token_abcdefghijklmnop" tenant={TENANT} />);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByText("Comp Squad")); });
    fireEvent.change(screen.getByLabelText("Search your name"), { target: { value: "Sam" } });
    await act(async () => { vi.advanceTimersByTime(250); });
    await act(async () => {});
    const search = urls.find((u) => u.includes("/members?"));
    expect(search).toContain("classInstanceId=inst-squad");
    expect(screen.getByText(SQUAD_NO_MATCH_SENTENCE)).toBeTruthy();
  });

  it("an open class keeps the ordinary empty-search copy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<KioskPage token="kiosk_token_abcdefghijklmnop" tenant={TENANT} />);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByText("Fundamentals")); });
    fireEvent.change(screen.getByLabelText("Search your name"), { target: { value: "Sam" } });
    await act(async () => { vi.advanceTimersByTime(250); });
    await act(async () => {});
    expect(screen.getByText("No match yet — keep typing.")).toBeTruthy();
    expect(screen.queryByText(SQUAD_NO_MATCH_SENTENCE)).toBeNull();
  });
});

describe("RegisterPanel — squad classes", () => {
  function mockRegister(rosterOnly: boolean, expected: unknown[]) {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/register")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            instance: { name: "Comp Squad", maxCapacity: null, isKids: false, allowedTiers: [{ id: "t-adv", name: "Advanced" }], rosterOnly },
            expected,
            waitlist: [],
          }),
        });
      }
      if (url.includes("/api/checkin/members")) return Promise.resolve({ ok: true, json: async () => [] });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }) as unknown as typeof fetch;
  }

  const row = (memberId: string, name: string, notOnRoster: boolean) => ({
    memberId, name, email: `${memberId}@x.test`, status: "active", accountType: "adult", membershipType: "Unlimited",
    waiverAccepted: true, walkIn: false, rank: null, attended: false, attendedAt: null, attendedMethod: null,
    lastVisitAt: null, medicalConditions: null, notOnRoster,
  });

  it("acceptance 3: shows Squad only AND the membership line (both must hold, 20 Oct 2026)", async () => {
    mockRegister(true, [row("on", "On Squad", false), row("off", "Off Squad", true)]);
    render(<RegisterPanel instance={SESSION} primaryColor="#38f" onCountChange={() => {}} />);
    await act(async () => {});
    expect(screen.getByTestId("register-squad-only").textContent).toContain(SQUAD_ONLY_LABEL);
    expect(screen.getByTestId("register-allowed-tiers").textContent).toBe("For: Advanced");
    const chips = screen.getAllByTestId("register-not-on-roster");
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe(NOT_ON_SQUAD_LABEL);
    expect(chips[0].closest("li")?.textContent).toContain("Off Squad");
  });

  it("an open class shows neither", async () => {
    mockRegister(false, [row("x", "Anyone", false)]);
    render(<RegisterPanel instance={{ ...SESSION, name: "Fundamentals" }} primaryColor="#38f" onCountChange={() => {}} />);
    await act(async () => {});
    expect(screen.queryByTestId("register-squad-only")).toBeNull();
    expect(screen.queryByTestId("register-not-on-roster")).toBeNull();
  });
});

describe("SessionPicker — the Squad only tag", () => {
  it("tags a squad session and says so to assistive tech", () => {
    render(
      <SessionPicker
        sessions={[{ ...SESSION, rosterOnly: true }, { ...SESSION, id: "inst-2", classId: "c2", name: "Fundamentals", startTime: "19:00", status: "future" }]}
        error={false}
        selectedId="inst-1"
        onSelect={() => {}}
        onRetry={() => {}}
      />,
    );
    const squad = screen.getByRole("button", { name: /Comp Squad/ });
    expect(squad.textContent).toContain(SQUAD_ONLY_LABEL);
    expect(document.getElementById("session-inst-1-status")?.textContent).toContain("squad only");
    const open = screen.getByRole("button", { name: /Fundamentals/ });
    expect(open.textContent).not.toContain(SQUAD_ONLY_LABEL);
  });
});
