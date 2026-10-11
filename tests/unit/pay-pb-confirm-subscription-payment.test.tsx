// @vitest-environment jsdom
//
// Payments lane PB (11 Oct 2026), audit F1 — the payment step itself.
//
// Stripe.js is replaced by a recording fake with the same surface
// (loadStripe → elements → create("payment").mount → submit → confirmPayment).
// The real Stripe.js runs in the browser journeys
// (tests/e2e/campaign/pay-pb-*.spec.ts). Pinned:
//   - Stripe.js is loaded with { stripeAccount } — a direct charge on the
//     club's connected account cannot be confirmed without it
//   - confirmPayment uses redirect "if_required" and a return_url
//   - authentication (3-D Secure) happens inside confirmPayment; success after
//     it is handled like any success
//   - a decline shows Stripe's own message and the retry confirms AGAIN on the
//     same Elements / PaymentIntent (no second subscription, no new secret)
//   - success is "paid" only once MatFlow's status shows the mapping active
//     AND the Payment succeeded; until then it says it is waiting
//   - an expired sign-up, a refusal and an HTTP error are stated, never an
//     empty form; "Pay later" calls onAbandon

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const s = vi.hoisted(() => ({
  loadStripe: vi.fn(),
  elementsCalls: [] as unknown[],
  mount: vi.fn(),
  submit: vi.fn(),
  confirmPayment: vi.fn(),
}));

vi.mock("@stripe/stripe-js", () => ({ loadStripe: s.loadStripe }));

import ConfirmSubscriptionPayment from "@/components/billing/ConfirmSubscriptionPayment";

const SUB = "sub_pb_comp";
const ACCT = "acct_pb_club";

function fakeStripe() {
  const elements = {
    create: vi.fn(() => ({ mount: s.mount })),
    submit: s.submit,
  };
  return {
    elements: vi.fn((opts: unknown) => {
      s.elementsCalls.push(opts);
      return elements;
    }),
    confirmPayment: s.confirmPayment,
  };
}

const json = (status: number, body: unknown) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const READY = { state: "requires_payment", clientSecret: "pi_comp_secret_1", stripeAccount: ACCT, invoiceId: "in_comp_1", amountDue: 6500, currency: "GBP" };
const RECORDED = {
  subscription: { status: "active", ended: false, current: true, requiresAction: false },
  payment: { status: "succeeded", amountPence: 6500, currency: "GBP", paidAt: null, failureReason: null },
  billing: { paymentStatus: "paid" },
};
const NOT_YET = { subscription: { status: "incomplete", ended: false, current: true, requiresAction: false }, payment: null, billing: { paymentStatus: "pending" } };

function stubFetch(confirmation: { status: number; body: unknown }, statuses: unknown[] = [RECORDED]) {
  let i = 0;
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes("/confirmation")) return json(confirmation.status, confirmation.body);
    if (url.includes("/status")) {
      const body = statuses[Math.min(i, statuses.length - 1)];
      i += 1;
      return json(200, body);
    }
    return json(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "pk_test_pb_fixture");
  s.loadStripe.mockReset();
  s.mount.mockReset();
  s.submit.mockReset();
  s.confirmPayment.mockReset();
  s.elementsCalls.length = 0;
  s.loadStripe.mockImplementation(async () => fakeStripe());
  s.submit.mockResolvedValue({});
});

async function ready() {
  await waitFor(() => expect(screen.getByTestId("confirm-subscription-payment").getAttribute("data-stage")).toBe("entry"));
}

describe("pay-pb: ConfirmSubscriptionPayment", () => {
  it("loads Stripe.js for the club's connected account and mounts the Payment Element with the secret", async () => {
    // A distinct account per test: the component caches one Stripe.js per account.
    const body = { ...READY, stripeAccount: "acct_pb_load" };
    stubFetch({ status: 200, body });
    render(<ConfirmSubscriptionPayment subscriptionId={SUB} />);
    await ready();
    expect(s.loadStripe).toHaveBeenCalledWith("pk_test_pb_fixture", { stripeAccount: "acct_pb_load" });
    expect(s.elementsCalls[0]).toMatchObject({ clientSecret: "pi_comp_secret_1" });
    expect(s.mount).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("£65.00");
  });

  it("success: confirms with redirect if_required, then waits for MatFlow before calling it paid", async () => {
    stubFetch({ status: 200, body: { ...READY, stripeAccount: "acct_pb_ok" } }, [NOT_YET, NOT_YET, RECORDED]);
    s.confirmPayment.mockResolvedValue({ paymentIntent: { status: "succeeded" } });
    const onPaid = vi.fn();
    render(<ConfirmSubscriptionPayment subscriptionId={SUB} onPaid={onPaid} pollIntervalMs={1} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /pay/i }));

    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
    const args = s.confirmPayment.mock.calls[0][0];
    expect(args.redirect).toBe("if_required");
    expect(args.confirmParams.return_url).toContain(`subscriptionPayment=${SUB}`);
    expect(onPaid.mock.calls[0][0]).toEqual(RECORDED);
    expect(screen.getByTestId("confirm-subscription-payment").getAttribute("data-stage")).toBe("paid");
  });

  it("3-D Secure: authentication happens inside confirmPayment and success afterwards is handled the same", async () => {
    stubFetch({ status: 200, body: { ...READY, stripeAccount: "acct_pb_3ds" } });
    // Stripe.js resolves confirmPayment only after the challenge modal closes.
    s.confirmPayment.mockImplementation(
      () => new Promise((r) => setTimeout(() => r({ paymentIntent: { status: "succeeded" } }), 5)),
    );
    const onPaid = vi.fn();
    render(<ConfirmSubscriptionPayment subscriptionId={SUB} onPaid={onPaid} pollIntervalMs={1} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /pay/i }));
    expect(screen.getByTestId("confirm-subscription-payment").getAttribute("data-stage")).toBe("submitting");
    await waitFor(() => expect(onPaid).toHaveBeenCalled());
  });

  it("decline: shows Stripe's message and retries on the SAME Elements and PaymentIntent", async () => {
    const fetchMock = stubFetch({ status: 200, body: { ...READY, stripeAccount: "acct_pb_decline" } });
    s.confirmPayment
      .mockResolvedValueOnce({ error: { type: "card_error", code: "card_declined", message: "Your card was declined." } })
      .mockResolvedValueOnce({ paymentIntent: { status: "succeeded" } });
    const onPaid = vi.fn();
    render(<ConfirmSubscriptionPayment subscriptionId={SUB} onPaid={onPaid} pollIntervalMs={1} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /pay/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your card was declined.");
    expect(onPaid).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(onPaid).toHaveBeenCalled());
    // Same Elements object both times; the secret was fetched once.
    expect(s.confirmPayment).toHaveBeenCalledTimes(2);
    expect(s.confirmPayment.mock.calls[0][0].elements).toBe(s.confirmPayment.mock.calls[1][0].elements);
    expect(s.elementsCalls).toHaveLength(1);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/confirmation"))).toHaveLength(1);
  });

  it("an error that is not the payer's to read gets our wording, not Stripe internals", async () => {
    stubFetch({ status: 200, body: { ...READY, stripeAccount: "acct_pb_apierr" } });
    s.confirmPayment.mockResolvedValue({ error: { type: "api_error", message: "Internal: req_abc failed" } });
    render(<ConfirmSubscriptionPayment subscriptionId={SUB} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /pay/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("req_abc");
    expect(alert.textContent).toMatch(/nothing was taken/i);
  });

  it("Stripe confirmed but MatFlow has not recorded it: says so, does not call it paid, offers Check again", async () => {
    stubFetch({ status: 200, body: { ...READY, stripeAccount: "acct_pb_slow" } }, [NOT_YET]);
    s.confirmPayment.mockResolvedValue({ paymentIntent: { status: "succeeded" } });
    const onPaid = vi.fn();
    render(<ConfirmSubscriptionPayment subscriptionId={SUB} onPaid={onPaid} pollIntervalMs={1} pollAttempts={3} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /pay/i }));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-subscription-payment").getAttribute("data-stage")).toBe("unrecorded"),
    );
    expect(onPaid).not.toHaveBeenCalled();
    expect(document.body.textContent).toMatch(/don.t pay again/i);
    expect(screen.getByRole("button", { name: /check again/i })).toBeTruthy();
  });

  it("processing (e.g. Direct Debit) is not called paid", async () => {
    stubFetch({ status: 200, body: { ...READY, stripeAccount: "acct_pb_proc" } }, [NOT_YET]);
    s.confirmPayment.mockResolvedValue({ paymentIntent: { status: "processing" } });
    const onPaid = vi.fn();
    render(<ConfirmSubscriptionPayment subscriptionId={SUB} onPaid={onPaid} pollIntervalMs={1} pollAttempts={2} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /pay/i }));
    await waitFor(() => expect(document.body.textContent).toMatch(/being processed/i));
    expect(onPaid).not.toHaveBeenCalled();
  });

  it("an expired sign-up is stated and Stripe.js is never loaded", async () => {
    stubFetch({ status: 409, body: { state: "ended", error: "This sign-up expired before the first payment was made." } });
    render(<ConfirmSubscriptionPayment subscriptionId={SUB} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("expired");
    expect(s.loadStripe).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /pay/i })).toBeNull();
  });

  it("an HTTP error is an error with a retry, never an empty form", async () => {
    const fetchMock = stubFetch({ status: 503, body: { error: "We can't take payments for this gym just now." } });
    render(<ConfirmSubscriptionPayment subscriptionId={SUB} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("can't take payments");
    expect(s.loadStripe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/confirmation"))).toHaveLength(2));
  });

  it("already paid elsewhere: goes straight to waiting for MatFlow's record", async () => {
    stubFetch({ status: 409, body: { state: "already_paid", subscriptionStatus: "active" } }, [RECORDED]);
    const onPaid = vi.fn();
    render(<ConfirmSubscriptionPayment subscriptionId={SUB} onPaid={onPaid} pollIntervalMs={1} />);
    await waitFor(() => expect(onPaid).toHaveBeenCalled());
    expect(s.loadStripe).not.toHaveBeenCalled();
  });

  it("without a publishable key it says card payments are unavailable and calls nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "");
    const fetchMock = stubFetch({ status: 200, body: READY });
    render(<ConfirmSubscriptionPayment subscriptionId={SUB} />);
    await screen.findByRole("alert");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.loadStripe).not.toHaveBeenCalled();
  });

  it("Pay later calls onAbandon and confirms nothing", async () => {
    stubFetch({ status: 200, body: { ...READY, stripeAccount: "acct_pb_later" } });
    const onAbandon = vi.fn();
    render(<ConfirmSubscriptionPayment subscriptionId={SUB} onAbandon={onAbandon} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /pay later/i }));
    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(s.confirmPayment).not.toHaveBeenCalled();
  });
});
