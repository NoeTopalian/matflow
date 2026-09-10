// @vitest-environment jsdom
//
// C1 — the add-member membership dropdown reads the gym's real price list.
//
// It used to offer seven invented names ("Monthly Unlimited", "Drop-in",
// "Student"…) that no club had ever agreed to, stored as free text against
// the member. These cases pin that it now reflects the tenant's own
// MembershipTier rows, sends the tier ID rather than a label, and — the part
// that matters most on a screen that decides money — keeps "the gym has no
// tiers" and "we could not find out what the gym's tiers are" as two
// different, honestly-rendered states (UI-RULES §7).
//
// Invariants asserted, not literal copy.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/members",
}));

import MembersList from "@/components/dashboard/MembersList";

const TIER_ROWS = [
  {
    id: "tier_adult",
    name: "Adult Unlimited",
    pricePence: 6500,
    currency: "GBP",
    billingCycle: "monthly",
    stripePriceId: "price_adult",
  },
  {
    id: "tier_kids",
    name: "Kids",
    pricePence: 4000,
    currency: "GBP",
    billingCycle: "monthly",
    stripePriceId: null,
  },
];

function openAddMember() {
  render(<MembersList members={[]} primaryColor="#3b82f6" role="owner" />);
  // The header action and the zero-members empty state both offer it; either
  // opens the same modal.
  fireEvent.click(screen.getAllByRole("button", { name: /add member/i })[0]);
}

function membershipSelect() {
  return screen.queryByLabelText(/^membership$/i) as HTMLSelectElement | null;
}

describe("add-member membership dropdown", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the tenant's own tiers, not a hardcoded list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => TIER_ROWS }),
    );

    openAddMember();

    await waitFor(() => expect(membershipSelect()).not.toBeNull());
    const values = Array.from(membershipSelect()!.options).map((o) => o.value);
    // The placeholder plus one option per tier — the option VALUE is the tier
    // id, because a tier's name was never a stable key.
    expect(values).toEqual(["", "tier_adult", "tier_kids"]);

    const labels = Array.from(membershipSelect()!.options).map((o) => o.textContent ?? "");
    expect(labels.join(" ")).toContain("Adult Unlimited");
    // The desk sees what the tier costs at the point of choosing it.
    expect(labels.join(" ")).toContain("65.00");

    // None of the invented names may survive anywhere in the control.
    const optionText = labels.join(" ");
    for (const invented of ["Monthly Unlimited", "Monthly 2x/week", "Drop-in", "Student"]) {
      expect(optionText).not.toContain(invented);
    }
  });

  it("sends the tier ID to the API, not a free-text label", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.startsWith("/api/memberships")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => TIER_ROWS });
      }
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ id: "mem_new", name: "Sam Carter", email: "sam@example.com" }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    openAddMember();
    await waitFor(() => expect(membershipSelect()).not.toBeNull());

    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: "Sam Carter" } });
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: "sam@example.com" } });
    fireEvent.change(membershipSelect()!, { target: { value: "tier_adult" } });
    fireEvent.click(document.querySelector("button[type='submit']") as HTMLButtonElement);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u]) => u === "/api/members");
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.membershipTierId).toBe("tier_adult");
    });
  });

  it("says the gym has no tiers yet, and points at where to create them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }),
    );

    openAddMember();

    // An EMPTY control is the failure mode being guarded: no select at all,
    // and a route to fix it instead.
    await waitFor(() => {
      const link = document.querySelector("a[href='/dashboard/memberships']");
      expect(link).not.toBeNull();
    });
    expect(membershipSelect()).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders an error with retry when the tier lookup fails — never an empty state", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => TIER_ROWS });
    vi.stubGlobal("fetch", fetchMock);

    openAddMember();

    // A failed lookup is an error with a way out, NOT "no tiers yet" and NOT
    // an empty dropdown.
    await screen.findByRole("alert");
    expect(membershipSelect()).toBeNull();
    expect(document.querySelector("a[href='/dashboard/memberships']")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
    await waitFor(() => expect(membershipSelect()).not.toBeNull());
  });
});
