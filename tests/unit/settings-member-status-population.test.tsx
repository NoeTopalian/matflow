// @vitest-environment jsdom
//
// T1 (17 Oct 2026) — Settings → Overview "Member status" card.
//
// The card used to sum every Member row (guardian accounts included) under an
// unlabelled "Members" tile, and carried a "Paused" row keyed on a status no
// member can have (the CHECK allows active | inactive | cancelled | taster), so
// holds never showed. Now: the tile is "Active members" (the Reports number),
// the status rows are training members only, and "On hold" is read from
// paymentStatus and shown apart from the status rows, with guardian accounts.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("tab=overview"),
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  usePathname: () => "/dashboard/settings",
}));

const SETTINGS = {
  id: "t-A",
  name: "Synthetic Club",
  slug: "synthetic",
  subscriptionTier: "pro",
  subscriptionStatus: "active",
  primaryColor: "#3b82f6",
  secondaryColor: "#2563eb",
  textColor: "#ffffff",
  createdAt: new Date("2026-01-01").toISOString(),
  memberCount: 3,
  staffCount: 1,
  classCount: 0,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderOverview() {
  // Every fetch the overview fires, answered with an honest empty shape.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const body = url.includes("/api/locations") ? { locations: [] } : {};
      return { ok: true, status: 200, json: async () => body };
    }),
  );
  const SettingsPage = (await import("@/components/dashboard/SettingsPage")).default;
  render(
    React.createElement(SettingsPage, {
      settings: SETTINGS,
      staff: [],
      // The synthetic club of the T1 acceptance: active 3 (one on hold),
      // inactive 1, taster 1, cancelled 2 — training members only.
      statusCounts: { active: 3, inactive: 1, taster: 1, cancelled: 2 },
      populationCounts: { onHold: 1, guardians: 2, activeOnHold: 1 },
      primaryColor: "#3b82f6",
      role: "owner",
      currentUserId: "u-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any),
  );
  return (await screen.findByText("Member status", {}, { timeout: 20_000 })).closest("div")!;
}

describe("Settings — member status uses the shared populations (T1)", () => {
  it("the headline tile is Active members and reads the Reports number, 3", async () => {
    await renderOverview();
    const label = screen.getByText("Active members");
    expect(label.parentElement!.querySelector("p")!.textContent).toBe("3");
    // Q4 A-1: the members on hold are inside it and marked, as on Reports.
    expect(screen.getByTestId("settings-active-note").textContent).toBe("Includes 1 on hold · excludes guardians");
  });

  it("shows On hold 1 and guardians apart from the status rows, and no Paused status row", async () => {
    const card = await renderOverview();
    const c = within(card);
    expect(c.getByText("Training members. Excludes parent and guardian accounts.")).toBeTruthy();
    expect(c.queryByText("Paused")).toBeNull();
    const onHold = c.getByText("On hold");
    expect(onHold.parentElement!.textContent).toContain("1");
    expect(onHold.parentElement!.textContent).toContain("never as a status of their own");
    const guardians = c.getByText("Parents and guardians");
    expect(guardians.parentElement!.textContent).toContain("2");
    expect(guardians.parentElement!.textContent).toContain("Not counted in any member total");
  });
});
