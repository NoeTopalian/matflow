// @vitest-environment jsdom
//
// Payments lane PB (11 Oct 2026), audit F1 — a guardian who subscribes a child
// must be able to pay the first invoice in the app.
//
// Before: POST /api/member/subscriptions/start-for-kid returned the client
// secret; KidBillingCard discarded it and told the parent "Payment hasn't been
// taken yet — speak to gym staff". Nothing staff could open would take it, so
// the subscription expired unpaid. These pin:
//   - after the start succeeds, the card shows the payment step for THAT
//     subscription and never sends the parent to staff
//   - "Pay later" leaves it pending, says so, and Resume brings the step back
//   - a child already pending with a known subscription id is offered Resume
//   - a refused start shows the server's message and no payment step

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const { mounts } = vi.hoisted(() => ({
  mounts: [] as Array<{ subscriptionId: string; onPaid?: (s: unknown) => void; onAbandon?: () => void }>,
}));

vi.mock("@/components/billing/ConfirmSubscriptionPayment", () => ({
  default: (props: { subscriptionId: string; onPaid?: (s: unknown) => void; onAbandon?: () => void }) => {
    mounts.push(props);
    return (
      <div data-testid="payment-step" data-subscription={props.subscriptionId}>
        {props.onAbandon && (
          <span role="link" tabIndex={0} onClick={props.onAbandon}>
            probe-abandon
          </span>
        )}
        <span
          role="link"
          tabIndex={0}
          onClick={() =>
            props.onPaid?.({
              subscription: { status: "active", ended: false, current: true, requiresAction: false },
              payment: { status: "succeeded", amountPence: 3000, currency: "GBP", paidAt: null, failureReason: null },
              billing: { paymentStatus: "paid" },
            })
          }
        >
          probe-paid
        </span>
      </div>
    );
  },
}));

import { KidBillingCard } from "@/components/member/KidBillingCard";

type Kid = { subscriptionState: "none" | "pending" | "active"; paymentStatus: string; stripeSubscriptionId?: string | null };

function billing(kid: Kid) {
  return {
    tenant: { selfBillingEnabled: true, stripeConnected: true, currency: "GBP" },
    kid: { id: "kid_1", name: "Mia", membershipType: null, ...kid },
    plans: [
      { id: "tier_kids", name: "Kids Monthly", description: null, pricePence: 3000, currency: "GBP", billingCycle: "monthly", stripePriceId: "price_kids" },
    ],
    payments: [],
  };
}

const res = (status: number, body: unknown) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });

function stub(kid: Kid, start: { status: number; body: unknown } = { status: 201, body: { subscriptionId: "sub_kid_1", clientSecret: "pi_k_secret_x" } }) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === "/api/member/family/kid_1/billing") return res(200, billing(kid));
    if (url === "/api/member/subscriptions/start-for-kid") return res(start.status, start.body);
    return res(200, {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function subscribe() {
  fireEvent.click(await screen.findByText("Kids Monthly"));
  fireEvent.click(screen.getByRole("button", { name: /subscribe/i }));
}

describe("pay-pb: KidBillingCard takes the first payment", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mounts.length = 0;
  });

  it("after subscribing, shows the payment step for the new subscription and never sends the parent to staff", async () => {
    const fetchMock = stub({ subscriptionState: "none", paymentStatus: "pending" });
    render(<KidBillingCard childId="kid_1" primaryColor="#4f46e5" />);
    await subscribe();

    const step = await screen.findByTestId("payment-step");
    expect(step.getAttribute("data-subscription")).toBe("sub_kid_1");
    const startCall = fetchMock.mock.calls.find((c) => c[0] === "/api/member/subscriptions/start-for-kid");
    expect(JSON.parse(startCall![1].body)).toMatchObject({ kidMemberId: "kid_1", priceId: "price_kids" });
    expect(document.body.textContent ?? "").not.toMatch(/speak to (gym )?staff/i);
  });

  it("Pay later leaves it pending and Resume brings the payment step back for the same subscription", async () => {
    stub({ subscriptionState: "none", paymentStatus: "pending" });
    render(<KidBillingCard childId="kid_1" primaryColor="#4f46e5" />);
    await subscribe();
    await screen.findByTestId("payment-step");

    fireEvent.click(screen.getByText("probe-abandon"));
    await waitFor(() => expect(screen.queryByTestId("payment-step")).toBeNull());
    expect(document.body.textContent ?? "").toMatch(/not (been )?(completed|taken)/i);

    fireEvent.click(screen.getByRole("button", { name: /resume|finish payment/i }));
    const again = await screen.findByTestId("payment-step");
    expect(again.getAttribute("data-subscription")).toBe("sub_kid_1");
  });

  it("a child already pending with a known subscription is offered Resume, not a trip to staff", async () => {
    stub({ subscriptionState: "pending", paymentStatus: "pending", stripeSubscriptionId: "sub_kid_pending" });
    render(<KidBillingCard childId="kid_1" primaryColor="#4f46e5" />);
    const resume = await screen.findByRole("button", { name: /resume|finish payment/i });
    expect(document.body.textContent ?? "").not.toMatch(/speak to the gym to finish/i);
    fireEvent.click(resume);
    const step = await screen.findByTestId("payment-step");
    expect(step.getAttribute("data-subscription")).toBe("sub_kid_pending");
  });

  it("a refused start shows the server's own message and no payment step", async () => {
    stub({ subscriptionState: "none", paymentStatus: "pending" }, { status: 409, body: { error: "Mia already has an active membership." } });
    render(<KidBillingCard childId="kid_1" primaryColor="#4f46e5" />);
    await subscribe();
    await waitFor(() => expect(document.body.textContent ?? "").toContain("Mia already has an active membership."));
    expect(screen.queryByTestId("payment-step")).toBeNull();
  });

  it("once MatFlow records the payment the card reloads the child's billing", async () => {
    const fetchMock = stub({ subscriptionState: "none", paymentStatus: "pending" });
    render(<KidBillingCard childId="kid_1" primaryColor="#4f46e5" />);
    await subscribe();
    await screen.findByTestId("payment-step");
    const loadsBefore = fetchMock.mock.calls.filter((c) => c[0] === "/api/member/family/kid_1/billing").length;
    fireEvent.click(screen.getByText("probe-paid"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/member/family/kid_1/billing").length).toBeGreaterThan(loadsBefore),
    );
  });
});
