// @vitest-environment jsdom
//
// C1 — the staff "put this member on a paid membership" control.
//
// POST /api/stripe/create-subscription was finished, gated and unit-tested
// with no caller at all. These cases pin the caller's contract and, more
// importantly, its FAILURE behaviour: the defect this codebase repeats is UI
// that reports success when the server failed, and a money screen is the worst
// place for it.
//
// Invariants asserted (never literal copy):
//   - the request body is exactly the endpoint's schema
//   - a non-ok response: no success toast, no "you now have a membership"
//     callback, and an alert is rendered
//   - an ok response with no subscriptionId is ALSO a failure
//   - a network throw is reported without asserting either outcome
//   - a gym that cannot take payments is not offered a submit control
//   - a member who already has a subscription is not offered a second one

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

import SubscribeDrawer from "@/components/dashboard/SubscribeDrawer";
import type { MembershipTierOption, TenantBilling } from "@/components/dashboard/MemberProfile";

const TIERS: MembershipTierOption[] = [
  {
    id: "tier_adult",
    name: "Adult Unlimited",
    pricePence: 6500,
    currency: "GBP",
    billingCycle: "monthly",
    stripePriceId: "price_adult_unlimited",
  },
  {
    id: "tier_unwired",
    name: "Family",
    pricePence: 12000,
    currency: "GBP",
    billingCycle: "monthly",
    // No Stripe price: cannot be billed, so must not be selectable.
    stripePriceId: null,
  },
];

const READY: TenantBilling = { stripeConnected: true, chargesEnabled: true };

function renderDrawer(overrides: Partial<React.ComponentProps<typeof SubscribeDrawer>> = {}) {
  const onSubscribed = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <SubscribeDrawer
      memberId="mem_1"
      memberName="Sam Carter"
      open
      onClose={onClose}
      tiers={TIERS}
      billing={READY}
      existingSubscriptionId={null}
      onSubscribed={onSubscribed}
      {...overrides}
    />,
  );
  return { ...utils, onSubscribed, onClose };
}

function submitButton() {
  // The only submit control in the sheet footer.
  return document.querySelector("button[type='submit']") as HTMLButtonElement | null;
}

function selectTier(value: string) {
  const select = screen.getByLabelText(/membership tier/i) as HTMLSelectElement;
  fireEvent.change(select, { target: { value } });
  return select;
}

describe("SubscribeDrawer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("only offers tiers that are wired to a Stripe price", () => {
    renderDrawer();
    const select = screen.getByLabelText(/membership tier/i) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("tier_adult");
    // A tier with no Stripe price cannot be billed, so it cannot be picked.
    expect(values).not.toContain("tier_unwired");
  });

  it("posts exactly the endpoint's schema", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ subscriptionId: "sub_123", clientSecret: "pi_1_secret_x" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { onSubscribed } = renderDrawer();
    selectTier("tier_adult");
    fireEvent.click(submitButton()!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/stripe/create-subscription");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    // The route's zod schema: memberId + a price_ id. Nothing else is required,
    // and priceId must be the STRIPE price, never the tier's own row id.
    expect(body.memberId).toBe("mem_1");
    expect(body.priceId).toBe("price_adult_unlimited");
    expect(body.priceId.startsWith("price_")).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["memberId", "priceId"]);

    await waitFor(() => expect(onSubscribed).toHaveBeenCalledWith("sub_123"));
  });

  it("does NOT claim success when the server rejects the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "This gym's Stripe account requires attention." }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { onSubscribed, onClose } = renderDrawer();
    selectTier("tier_adult");
    fireEvent.click(submitButton()!);

    // The invariant, not the wording: an alert appears carrying the SERVER's
    // own message, the parent is never told a subscription exists, and the
    // drawer stays open so the failure cannot scroll away unnoticed.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Stripe account requires attention");
    expect(onSubscribed).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("treats a 200 with no subscriptionId as a failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { onSubscribed, onClose } = renderDrawer();
    selectTier("tier_adult");
    fireEvent.click(submitButton()!);

    await screen.findByRole("alert");
    expect(onSubscribed).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reports a network failure without asserting either outcome", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    const { onSubscribed } = renderDrawer();
    selectTier("tier_adult");
    fireEvent.click(submitButton()!);

    const alert = await screen.findByRole("alert");
    // The request may well have reached Stripe, so the copy must not settle
    // the question in either direction.
    expect(alert.textContent).toMatch(/may already have been created/i);
    expect(onSubscribed).not.toHaveBeenCalled();
  });

  it("does not offer a working control when the gym cannot take payments", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderDrawer({ billing: { stripeConnected: false, chargesEnabled: null } });

    // No tier picker at all — nothing to submit — and the reason is stated.
    expect(screen.queryByLabelText(/membership tier/i)).toBeNull();
    expect(submitButton()!.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a second subscription for an already-subscribed member", () => {
    renderDrawer({ existingSubscriptionId: "sub_existing" });
    expect(screen.queryByLabelText(/membership tier/i)).toBeNull();
    expect(submitButton()!.disabled).toBe(true);
  });

  it("keeps the submit control disabled until a tier is chosen", () => {
    renderDrawer();
    expect(submitButton()!.disabled).toBe(true);
    selectTier("tier_adult");
    expect(submitButton()!.disabled).toBe(false);
  });

  it("shows the price and billing cycle of the chosen tier before confirming", () => {
    renderDrawer();
    selectTier("tier_adult");
    // £65.00 and its recurrence must both be on screen before the desk commits
    // the member to a recurring charge.
    const text = document.body.textContent ?? "";
    expect(text).toContain("65.00");
    expect(text).toMatch(/month/i);
  });
});
