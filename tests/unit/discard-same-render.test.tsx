// @vitest-environment jsdom
//
// Round 11 follow-up (final acceptance on 056e6e21, round11-discard-rollout race): the rank form and the class form
// report "changed" to the sheet through onDirtyChange. From a useEffect, the parent's update landed one task late, so a
// dismissal already queued behind the first edit (a busy phone, Escape pressed while the keystroke is still being
// handled) found confirmDiscard false and closed the sheet, throwing that edit away. Reported from a layout effect, the
// sheet knows before the next event. These tests deliver the edit and the dismissal as real DOM events with no act()
// between them and no macrotask in between, which is what a queued input looks like.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import React from "react";

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import RanksManager from "@/components/dashboard/RanksManager";
import TimetableManager from "@/components/dashboard/TimetableManager";
import type { ClassRow } from "@/app/dashboard/timetable/page";

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url === "/api/locations" ? { locations: [] } : url === "/api/coach/today" ? [] : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  cleanup();
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  document.body.style.overflow = "";
});

const question = () => screen.queryByRole("dialog", { name: "Discard your changes?" });

// Type into a controlled input the way the browser does: native value setter, then a bubbling input event.
function typeNative(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
// Run the edit's own (microtask) render, but no macrotask: the dismissal is already queued.
async function microtasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
async function settle() {
  await new Promise((r) => setTimeout(r, 50));
}
const dismissals = {
  "scrim tap": () => (document.querySelector('[data-slot="sheet-scrim"]') as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })),
  Escape: () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
};

describe("ranks: the first edit and a queued dismissal", () => {

  it("control: with one task between the edit and the dismissal it asks (the test's events do reach the form)", async () => {
      render(<RanksManager initialRanks={[]} primaryColor="#123456" role="owner" />);
      await act(async () => {});
      await act(async () => { screen.getAllByRole("button", { name: "Add rank" })[0].click(); });
      const input = screen.getByLabelText(/Rank name/) as HTMLInputElement;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    typeNative(input, "P");
    await settle();
    dismissals.Escape();
    await settle();
    expect(question()).not.toBeNull();
  });
  for (const [how, dismiss] of Object.entries(dismissals)) {
    it(`${how} right after the first keystroke asks, and the typed name survives`, async () => {
      render(<RanksManager initialRanks={[]} primaryColor="#123456" role="owner" />);
      await act(async () => {});
      await act(async () => { screen.getAllByRole("button", { name: "Add rank" })[0].click(); });
      const input = screen.getByLabelText(/Rank name/) as HTMLInputElement;

      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
      typeNative(input, "P");
      await microtasks();
      dismiss();
      await settle();

      expect(question()).not.toBeNull();
      expect((screen.getByLabelText(/Rank name/) as HTMLInputElement).value).toBe("P");
    });
  }
});

const GI: ClassRow = {
  id: "c1", name: "Gi", coachName: null, coachUserId: null, coachUser: null, location: null, locationId: null,
  duration: 60, maxCapacity: null, color: null, description: null, requiredRankId: null, requiredRank: null,
  maxRankId: null, maxRank: null,
  schedules: [{ id: "slot-mon", dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
  roster: [], lifecycle: "active", archivedAt: null,
};
const PROPS = { rankSystems: [], coachUsers: [], primaryColor: "var(--color-primary)", role: "owner", currentUserId: "u1" };

describe("classes: the first edit and a queued dismissal", () => {

  it("control: with one task between the edit and the dismissal it asks (the test's events do reach the form)", async () => {
      render(<TimetableManager initialClasses={[GI]} {...PROPS} />);
      await act(async () => {});
      await act(async () => { screen.getAllByRole("button", { name: /^Edit Gi/ })[0].click(); });
      const input = screen.getByLabelText("Class Name") as HTMLInputElement;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    typeNative(input, "Gi 2");
    await settle();
    dismissals.Escape();
    await settle();
    expect(question()).not.toBeNull();
  });
  for (const [how, dismiss] of Object.entries(dismissals)) {
    it(`${how} right after the first keystroke asks, and the typed name survives`, async () => {
      render(<TimetableManager initialClasses={[GI]} {...PROPS} />);
      await act(async () => {});
      await act(async () => { screen.getAllByRole("button", { name: /^Edit Gi/ })[0].click(); });
      const input = screen.getByLabelText("Class Name") as HTMLInputElement;

      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
      typeNative(input, "Gi 2");
      await microtasks();
      dismiss();
      await settle();

      expect(question()).not.toBeNull();
      expect((screen.getByLabelText("Class Name") as HTMLInputElement).value).toBe("Gi 2");
    });
  }
});
