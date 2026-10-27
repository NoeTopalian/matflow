// @vitest-environment jsdom
//
// G6 (owner decision, 27 Oct 2026): "It should be till it runs out". The
// member's pack list says how many classes are left and nothing about an
// expiry; packs on sale say they do not expire.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import ClassPacksWidget, { classesLeftLabel } from "@/components/member/ClassPacksWidget";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe("member class pack list", () => {
  it("an owned pack reads \"6 classes left\", with no expiry date or days-left count", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      owned: [{ id: "mp1", packId: "p1", name: "Ten classes", creditsRemaining: 6, totalCredits: 10, purchasedAt: "2026-10-01T10:00:00.000Z", expiresAt: null }],
      available: [{ id: "p1", name: "Ten classes", description: null, totalCredits: 10, pricePence: 8000, currency: "GBP" }],
    }), { status: 200 }));
    const { container } = render(<ClassPacksWidget />);
    await waitFor(() => expect(screen.getByTestId("pack-classes-left").textContent).toBe("6 classes left"));
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\d+d left/);
    expect(text).not.toMatch(/valid \d+ days|expires/i);
    expect(text).toContain("10 classes · no expiry");
    expect(text).toContain("credits never expire");
  });

  it("one class left is singular", () => {
    expect(classesLeftLabel(1)).toBe("1 class left");
    expect(classesLeftLabel(0)).toBe("0 classes left");
  });
});
