// @vitest-environment jsdom
//
// Round 11 item 4.1: the member class detail sheet was a hand-rolled overlay
// with no dialog semantics, no focus move, no trap and no Escape. A keyboard or
// switch member who opened a class stayed behind the scrim and had to Tab
// through the whole page to reach "Subscribe". It now runs on the shared
// overlay behaviour (components/ui/overlay.tsx `useOverlay`): labelled dialog,
// focus moves in, Tab loops inside, Escape closes and focus returns to the
// class that opened it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/member/schedule",
}));

import MemberSchedulePage from "@/app/member/schedule/page";

function scheduleRow() {
  return {
    id: "cls_a-sch_a",
    classId: "cls_a",
    scheduleId: "sch_a",
    name: "Beginner BJJ",
    color: "#3b82f6",
    startTime: "18:00",
    endTime: "19:00",
    coach: "Sam Doe",
    location: "Mat 1",
    capacity: 20,
    dayOfWeek: new Date().getDay(),
    classInstanceId: null,
    eligibility: "ok",
    requiredRankName: null,
    maxRankName: null,
  };
}

beforeEach(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function scrollIntoView() {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.startsWith("/api/member/schedule")) {
        return { ok: true, status: 200, json: async () => [scheduleRow()] } as Response;
      }
      if (url.startsWith("/api/member/me/subscriptions")) {
        return { ok: true, status: 200, json: async () => ({ classIds: [] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

/** The focusable control that opens the class: the tile carrying its name. */
async function openClass() {
  render(<MemberSchedulePage />);
  await waitFor(() => expect(screen.getAllByText(/Beginner BJJ/i).length).toBeGreaterThan(0));
  const opener = screen.getAllByText(/Beginner BJJ/i)[0].closest("button") as HTMLElement;
  expect(opener, "the class tile is not a button").toBeTruthy();
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "Beginner BJJ" });
  return { opener, dialog };
}

const tab = (shiftKey = false) => fireEvent.keyDown(document, { key: "Tab", shiftKey });

describe("member class detail sheet — keyboard and focus", () => {
  it("is a modal dialog labelled by the class name", async () => {
    const { dialog } = await openClass();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("moves focus into the sheet on open", async () => {
    const { dialog } = await openClass();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("keeps Tab and Shift+Tab inside the sheet", async () => {
    const { dialog } = await openClass();
    const controls = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled])")];
    expect(controls.length).toBeGreaterThan(1);
    controls.at(-1)!.focus();
    tab();
    expect(document.activeElement).toBe(controls[0]);
    tab(true);
    expect(document.activeElement).toBe(controls.at(-1));
  });

  it("closes on Escape and returns focus to the class that opened it", async () => {
    const { opener } = await openClass();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("the close button has an accessible name", async () => {
    const { dialog } = await openClass();
    expect(dialog.querySelector('button[aria-label="Close"]')).toBeTruthy();
  });
});
