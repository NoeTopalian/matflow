// @vitest-environment jsdom
//
// Packs per product (owner decision, 27 Oct 2026): the club chooses an expiry
// or no expiry per pack product. The member's pack list says how many classes
// are left, and the expiry date when the pack has one:
//   no expiry  -> "6 classes left"
//   dated      -> "6 classes left · expires 3 Feb 2027"
// Packs on sale say "no expiry" or "valid N days".

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import ClassPacksWidget, { classesLeftLabel } from "@/components/member/ClassPacksWidget";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

// Midday UTC, so the calendar date is the same in any viewer time zone the suite runs in.
const DATED = "2027-02-03T12:00:00.000Z";

describe("member class pack list", () => {
  it("a no-expiry pack reads \"6 classes left\"; a dated pack adds its expiry date", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      owned: [
        { id: "mp1", packId: "p1", name: "Ten classes", creditsRemaining: 6, totalCredits: 10, purchasedAt: "2026-10-01T10:00:00.000Z", expiresAt: DATED },
        { id: "mp2", packId: "p2", name: "Open pack", creditsRemaining: 6, totalCredits: 10, purchasedAt: "2026-10-01T10:00:00.000Z", expiresAt: null },
      ],
      available: [
        { id: "p1", name: "Ten classes", description: null, totalCredits: 10, validityDays: 90, pricePence: 8000, currency: "GBP" },
        { id: "p2", name: "Open pack", description: null, totalCredits: 10, validityDays: null, pricePence: 9000, currency: "GBP" },
      ],
    }), { status: 200 }));
    const { container } = render(<ClassPacksWidget />);
    await waitFor(() => expect(screen.getAllByTestId("pack-classes-left")).toHaveLength(2));
    const labels = screen.getAllByTestId("pack-classes-left").map((e) => e.textContent);
    expect(labels).toEqual(["6 classes left · expires 3 Feb 2027", "6 classes left"]);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\d+d left/);
    expect(text).toContain("10 classes · valid 90 days");
    expect(text).toContain("10 classes · no expiry");
    expect(text).not.toMatch(/never expire/i);
  });

  it("label: singular, plural, and the expiry suffix only when there is a date", () => {
    expect(classesLeftLabel(1, null)).toBe("1 class left");
    expect(classesLeftLabel(0, null)).toBe("0 classes left");
    expect(classesLeftLabel(6, DATED)).toBe("6 classes left · expires 3 Feb 2027");
  });
});
