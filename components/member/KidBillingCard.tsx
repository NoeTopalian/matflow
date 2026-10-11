"use client";

// B5 — parent-side kid billing surface.
//
// Drops onto /member/family/[id]. Fetches GET /api/member/family/[id]/billing
// to learn whether self-billing is enabled, what kid-eligible plans the
// owner has set up, and the kid's current subscription status. Drives:
//   - A plan picker + "Subscribe" button (calls POST .../subscriptions/
//     start-for-kid) when the kid has no active subscription
//   - A "Manage card" button (calls POST .../billing/portal, redirects to
//     Stripe Customer Portal) when there's an active subscription
//   - A "Cancel" button (calls POST .../subscriptions/cancel-for-kid) for
//     end-of-cycle cancellation
//
// When the owner hasn't enabled member-side billing the card surfaces a
// short explainer pointing the parent at gym staff — never silently
// hidden, so the parent isn't left wondering whether the feature exists.
//
// Payments lane PB (11 Oct 2026, audit F1): Subscribe now goes straight on to
// take the first payment in the app (components/billing/
// ConfirmSubscriptionPayment, on the club's own Stripe account). Before, the
// card discarded the client secret and sent the parent to staff, who had no
// screen that could take it, so the subscription expired unpaid. "Pay later"
// leaves it pending and offers Resume.

import { useEffect, useRef, useState } from "react";
import { CreditCard, Loader2, AlertTriangle, ExternalLink, Check } from "lucide-react";
import { paymentStatusLabel } from "@/lib/payment-status";
import { Button } from "@/components/ui/button";
import ConfirmSubscriptionPayment from "@/components/billing/ConfirmSubscriptionPayment";

type BillingData = {
  tenant: {
    selfBillingEnabled: boolean;
    stripeConnected: boolean;
    currency: string;
  };
  kid: {
    id: string;
    name: string;
    membershipType: string | null;
    paymentStatus: string;
    subscriptionState: "none" | "pending" | "active";
    /**
     * The child's current Stripe subscription id, when the billing read
     * supplies it (requested from the route owner by lane PB). Needed to
     * resume an unpaid first payment after a reload.
     */
    stripeSubscriptionId?: string | null;
  };
  plans: Array<{
    id: string;
    name: string;
    description: string | null;
    pricePence: number;
    currency: string;
    billingCycle: string;
    stripePriceId?: string | null;
  }>;
  payments: Array<{
    id: string;
    amountPence: number;
    currency: string;
    status: string;
    description: string | null;
    paidAt: string | null;
    refundedAt: string | null;
  }>;
};

function formatPrice(pence: number, currency: string) {
  const symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : "$";
  return `${symbol}${(pence / 100).toFixed(2)}`;
}

export function KidBillingCard({ childId, primaryColor }: { childId: string; primaryColor: string }) {
  const [data, setData] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [actioning, setActioning] = useState<"subscribe" | "cancel" | "portal" | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  // Lane PB: the subscription whose first payment is being taken (from the
  // start response this session, or the billing read), whether the parent set
  // it aside, and a key that remounts the payment step on Resume.
  const [payingId, setPayingId] = useState<string | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [paymentSetAside, setPaymentSetAside] = useState(false);
  const [paymentKey, setPaymentKey] = useState(0);

  // Synchronous double-submit guard. `setActioning` is React state, which is
  // asynchronous and batched, so two taps inside one tick BOTH passed it. On
  // gym wifi, where the first tap shows nothing for a second or two, tapping
  // again is normal behaviour rather than an edge case — and it produced two
  // live subscriptions for one child.
  const submittingRef = useRef(false);

  // The Stripe idempotency key for this subscribe intent. Held across retries
  // of the same click so a retry collapses to one subscription, and re-minted
  // when the parent picks a different plan, which is a genuinely new intent.
  const requestIdRef = useRef<string | null>(null);
  const lastPlanRef = useRef<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/member/family/${childId}/billing`);
      if (!res.ok) {
        setError(res.status === 404 ? "Kid not found" : "Failed to load billing");
        return;
      }
      setData(await res.json());
    } catch {
      setError("Couldn't reach the billing service. Try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [childId]);

  async function subscribe() {
    if (!selectedPlanId || !data) return;
    const plan = data.plans.find((p) => p.id === selectedPlanId);
    if (!plan) return;
    if (submittingRef.current) return;
    submittingRef.current = true;

    // New plan selected means a new intent; the same plan re-tapped is a retry
    // of the same one and must reuse the key.
    if (lastPlanRef.current !== selectedPlanId || !requestIdRef.current) {
      requestIdRef.current = crypto.randomUUID();
      lastPlanRef.current = selectedPlanId;
    }
    setActioning("subscribe");
    setActionMessage(null);
    try {
      // The billing read carries each kid tier's stripePriceId.
      const priceId = plan.stripePriceId;
      if (!priceId) {
        setActionMessage("This plan isn't wired to Stripe yet — speak to gym staff.");
        return;
      }
      const res = await fetch(`/api/member/subscriptions/start-for-kid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kidMemberId: childId, priceId, requestId: requestIdRef.current }),
      });
      const body = (await res.json().catch(() => ({}))) as { subscriptionId?: string; error?: string };
      if (!res.ok || !body.subscriptionId) {
        setActionMessage(body?.error ?? "Couldn't start the subscription. Nothing has been charged — please try again.");
        return;
      }
      // Nothing has been charged yet: the subscription is `incomplete` until
      // its first invoice is paid. Take that payment here (lane PB).
      setStartedId(body.subscriptionId);
      setPaymentSetAside(false);
      setPayingId(body.subscriptionId);
    } catch {
      setActionMessage(
        "We couldn't reach the gym's billing to confirm this. Reload the page before trying again — a subscription may already have been started.",
      );
    } finally {
      // Released here, not on success, so a failed attempt does not leave
      // the button permanently dead. The request id is deliberately NOT
      // cleared: a retry of the same plan must reuse it.
      submittingRef.current = false;
      setActioning(null);
    }
  }

  async function cancel() {
    setActioning("cancel");
    setActionMessage(null);
    try {
      const res = await fetch(`/api/member/subscriptions/cancel-for-kid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kidMemberId: childId }),
      });
      const body = await res.json();
      if (!res.ok) {
        setActionMessage(body?.error ?? "Cancel failed");
        return;
      }
      setActionMessage(body?.message ?? "Cancellation scheduled for end of cycle.");
      void refresh();
    } finally {
      setActioning(null);
    }
  }

  async function openPortal() {
    setActioning("portal");
    setActionMessage(null);
    try {
      const res = await fetch(`/api/member/family/${childId}/billing/portal`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setActionMessage(body?.error ?? "Couldn't open billing portal");
        return;
      }
      if (body?.url) {
        window.location.href = body.url as string;
      }
    } finally {
      setActioning(null);
    }
  }

  if (loading) {
    return (
      <div className="rounded-2xl border p-5 flex items-center gap-2 text-sm" style={{ borderColor: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.45)" }}>
        <Loader2 className="w-4 h-4 animate-spin" /> Loading billing…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-2xl border p-5 flex items-start gap-2 text-sm text-rose-400" style={{ borderColor: "rgba(244,63,94,0.2)", background: "rgba(244,63,94,0.06)" }}>
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        {error ?? "Billing unavailable"}
      </div>
    );
  }

  // Owner hasn't opted in — show the speak-to-staff explainer instead of
  // pretending the feature doesn't exist.
  if (!data.tenant.selfBillingEnabled || !data.tenant.stripeConnected) {
    return (
      <div className="rounded-2xl border p-5" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
        <div className="flex items-center gap-2 mb-2">
          <CreditCard className="w-4 h-4 text-gray-400" />
          <h3 className="text-white text-sm font-bold">Billing</h3>
        </div>
        <p className="text-gray-400 text-xs">
          Payments are managed at the gym for now. Speak to staff to set up or change {data.kid.name}&apos;s membership.
        </p>
      </div>
    );
  }

  const state = data.kid.subscriptionState;
  // `pending` still hides the plan picker: the subscription exists at Stripe,
  // so offering another would create a duplicate.
  const hasSub = state !== "none";
  // Which unpaid subscription Resume would pay: the one started in this
  // session, else the one the billing read names.
  const resumableId = startedId ?? data.kid.stripeSubscriptionId ?? null;

  if (payingId) {
    return (
      <div className="rounded-2xl border p-5 space-y-4" style={{ borderColor: "var(--member-border)" }}>
        <div className="flex items-center gap-2">
          <CreditCard className="w-4 h-4" style={{ color: primaryColor }} />
          <h3 className="text-sm font-bold" style={{ color: "var(--member-text)" }}>First payment for {data.kid.name}</h3>
        </div>
        {paymentSetAside ? (
          <div className="space-y-3" role="status">
            <p className="text-xs" style={{ color: "var(--member-text-muted)" }}>
              The first payment has not been taken, so {data.kid.name}&apos;s membership is pending and isn&apos;t
              active yet. Resume when you&apos;re ready. If it stays unpaid for about 23 hours Stripe cancels the
              sign-up and nothing is charged.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => {
                  setPaymentSetAside(false);
                  setPaymentKey((k) => k + 1);
                }}
              >
                Resume payment
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setPayingId(null);
                  void refresh();
                }}
              >
                Back to billing
              </Button>
            </div>
          </div>
        ) : (
          <ConfirmSubscriptionPayment
            key={`${payingId}:${paymentKey}`}
            subscriptionId={payingId}
            payerLabel={data.kid.name}
            onAbandon={() => setPaymentSetAside(true)}
            onPaid={() => {
              setPayingId(null);
              setStartedId(null);
              setActionMessage(`First payment received — ${data.kid.name}'s membership is active.`);
              void refresh();
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border p-5 space-y-4" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
      <div className="flex items-center gap-2">
        <CreditCard className="w-4 h-4" style={{ color: primaryColor }} />
        <h3 className="text-white text-sm font-bold">Billing</h3>
      </div>

      {/* Current subscription line */}
      <div className="text-xs">
        {state === "active" ? (
          <div className="flex items-center gap-2 text-emerald-400">
            <Check className="w-3.5 h-3.5" />
            <span>
              Active — {data.kid.membershipType ?? "subscribed"}, {paymentStatusLabel(data.kid.paymentStatus).toLowerCase()}
            </span>
          </div>
        ) : state === "pending" ? (
          <div className="space-y-2">
            <div className="flex items-start gap-2" style={{ color: "var(--member-warning)" }}>
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden />
              <span>
                {data.kid.membershipType ?? "A plan"} is set up but the first payment has not been completed, so
                it isn&apos;t active yet.
                {resumableId
                  ? " Finish the payment below."
                  : " If you started it here, reload this page to finish the payment, or ask the gym."}
              </span>
            </div>
            {resumableId && (
              <Button
                type="button"
                onClick={() => {
                  setActionMessage(null);
                  setPaymentSetAside(false);
                  setPayingId(resumableId);
                }}
              >
                Finish payment
              </Button>
            )}
          </div>
        ) : (
          <p className="text-gray-400">
            {data.kid.name} doesn&apos;t have a subscription yet. Pick a plan below to start.
          </p>
        )}
      </div>

      {/* Plan picker — shown only if no active subscription */}
      {!hasSub && (
        <div className="space-y-2">
          {data.plans.length === 0 ? (
            <p className="text-xs text-amber-400">
              The gym hasn&apos;t set up any kid plans yet. Speak to staff.
            </p>
          ) : (
            <>
              {data.plans.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedPlanId(p.id)}
                  className="w-full text-left rounded-lg border p-3 transition-colors"
                  style={{
                    borderColor: selectedPlanId === p.id ? primaryColor : "rgba(255,255,255,0.1)",
                    background: selectedPlanId === p.id ? `${primaryColor}1A` : "rgba(255,255,255,0.02)",
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-white text-sm font-semibold">{p.name}</p>
                      {p.description && <p className="text-gray-500 text-[11px] mt-0.5">{p.description}</p>}
                    </div>
                    <div className="text-right">
                      <p className="text-white text-sm font-semibold">{formatPrice(p.pricePence, p.currency)}</p>
                      <p className="text-gray-500 text-[10px]">{p.billingCycle}</p>
                    </div>
                  </div>
                </button>
              ))}
              <Button
                type="button"
                size="mobile"
                className="w-full"
                onClick={() => void subscribe()}
                disabled={!selectedPlanId}
                loading={actioning === "subscribe"}
              >
                {actioning === "subscribe" ? "Starting…" : "Subscribe and pay"}
              </Button>
            </>
          )}
        </div>
      )}

      {/* Manage actions — shown only if active subscription */}
      {hasSub && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={openPortal}
            disabled={actioning === "portal"}
            className="flex-1 min-w-0 py-2.5 rounded-lg text-[var(--tx-on-accent)] text-sm font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2"
            style={{ background: primaryColor }}
          >
            {actioning === "portal" ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Opening…</>
            ) : (
              <><ExternalLink className="w-3.5 h-3.5" /> Manage card</>
            )}
          </button>
          <button
            onClick={cancel}
            disabled={actioning === "cancel"}
            className="flex-1 min-w-0 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 border"
            style={{ color: "rgba(255,255,255,0.65)", borderColor: "rgba(255,255,255,0.15)" }}
          >
            {actioning === "cancel" ? "Cancelling…" : "Cancel at cycle end"}
          </button>
        </div>
      )}

      {/* Last few payments — read-only history */}
      {data.payments.length > 0 && (
        <div className="space-y-1.5 pt-3 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <p className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Recent payments</p>
          {data.payments.slice(0, 3).map((p) => (
            <div key={p.id} className="flex items-center justify-between text-xs">
              <div>
                <p className="text-gray-300">{p.description ?? "Subscription"}</p>
                {p.paidAt && (
                  <p className="text-gray-500 text-[10px]">
                    {new Date(p.paidAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className={`font-semibold ${p.status === "succeeded" ? "text-emerald-400" : p.status === "refunded" ? "text-amber-400" : "text-gray-300"}`}>
                  {formatPrice(p.amountPence, p.currency)}
                </p>
                <p className="text-gray-500 text-[10px]">{p.status}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {actionMessage && (
        <p className="text-xs" style={{ color: primaryColor }}>{actionMessage}</p>
      )}
    </div>
  );
}
