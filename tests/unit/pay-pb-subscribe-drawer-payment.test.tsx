// @vitest-environment jsdom
//
// Payments lane PB (11 Oct 2026), audit F1 — the staff drawer must TAKE the
// first payment, not announce a membership that nobody has paid for.
//
// Before: POST /api/stripe/create-subscription returned a PaymentIntent client
// secret, the drawer threw it away, toasted "Membership created" and closed.
// The subscription sat `incomplete` until Stripe expired it about 23 hours
// later. These pin the replacement behaviour:
//   - after the server creates the subscription the drawer stays open on a
//     payment step for THAT subscription, with no success toast
//   - success is announced only once MatFlow has recorded the payment
//   - closing the payment step (abandonment) says the payment was not taken
//     and offers Resume, which mounts the payment step again
//   - a member whose existing subscription is still unpaid gets "take the
//     first payment", not a second subscription
//   - a member with a live subscription is still refused a second one

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";

const { toastSpy, paymentMounts } = vi.hoisted(() => ({
  toastSpy: vi.fn(),
  paymentMounts: [] as Array<{ subscriptionId: string; onPaid?: (s: unknown) => void; onAbandon?: () => void }>,
}));

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

// Stripe.js cannot run in jsdom; the payment step itself has its own tests
// (pay-pb-confirm-subscription-payment.test.tsx). Here it is a probe that
// records which subscription it was asked to pay and exposes its callbacks.
vi.mock("@/components/billing/ConfirmSubscriptionPayment", () => ({
  default: (props: { subscriptionId: string; onPaid?: (s: unknown) => void; onAbandon?: () => void }) => {
    paymentMounts.push(props);
    return (
      <div data-testid="payment-step" data-subscription={props.subscriptionId}>
        <span>payment step</span>
        {props.onAbandon && (
          <span role="link" tabIndex={0} onClick={props.onAbandon}>
            probe-abandon
          </span>
        )}
        {props.onPaid && (
          <span
            role="link"
            tabIndex={0}
            onClick={() =>
              props.onPaid?.({
                subscription: { status: "active", ended: false, current: true, requiresAction: false },
                payment: { status: "succeeded", amountPence: 6500, currency: "GBP", paidAt: null, failureReason: null },
                billing: { paymentStatus: "paid" },
              })
            }
          >
            probe-paid
          </span>
        )}
      </div>
    );
  },
}));

import SubscribeDrawer from "@/components/dashboard/SubscribeDrawer";
import type { MembershipTierOption, TenantBilling } from "@/components/dashboard/MemberProfile";

const TIERS: MembershipTierOption[] = [
  { id: "tier_adult", name: "Adult Unlimited", pricePence: 6500, currency: "GBP", billingCycle: "monthly", stripePriceId: "price_adult_unlimited" },
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

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });

function stubCreateFlow() {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === "/api/stripe/create-subscription") return ok({ subscriptionId: "sub_new_1", clientSecret: "pi_1_secret_x" });
    return ok({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function startMembership() {
  fireEvent.change(screen.getByLabelText(/membership tier/i), { target: { value: "tier_adult" } });
  fireEvent.click(document.querySelector("button[type='submit']") as HTMLButtonElement);
}

describe("pay-pb: SubscribeDrawer takes the first payment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    toastSpy.mockReset();
    paymentMounts.length = 0;
  });

  it("moves to a payment step for the created subscription instead of announcing success", async () => {
    const fetchMock = stubCreateFlow();
    const { onClose, onSubscribed } = renderDrawer();
    await startMembership();

    const step = await screen.findByTestId("payment-step");
    expect(step.getAttribute("data-subscription")).toBe("sub_new_1");
    expect(onSubscribed).toHaveBeenCalledWith("sub_new_1");
    // Nothing has been paid: no success toast, and the drawer stays open.
    expect(toastSpy.mock.calls.filter((c) => c[1] === "success")).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    // RP-2: no tier (or anything else) is written to the member before payment.
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/members/"))).toEqual([]);
  });

  it("announces success only after MatFlow has recorded the payment", async () => {
    stubCreateFlow();
    renderDrawer();
    await startMembership();
    await screen.findByTestId("payment-step");
    expect(toastSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("probe-paid"));
    await waitFor(() => expect(toastSpy.mock.calls.some((c) => c[1] === "success")).toBe(true));
  });

  it("abandonment: closing the payment step says nothing was taken and Resume mounts it again", async () => {
    stubCreateFlow();
    renderDrawer();
    await startMembership();
    await screen.findByTestId("payment-step");
    const mountsBefore = paymentMounts.length;

    fireEvent.click(screen.getByText("probe-abandon"));
    // The step is gone, the state is named, and nothing claims success.
    await waitFor(() => expect(screen.queryByTestId("payment-step")).toBeNull());
    expect(document.body.textContent ?? "").toMatch(/not (been )?(completed|taken)/i);
    expect(document.body.textContent ?? "").toMatch(/no access until the first payment is received/i);
    expect(toastSpy.mock.calls.filter((c) => c[1] === "success")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: /resume/i }));
    const again = await screen.findByTestId("payment-step");
    expect(again.getAttribute("data-subscription")).toBe("sub_new_1");
    expect(paymentMounts.length).toBeGreaterThan(mountsBefore);
  });

  it("an existing UNPAID subscription is offered its first payment, never a second subscription", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/api/stripe/subscriptions/sub_unpaid/status")) {
        return ok({
          subscription: { status: "incomplete", ended: false, current: true, requiresAction: false },
          payment: null,
          billing: { paymentStatus: "pending" },
        });
      }
      return ok({});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDrawer({ existingSubscriptionId: "sub_unpaid" });
    const resume = await screen.findByRole("button", { name: /first payment|resume/i });
    // No tier picker: a second subscription is not on offer.
    expect(screen.queryByLabelText(/membership tier/i)).toBeNull();
    fireEvent.click(resume);
    const step = await screen.findByTestId("payment-step");
    expect(step.getAttribute("data-subscription")).toBe("sub_unpaid");
    expect(fetchMock.mock.calls.some((c) => c[0] === "/api/stripe/create-subscription")).toBe(false);
  });

  it("an existing LIVE subscription is still refused a second one and offered no payment", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/api/stripe/subscriptions/sub_live/status")) {
        return ok({
          subscription: { status: "active", ended: false, current: true, requiresAction: false },
          payment: { status: "succeeded", amountPence: 6500, currency: "GBP", paidAt: null, failureReason: null },
          billing: { paymentStatus: "paid" },
        });
      }
      return ok({});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDrawer({ existingSubscriptionId: "sub_live" });
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByLabelText(/membership tier/i)).toBeNull();
    expect(screen.queryByTestId("payment-step")).toBeNull();
    expect(screen.queryByRole("button", { name: /first payment|resume/i })).toBeNull();
    expect((document.querySelector("button[type='submit']") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a status read that fails is an error, not a silent 'already subscribed'", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    renderDrawer({ existingSubscriptionId: "sub_unknown" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn.t/i);
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });
});
