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
import { render, screen } from "@testing-library/react";
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
  member({ id: "m-new", name: "Nina New", joinedAt: thisMonth }),
  member({ id: "m-old", name: "Oscar Old", joinedAt: lastMonth }),
  member({ id: "m-churned", name: "Cara Churned", status: "cancelled", joinedAt: lastMonth, cancelledAt: thisMonth }),
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

  it("?filter=churned-this-month shows only cancelled members whose cancelledAt is this calendar month", () => {
    currentSearch = "filter=churned-this-month";
    render(<MembersList members={MEMBERS} primaryColor="#3b82f6" role="owner" />);

    expect(screen.getAllByText("Cara Churned").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Sam Stale")).toHaveLength(0);
    expect(screen.queryAllByText("Nina New")).toHaveLength(0);
    expect(screen.queryAllByText("Oscar Old")).toHaveLength(0);
  });
});
