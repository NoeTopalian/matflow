// @vitest-environment jsdom
//
// 3 Oct 2026 — the Members page after a TeamUp import.
//
// 1. Parent/guardian accounts (accountType "parent" — including the no-login
//    guardian records an import makes from emergency contacts, which arrive
//    status "active", payment "paid", no plan) are account holders, not
//    training members. They used to inflate Current Members, Paid, Waiver
//    Missing and Missing Phone; they now sit under their own "Parents &
//    guardians" chip, matching Reports and the dashboard (TRAINING_MEMBER).
// 2. The owner/manager sees "N to review" for guardian links the import
//    suggested; it opens the review queue. A coach never sees it.
// 3. When the page hit its row cap it says so rather than silently dropping
//    members from the list, the search and the counts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import React from "react";

let currentSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/dashboard/members",
}));

import MembersList, { type MemberRow } from "@/components/dashboard/MembersList";

const fetchMock = vi.fn();
beforeEach(() => {
  currentSearch = "";
  // jsdom has no layout; MembersList scrolls a single search match into view.
  Element.prototype.scrollIntoView = vi.fn();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(cleanup);

const joined = new Date(Date.now() - 90 * 86400000).toISOString();
function member(over: Partial<MemberRow> & { id: string; name: string }): MemberRow {
  return { email: `${over.id}@example.test`, status: "active", joinedAt: joined, phone: "07000 000000", waiverAccepted: true, paymentStatus: "paid", lastVisitAt: new Date().toISOString(), ...over };
}

const MEMBERS: MemberRow[] = [
  member({ id: "a1", name: "Alex Adult", accountType: "adult", membershipType: "Adults Advanced 2026" }),
  member({ id: "k1", name: "Kit Kid", accountType: "kids", parentMemberId: "g1" }),
  // A guardian record as the TeamUp import writes it.
  member({ id: "g1", name: "Gina Guardian", accountType: "parent", phone: null, waiverAccepted: false, email: "guardian-x@no-login.matflow.local" }),
];

/** A stat tile's value, found by its (unique) sub-caption. */
function tile(sub: string) {
  const el = screen.getByText(sub);
  return el.parentElement!.querySelector("p")!.textContent;
}

describe("Members page — guardian accounts are not training members", () => {
  it("Current Members, Paid, Waiver Missing and Missing Phone leave the guardian record out", () => {
    render(<MembersList members={MEMBERS} primaryColor="#3b82f6" role="owner" />);
    expect(tile("Excludes cancelled & guardians")).toBe("2"); // Current Members
    expect(tile("Membership current")).toBe("2"); // Paid
    expect(tile("Active & tasters")).toBe("0"); // Waivers Missing
    expect(screen.getByRole("button", { name: "All · 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Waiver Missing ·/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Missing Phone ·/ })).toBeNull();
    expect(screen.queryAllByText("Gina Guardian")).toHaveLength(0);
  });

  it("the Parents & guardians chip lists them, and a search on All still finds them", () => {
    render(<MembersList members={MEMBERS} primaryColor="#3b82f6" role="owner" />);
    fireEvent.click(screen.getByRole("button", { name: "Parents & guardians · 1" }));
    expect(screen.getAllByText("Gina Guardian").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Alex Adult")).toHaveLength(0);
    cleanup();
    render(<MembersList members={MEMBERS} primaryColor="#3b82f6" role="owner" />);
    fireEvent.change(screen.getByLabelText("Search members"), { target: { value: "gina" } });
    expect(screen.getAllByText("Gina Guardian").length).toBeGreaterThan(0);
  });
});

describe("Members page — guardian suggestions to review", () => {
  it("an owner sees 'N to review' and it opens the review queue", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ suggestions: [], total: 0, nextCursor: null }) });
    render(<MembersList members={MEMBERS} primaryColor="#3b82f6" role="owner" guardianReviewCount={219} />);
    const badge = screen.getByRole("button", { name: "219 guardian suggestions to review" });
    expect(badge.textContent).toContain("219 to review");
    fireEvent.click(badge);
    expect(await screen.findByText("No guardian suggestions to review")).toBeTruthy();
    expect(String(fetchMock.mock.calls[0][0])).toContain("guardianReview=1");
    // The member table is not shown under the queue.
    expect(screen.queryAllByText("Alex Adult")).toHaveLength(0);
  });

  it("a manager sees it too; ?filter=guardian-review deep-links to the queue", async () => {
    currentSearch = "filter=guardian-review";
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ suggestions: [], total: 0, nextCursor: null }) });
    render(<MembersList members={MEMBERS} primaryColor="#3b82f6" role="manager" guardianReviewCount={4} />);
    expect(screen.getByRole("button", { name: "4 guardian suggestions to review" })).toBeTruthy();
    expect(await screen.findByText("No guardian suggestions to review")).toBeTruthy();
  });

  it("a coach never sees the badge or the queue, even if handed a count", () => {
    currentSearch = "filter=guardian-review";
    render(<MembersList members={MEMBERS} primaryColor="#3b82f6" role="coach" guardianReviewCount={219} />);
    expect(screen.queryByRole("button", { name: /guardian suggestions to review/ })).toBeNull();
    expect(screen.queryByText(/Guardian suggestions to review/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no badge when there is nothing to review", () => {
    render(<MembersList members={MEMBERS} primaryColor="#3b82f6" role="owner" guardianReviewCount={0} />);
    expect(screen.queryByRole("button", { name: /to review/ })).toBeNull();
  });
});

describe("Members page — row cap is said out loud", () => {
  it("shows a notice when the page loaded only the first N members", () => {
    render(<MembersList members={MEMBERS} primaryColor="#3b82f6" role="owner" truncatedAt={1500} />);
    const notice = screen.getByRole("status");
    expect(within(notice).getByText(/more than 1,500 members/)).toBeTruthy();
  });

  it("no notice when everyone was loaded", () => {
    render(<MembersList members={MEMBERS} primaryColor="#3b82f6" role="owner" />);
    expect(screen.queryByText(/more than .* members/)).toBeNull();
  });
});
