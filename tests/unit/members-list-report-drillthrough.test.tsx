// @vitest-environment jsdom
//
// Track A (2026-09-21) — Reports page drill-through. The "New this month" and
// "Churn rate this month" tiles on /dashboard/reports link to
// /dashboard/members?filter=new-this-month and ?filter=churned-this-month so
// an owner can see the actual member rows behind those two numbers, rather
// than trusting a count. These cases pin the filtering logic MembersList
// applies for those two deep-link-only filter values (same pattern as the
// existing "active"/"inactive"/"cancelled" values — reachable by URL, no
// visible chip). Month boundary is the current real calendar month, computed
// the same way the component does, so the test does not go stale.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import React from "react";

let currentSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/dashboard/members",
}));

import MembersList, { type MemberRow } from "@/components/dashboard/MembersList";

const now = new Date();
const thisMonth = new Date(now.getFullYear(), now.getMonth(), 10).toISOString();
const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 10).toISOString();

function member(overrides: Partial<MemberRow> & { id: string; name: string }): MemberRow {
  return {
    email: `${overrides.id}@example.test`,
    status: "active",
    joinedAt: lastMonth,
    ...overrides,
  };
}

const MEMBERS: MemberRow[] = [
  // D11: the new-this-month slice lists the members the server flagged as
  // "new" by the movement definition — not a joinedAt comparison.
  member({ id: "m-new", name: "Nina New", joinedAt: thisMonth, moved: ["new"] }),
  member({ id: "m-old", name: "Oscar Old", joinedAt: lastMonth }),
  // A member before this month who left in it: flagged by the server as lost and churned (lib/membership-movement).
  member({ id: "m-churned", name: "Cara Churned", status: "cancelled", joinedAt: lastMonth, cancelledAt: thisMonth, moved: ["lost", "churned"] }),
  member({ id: "m-churned-stale", name: "Sam Stale", status: "cancelled", joinedAt: lastMonth, cancelledAt: lastMonth }),
];

describe("MembersList — Reports drill-through filters", () => {
  it("?filter=new-this-month shows only members who joined this calendar month", () => {
    currentSearch = "filter=new-this-month";
    render(<MembersList members={MEMBERS} primaryColor="#3b82f6" role="owner" />);

    // DataTable renders both a desktop table row and a mobile card-collapse
    // row for each member (CSS, not jsdom, picks one) — assert presence with
    // getAllByText, not the single-match getByText.
    expect(screen.getAllByText("Nina New").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Oscar Old")).toHaveLength(0);
    expect(screen.queryAllByText("Cara Churned")).toHaveLength(0);
    expect(screen.queryAllByText("Sam Stale")).toHaveLength(0);
  });

  it("?filter=churned-this-month shows only the members the server flagged as churned (active when the month began, then left)", () => {
    currentSearch = "filter=churned-this-month";
    render(<MembersList members={MEMBERS} primaryColor="#3b82f6" role="owner" />);

    expect(screen.getAllByText("Cara Churned").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Sam Stale")).toHaveLength(0);
    expect(screen.queryAllByText("Nina New")).toHaveLength(0);
    expect(screen.queryAllByText("Oscar Old")).toHaveLength(0);
  });
});

// ─── T1 (17 Oct 2026): the Active drill-through keeps its filter ─────────────
//
// Reports' "Active members" tile links to ?filter=active. The Members page used
// to narrow the rows but keep the header and first tile on the larger
// "current" count. Now the Active chip is selected, and the chip, the header,
// the first tile and the rows all say the same number (owner decision Q4 A-1:
// active training members, holds included and marked).

const CLUB: MemberRow[] = [
  member({ id: "a1", name: "Ava Active", accountType: "adult" }),
  member({ id: "a2", name: "Ben Active", accountType: "adult" }),
  member({ id: "a3", name: "Cal Onhold", accountType: "kids", paymentStatus: "paused" }),
  member({ id: "i1", name: "Ivy Inactive", status: "inactive" }),
  member({ id: "t1", name: "Tom Taster", status: "taster" }),
  member({ id: "c1", name: "Cy Cancelled", status: "cancelled", cancelledAt: lastMonth }),
  member({ id: "c2", name: "Di Cancelled", status: "cancelled", cancelledAt: lastMonth }),
  member({ id: "g1", name: "Gus Guardian", accountType: "parent" }),
  member({ id: "g2", name: "Gwen Guardian", accountType: "parent" }),
];

const shown = (name: string) => screen.queryAllByText(name).length > 0;
const headline = () => screen.getByTestId("members-headline").textContent;
const scope = () => screen.getByTestId("members-headline-scope").textContent ?? "";
const headlineTile = () => {
  const tile = screen.getByTestId("members-tile-headline");
  return { value: tile.querySelector("p")!.textContent, text: tile.textContent ?? "" };
};

describe("MembersList — Active drill-through and population headline (T1)", () => {
  it("?filter=active: the Active chip is selected and chip, header, first tile and rows all read 3", () => {
    currentSearch = "filter=active";
    render(<MembersList members={CLUB} primaryColor="#3b82f6" role="owner" />);

    const chip = screen.getByRole("button", { name: "Active · 3" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(headline()).toBe("3 active members, 1 on hold");
    expect(scope()).toContain("Excludes inactive members, tasters, cancelled members and guardians");
    expect(headlineTile().value).toBe("3");
    expect(headlineTile().text).toContain("Active members");
    expect(headlineTile().text).toContain("Includes 1 on hold");

    const rows = ["Ava Active", "Ben Active", "Cal Onhold"];
    for (const name of rows) expect(shown(name)).toBe(true);
    for (const name of ["Ivy Inactive", "Tom Taster", "Cy Cancelled", "Di Cancelled", "Gus Guardian", "Gwen Guardian"]) {
      expect(shown(name)).toBe(false);
    }
  });

  it("no filter in the URL opens on Active too, so the landing headline equals Reports' Active members", () => {
    currentSearch = "";
    render(<MembersList members={CLUB} primaryColor="#3b82f6" role="owner" />);
    expect(screen.getByRole("button", { name: "Active · 3" }).getAttribute("aria-pressed")).toBe("true");
    expect(headline()).toBe("3 active members, 1 on hold");
  });

  it("All current: the header and tile show the current count (5) and name what it includes and excludes", () => {
    currentSearch = "filter=active";
    const replaceState = vi.spyOn(window.history, "replaceState");
    render(<MembersList members={CLUB} primaryColor="#3b82f6" role="owner" />);
    fireEvent.click(screen.getByRole("button", { name: "All current · 5" }));

    expect(headline()).toBe("5 current members");
    expect(scope()).toContain("Active and inactive members and tasters");
    expect(scope()).toContain("Excludes cancelled members and guardians");
    expect(headlineTile().value).toBe("5");
    for (const name of ["Ava Active", "Ivy Inactive", "Tom Taster"]) expect(shown(name)).toBe(true);
    expect(shown("Cy Cancelled")).toBe(false);
    expect(shown("Gus Guardian")).toBe(false);
    // The choice is written to the URL, so a reload or a shared link keeps it.
    expect(String(replaceState.mock.calls.at(-1)?.[2])).toContain("filter=all");
    replaceState.mockRestore();
  });

  it("the header and tile follow the other population chips: Cancelled reads 2, guardians 2", () => {
    currentSearch = "filter=cancelled";
    render(<MembersList members={CLUB} primaryColor="#3b82f6" role="owner" />);
    expect(headline()).toBe("2 cancelled members");
    expect(headlineTile().value).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Parents & guardians · 2" }));
    expect(headline()).toBe("2 parents and guardians");
    expect(within(screen.getByTestId("members-tile-headline")).getByText("Not counted in any member total")).toBeTruthy();
  });

  it("a search typed on the Active landing view still finds anyone, as the old All landing view did", () => {
    currentSearch = "";
    Element.prototype.scrollIntoView = vi.fn();
    render(<MembersList members={CLUB} primaryColor="#3b82f6" role="owner" />);
    fireEvent.change(screen.getByLabelText("Search members"), { target: { value: "tom" } });
    expect(shown("Tom Taster")).toBe(true);
  });
});
