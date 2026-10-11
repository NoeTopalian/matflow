"use client";

/**
 * Payments lane PB (11 Oct 2026), audit F1 — the step that actually takes the
 * first payment of a membership.
 *
 * MatFlow creates subscriptions with `payment_behavior: "default_incomplete"`:
 * Stripe raises the first invoice and waits for the payer to confirm its
 * PaymentIntent. Until this component existed nothing in the product did that,
 * so every in-app subscription expired unpaid after about 23 hours.
 *
 * How it works:
 *  1. GET /api/stripe/subscriptions/[id]/confirmation — the client secret and
 *     the club's connected account id. Direct charges on a connected account
 *     REQUIRE Stripe.js to be loaded with `{ stripeAccount }`.
 *  2. Stripe's Payment Element collects the card; `confirmPayment` with
 *     `redirect: "if_required"` runs 3-D Secure in Stripe's own modal and
 *     only leaves the page for a redirect-based method (return_url).
 *  3. A decline shows Stripe's message and the payer tries again on the SAME
 *     PaymentIntent (Stripe allows re-confirmation).
 *  4. Once Stripe reports success, GET /api/stripe/subscriptions/[id]/status is
 *     polled until MatFlow has recorded the payment from Stripe's webhook.
 *
 * Nothing here grants access or writes a member: entitlement follows the
 * webhook (lane PC). Closing the form leaves the subscription unpaid
 * (`incomplete` at Stripe, `pending` in MatFlow); the parent surface offers
 * Resume, which mounts this component again and re-reads the secret.
 *
 * Honesty rules (UI-RULES §7): a confirmed card is not called "active" until
 * MatFlow has the payment; an HTTP error is an error, never an empty form.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { loadStripe, type Stripe, type StripeElements } from "@stripe/stripe-js";
import { AlertTriangle, CheckCircle2, Clock, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

export type SubscriptionPaymentStatus = {
  subscription: { status: string; ended: boolean; current: boolean; requiresAction: boolean };
  payment: {
    status: string;
    amountPence: number;
    currency: string;
    paidAt: string | null;
    failureReason: string | null;
  } | null;
  billing: { paymentStatus: string | null };
};

type ConfirmationBody = {
  state?: "requires_payment" | "already_paid" | "ended" | "not_payable";
  clientSecret?: string;
  stripeAccount?: string;
  invoiceId?: string | null;
  amountDue?: number | null;
  currency?: string | null;
  error?: string;
};

type Stage =
  | "loading" // fetching the secret / mounting the Payment Element
  | "entry" // form ready, waiting for the payer
  | "submitting" // confirmPayment in flight (3-D Secure modal may be open)
  | "recording" // Stripe confirmed; waiting for MatFlow to record it
  | "paid" // MatFlow has the payment
  | "processing" // Stripe accepted it but the money has not cleared (e.g. Direct Debit)
  | "unrecorded" // Stripe confirmed, MatFlow has not heard yet after polling
  | "ended" // the sign-up expired; a new one has to be started
  | "unavailable" // the server refused (no secret)
  | "load_error"; // network / HTTP failure loading the form

/** One Stripe.js instance per connected account for the page's lifetime. */
const stripeByAccount = new Map<string, Promise<Stripe | null>>();
function stripeFor(publishableKey: string, stripeAccount: string): Promise<Stripe | null> {
  let p = stripeByAccount.get(stripeAccount);
  if (!p) {
    p = loadStripe(publishableKey, { stripeAccount });
    stripeByAccount.set(stripeAccount, p);
  }
  return p;
}

function formatAmount(pence: number | null | undefined, currency: string | null | undefined): string | null {
  if (typeof pence !== "number" || !currency) return null;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(pence / 100);
  } catch {
    return null;
  }
}

/** Stripe's Elements iframe cannot read CSS variables: hand it the resolved token values. */
function appearanceFrom(el: HTMLElement | null) {
  if (!el || typeof window === "undefined") return undefined;
  const css = window.getComputedStyle(el);
  const pick = (name: string) => {
    const v = css.getPropertyValue(name).trim();
    return v && !v.startsWith("var(") ? v : undefined;
  };
  const variables: Record<string, string> = {};
  const text = pick("--tx-1");
  const background = pick("--sf-1");
  const primary = pick("--color-primary");
  if (text) variables.colorText = text;
  if (background) variables.colorBackground = background;
  if (primary) variables.colorPrimary = primary;
  return { theme: "stripe" as const, variables };
}

export interface ConfirmSubscriptionPaymentProps {
  /** The Stripe subscription id MatFlow mapped when the membership was started. */
  subscriptionId: string;
  /** Whose membership this pays for, for the copy ("Sam's first payment"). */
  payerLabel?: string;
  /** Fired once MatFlow has recorded the first payment. */
  onPaid?: (status: SubscriptionPaymentStatus) => void;
  /** Shown as a "Pay later" control; the subscription stays unpaid and can be resumed. */
  onAbandon?: () => void;
  /** Start in the recording stage (returning from a redirect-based method). */
  returning?: boolean;
  /** Test seams. */
  pollIntervalMs?: number;
  pollAttempts?: number;
}

export default function ConfirmSubscriptionPayment({
  subscriptionId,
  payerLabel,
  onPaid,
  onAbandon,
  returning = false,
  pollIntervalMs = 2000,
  pollAttempts = 20,
}: ConfirmSubscriptionPaymentProps) {
  const [stage, setStage] = useState<Stage>(returning ? "recording" : "loading");
  const [message, setMessage] = useState<string | null>(null);
  const [declined, setDeclined] = useState<string | null>(null);
  const [amount, setAmount] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stripeRef = useRef<Stripe | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const invoiceRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const alive = useRef(true);
  const onPaidRef = useRef(onPaid);

  useEffect(() => {
    onPaidRef.current = onPaid;
  }, [onPaid]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const pollStatus = useCallback(async () => {
    setStage((s) => (s === "processing" ? s : "recording"));
    const q = invoiceRef.current ? `?invoice=${encodeURIComponent(invoiceRef.current)}` : "";
    for (let i = 0; i < pollAttempts; i += 1) {
      if (!alive.current) return;
      try {
        const res = await fetch(`/api/stripe/subscriptions/${encodeURIComponent(subscriptionId)}/status${q}`, {
          cache: "no-store",
        });
        if (res.ok) {
          const status = (await res.json()) as SubscriptionPaymentStatus;
          if (status.subscription.status === "active" && status.payment?.status === "succeeded") {
            if (!alive.current) return;
            setStage("paid");
            onPaidRef.current?.(status);
            return;
          }
        }
      } catch {
        // A failed poll is not a failed payment: keep polling, then say we have not heard.
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    if (alive.current) setStage((s) => (s === "processing" ? s : "unrecorded"));
  }, [subscriptionId, pollAttempts, pollIntervalMs]);

  const load = useCallback(async () => {
    setStage("loading");
    setMessage(null);
    setDeclined(null);
    elementsRef.current = null;

    const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey) {
      setStage("unavailable");
      setMessage("Card payments aren't available in this app yet. Please speak to the gym.");
      return;
    }

    let body: ConfirmationBody;
    let res: Response;
    try {
      res = await fetch(`/api/stripe/subscriptions/${encodeURIComponent(subscriptionId)}/confirmation`, {
        cache: "no-store",
      });
      body = (await res.json().catch(() => ({}))) as ConfirmationBody;
    } catch {
      if (!alive.current) return;
      setStage("load_error");
      setMessage("Couldn't reach MatFlow to load the payment form. Check your connection and try again.");
      return;
    }
    if (!alive.current) return;

    if (res.status === 409 && body.state === "already_paid") {
      // Stripe already has the payment (e.g. paid in another tab): wait for MatFlow to record it.
      void pollStatus();
      return;
    }
    if (res.status === 409 && body.state === "ended") {
      setStage("ended");
      setMessage(body.error ?? "This sign-up expired before it was paid. Start the membership again.");
      return;
    }
    if (!res.ok || body.state !== "requires_payment" || !body.clientSecret || !body.stripeAccount) {
      setStage(res.status === 409 || res.status === 404 ? "unavailable" : "load_error");
      setMessage(body.error ?? "Couldn't load the payment form. Please try again.");
      return;
    }

    invoiceRef.current = body.invoiceId ?? null;
    setAmount(formatAmount(body.amountDue, body.currency));

    const stripe = await stripeFor(publishableKey, body.stripeAccount).catch(() => null);
    if (!alive.current) return;
    if (!stripe) {
      setStage("load_error");
      setMessage("Couldn't load Stripe's secure payment form. Check your connection and try again.");
      return;
    }
    stripeRef.current = stripe;
    const elements = stripe.elements({ clientSecret: body.clientSecret, appearance: appearanceFrom(rootRef.current) });
    elementsRef.current = elements;
    const paymentElement = elements.create("payment", { layout: "tabs" });
    if (containerRef.current) {
      containerRef.current.replaceChildren();
      paymentElement.mount(containerRef.current);
    }
    setStage("entry");
  }, [subscriptionId, pollStatus]);

  useEffect(() => {
    if (returning) {
      void pollStatus();
      return;
    }
    void load();
  }, [returning, load, pollStatus]);

  async function pay() {
    const stripe = stripeRef.current;
    const elements = elementsRef.current;
    if (!stripe || !elements || submittingRef.current) return;
    submittingRef.current = true;
    setStage("submitting");
    setDeclined(null);
    try {
      const { error: submitError } = await elements.submit();
      if (submitError) {
        setDeclined(submitError.message ?? "Check the card details and try again.");
        setStage("entry");
        return;
      }
      const returnUrl = new URL(window.location.href);
      returnUrl.searchParams.set("subscriptionPayment", subscriptionId);
      const result = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl.toString() },
        redirect: "if_required",
      });
      if (!alive.current) return;
      if (result.error) {
        // card_error and validation_error carry a message written for the
        // payer ("Your card was declined."); anything else is ours to word.
        const e = result.error;
        setDeclined(
          (e.type === "card_error" || e.type === "validation_error") && e.message
            ? e.message
            : "The payment didn't go through and nothing was taken. Please try again.",
        );
        setStage("entry");
        return;
      }
      const pi = result.paymentIntent;
      if (pi?.status === "succeeded") {
        void pollStatus();
      } else if (pi?.status === "processing") {
        setStage("processing");
        void pollStatus();
      } else {
        setDeclined("The payment wasn't completed and nothing was taken. Please try again or use another card.");
        setStage("entry");
      }
    } catch {
      if (!alive.current) return;
      setDeclined("We couldn't confirm the payment. Nothing new has been taken — check your connection and try again.");
      setStage("entry");
    } finally {
      submittingRef.current = false;
    }
  }

  const who = payerLabel ? `${payerLabel}'s` : "the";
  const formVisible = stage === "loading" || stage === "entry" || stage === "submitting";

  return (
    <div ref={rootRef} className="space-y-4" data-testid="confirm-subscription-payment" data-stage={stage}>
      {formVisible && (
        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <Lock className="mt-0.5 size-4 shrink-0 text-tx-3" aria-hidden />
            <p className="text-sm text-tx-2">
              {amount ? `Pay ${amount} now for ${who} first payment.` : `Enter card details to take ${who} first payment.`}{" "}
              The card is handled by Stripe on the club&apos;s account.
            </p>
          </div>
          {stage === "loading" && (
            <p className="text-sm text-tx-3" role="status">
              Loading the secure payment form…
            </p>
          )}
          {/* Stripe mounts its iframe here; kept mounted across a decline so the retry reuses it. */}
          <div ref={containerRef} data-testid="payment-element" />
          {declined && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-[var(--r-md)] border border-bd-default p-3"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--member-danger,var(--hue-danger-ink))]" aria-hidden />
              <p className="text-sm text-[var(--member-danger,var(--hue-danger-ink))]">{declined}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void pay()} disabled={stage !== "entry"} loading={stage === "submitting"}>
              {stage === "submitting" ? "Confirming…" : declined ? "Try again" : amount ? `Pay ${amount}` : "Pay now"}
            </Button>
            {onAbandon && (
              <Button type="button" variant="ghost" onClick={onAbandon} disabled={stage === "submitting"}>
                Pay later
              </Button>
            )}
          </div>
        </div>
      )}

      {(stage === "recording" || stage === "processing") && (
        <div role="status" className="flex items-start gap-2">
          <Clock className="mt-0.5 size-4 shrink-0 text-tx-3" aria-hidden />
          <p className="text-sm text-tx-2">
            {stage === "processing"
              ? "Stripe has accepted the payment and it is being processed. The membership goes live once it clears — this can take a few days for Direct Debit."
              : "Stripe has confirmed the payment. Waiting for MatFlow to record it…"}
          </p>
        </div>
      )}

      {stage === "paid" && (
        <div role="status" className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--member-success,var(--hue-success-ink))]" aria-hidden />
          <p className="text-sm text-tx-1">Payment received. The membership is active.</p>
        </div>
      )}

      {stage === "unrecorded" && (
        <div role="status" className="space-y-2">
          <div className="flex items-start gap-2">
            <Clock className="mt-0.5 size-4 shrink-0 text-tx-3" aria-hidden />
            <p className="text-sm text-tx-2">
              Stripe has confirmed the payment, but MatFlow hasn&apos;t received Stripe&apos;s confirmation yet, so
              the membership still shows as pending. It updates by itself, usually within a minute. Don&apos;t pay
              again.
            </p>
          </div>
          <Button type="button" variant="secondary" onClick={() => void pollStatus()}>
            Check again
          </Button>
        </div>
      )}

      {(stage === "ended" || stage === "unavailable" || stage === "load_error") && (
        <div role="alert" className="space-y-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--member-danger,var(--hue-danger-ink))]" aria-hidden />
            <p className="text-sm text-tx-1">{message}</p>
          </div>
          {stage === "load_error" && (
            <Button type="button" variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
