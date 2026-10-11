"use client";

/**
 * Payments lane PB (11 Oct 2026), audit F1 — an adult member subscribing
 * themselves and paying the first invoice in the app.
 *
 * POST /api/member/subscriptions/start existed, gated and tested, with no
 * caller. This is its caller: pick one of the club's adult plans, start the
 * subscription, then take the first payment with
 * components/billing/ConfirmSubscriptionPayment on the club's own Stripe
 * account. "Pay later" leaves it unpaid (pending, no access) and offers
 * Resume; an unpaid subscription found on load is offered the same.
 *
 * The page (app/member/membership/page.tsx) reads the plans and the member's
 * current state on the server; this component never claims a state the
 * server did not report (UI-RULES §7).
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import ConfirmSubscriptionPayment from "@/components/billing/ConfirmSubscriptionPayment";
import { paymentStatusLabel } from "@/lib/payment-status";
import { cycleLabel } from "@/lib/billing-cycle";

export type SelfSubscribePlan = {
  id: string;
  name: string;
  description: string | null;
  pricePence: number;
  currency: string;
  billingCycle: string;
  stripePriceId: string;
};

export type SelfSubscribeState =
  | { kind: "none" }
  | { kind: "unpaid"; subscriptionId: string }
  | { kind: "active"; membershipType: string | null; paymentStatus: string };

export interface SelfSubscribeCardProps {
  gymName: string;
  /** Club opted in to member self-billing AND has a connected Stripe account. */
  canSelfSubscribe: boolean;
  /** TeamUp (or another provider) bills this member: MatFlow must not start a second collection. */
  billedElsewhere: boolean;
  plans: SelfSubscribePlan[];
  state: SelfSubscribeState;
  /** Set when Stripe sent the member back here after a redirect-based payment. */
  returningSubscriptionId?: string | null;
}

function formatPrice(pence: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(pence / 100);
  } catch {
    return `${(pence / 100).toFixed(2)} ${currency}`;
  }
}

export default function SelfSubscribeCard({
  gymName,
  canSelfSubscribe,
  billedElsewhere,
  plans,
  state,
  returningSubscriptionId = null,
}: SelfSubscribeCardProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(returningSubscriptionId);
  const [returning, setReturning] = useState(!!returningSubscriptionId);
  const [setAside, setSetAside] = useState(false);
  const [paymentKey, setPaymentKey] = useState(0);
  const [paid, setPaid] = useState(false);
  const startingRef = useRef(false);
  // Stripe idempotency key for this subscribe intent: kept across retries of
  // the same plan, re-minted for a different plan.
  const requestIdRef = useRef<string | null>(null);
  const lastPlanRef = useRef<string | null>(null);

  const plan = plans.find((p) => p.id === selected) ?? null;

  async function start() {
    if (!plan || startingRef.current) return;
    startingRef.current = true;
    if (lastPlanRef.current !== plan.id || !requestIdRef.current) {
      requestIdRef.current = crypto.randomUUID();
      lastPlanRef.current = plan.id;
    }
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/member/subscriptions/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId: plan.stripePriceId, requestId: requestIdRef.current }),
      });
      const body = (await res.json().catch(() => ({}))) as { subscriptionId?: string; error?: string };
      if (!res.ok || !body.subscriptionId) {
        setError(body.error ?? "Couldn't start the membership. Nothing has been charged — please try again.");
        return;
      }
      setReturning(false);
      setSetAside(false);
      setPayingId(body.subscriptionId);
    } catch {
      setError(
        "We couldn't reach the gym's billing to confirm this. Reload the page before trying again — a membership may already have been started.",
      );
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }

  const card = "rounded-2xl border p-5 space-y-4";
  const cardStyle = { background: "var(--member-surface)", borderColor: "var(--member-border)" };

  if (paid) {
    return (
      <div className={card} style={cardStyle} role="status">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" style={{ color: "var(--member-success)" }} aria-hidden />
          <p className="text-sm" style={{ color: "var(--member-text)" }}>
            Payment received — your membership at {gymName} is active.
          </p>
        </div>
      </div>
    );
  }

  if (payingId) {
    return (
      <div className={card} style={cardStyle}>
        <h2 className="text-sm font-bold" style={{ color: "var(--member-text)" }}>
          First payment
        </h2>
        {setAside ? (
          <div className="space-y-3" role="status">
            <p className="text-sm" style={{ color: "var(--member-text-muted)" }}>
              The first payment has not been taken, so your membership is pending and isn&apos;t active yet. Resume
              when you&apos;re ready. If it stays unpaid for about 23 hours Stripe cancels the sign-up and nothing is
              charged.
            </p>
            <Button
              type="button"
              onClick={() => {
                setSetAside(false);
                setPaymentKey((k) => k + 1);
              }}
            >
              <CreditCard className="size-4" />
              Resume payment
            </Button>
          </div>
        ) : (
          <ConfirmSubscriptionPayment
            key={`${payingId}:${paymentKey}`}
            subscriptionId={payingId}
            returning={returning}
            onAbandon={() => {
              setReturning(false);
              setSetAside(true);
            }}
            onPaid={() => {
              setPaid(true);
              router.refresh();
            }}
          />
        )}
      </div>
    );
  }

  if (billedElsewhere) {
    return (
      <div className={card} style={cardStyle}>
        <p className="text-sm" style={{ color: "var(--member-text-muted)" }}>
          Your membership payments are handled outside this app. Speak to {gymName} to change them.
        </p>
      </div>
    );
  }

  if (state.kind === "active") {
    return (
      <div className={card} style={cardStyle}>
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" style={{ color: "var(--member-success)" }} aria-hidden />
          <p className="text-sm" style={{ color: "var(--member-text)" }}>
            You have a membership{state.membershipType ? ` — ${state.membershipType}` : ""}. Payment:{" "}
            {paymentStatusLabel(state.paymentStatus).toLowerCase()}.
          </p>
        </div>
      </div>
    );
  }

  if (state.kind === "unpaid") {
    return (
      <div className={card} style={cardStyle}>
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{ color: "var(--member-warning)" }} aria-hidden />
          <p className="text-sm" style={{ color: "var(--member-text)" }}>
            Your membership was started but the first payment has not been completed, so it isn&apos;t active yet.
          </p>
        </div>
        <Button
          type="button"
          size="mobile"
          onClick={() => {
            setSetAside(false);
            setPayingId(state.subscriptionId);
          }}
        >
          <CreditCard className="size-4" />
          Finish payment
        </Button>
      </div>
    );
  }

  if (!canSelfSubscribe) {
    return (
      <div className={card} style={cardStyle}>
        <p className="text-sm" style={{ color: "var(--member-text-muted)" }}>
          {gymName} sets up memberships at the desk. Speak to staff to start or change yours.
        </p>
      </div>
    );
  }

  if (plans.length === 0) {
    return (
      <div className={card} style={cardStyle}>
        <p className="text-sm" style={{ color: "var(--member-text-muted)" }}>
          {gymName} hasn&apos;t put any memberships online yet. Speak to staff to join.
        </p>
      </div>
    );
  }

  return (
    <div className={card} style={cardStyle}>
      <h2 className="text-sm font-bold" style={{ color: "var(--member-text)" }}>
        Choose a membership
      </h2>
      <div className="space-y-2" role="group" aria-label="Membership plans">
        {plans.map((p) => (
          <Button
            key={p.id}
            type="button"
            variant="secondary"
            aria-pressed={selected === p.id}
            onClick={() => setSelected(p.id)}
            className="h-auto w-full justify-between whitespace-normal py-3 text-left"
            style={selected === p.id ? { borderColor: "var(--color-primary)" } : undefined}
          >
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{p.name}</span>
              {p.description && <span className="block text-xs opacity-70">{p.description}</span>}
            </span>
            <span className="shrink-0 text-right text-sm font-semibold">
              {formatPrice(p.pricePence, p.currency)}
              <span className="block text-xs font-normal opacity-70">{cycleLabel(p.billingCycle)}</span>
            </span>
          </Button>
        ))}
      </div>
      {error && (
        <div role="alert" className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{ color: "var(--member-danger)" }} aria-hidden />
          <p className="text-sm" style={{ color: "var(--member-danger)" }}>
            {error}
          </p>
        </div>
      )}
      <p className="text-xs" style={{ color: "var(--member-text-muted)" }}>
        Next you pay the first {plan ? formatPrice(plan.pricePence, plan.currency) : "payment"} by card. Your
        membership goes active once Stripe confirms it and then renews automatically until you cancel.
      </p>
      <Button type="button" size="mobile" className="w-full" disabled={!plan} loading={starting} onClick={() => void start()}>
        {starting ? "Starting…" : "Continue to payment"}
      </Button>
    </div>
  );
}
