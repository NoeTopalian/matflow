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

import { useEffect, useState } from "react";
import { CreditCard, Loader2, AlertTriangle, ExternalLink, Check } from "lucide-react";

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
    hasActiveSubscription: boolean;
  };
  plans: Array<{
    id: string;
    name: string;
    description: string | null;
    pricePence: number;
    currency: string;
    billingCycle: string;
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
    setActioning("subscribe");
    setActionMessage(null);
    try {
      // We use the plan's name as a stand-in until MembershipTier surfaces
      // its stripePriceId in the billing read. For now the priceId comes
      // from the staff Memberships tab (which lets the owner paste the
      // price_… directly). When the billing read picks up the
      // stripePriceId, swap this line out.
      const priceId = (plan as unknown as { stripePriceId?: string }).stripePriceId;
      if (!priceId) {
        setActionMessage("This plan isn't wired to Stripe yet — speak to gym staff.");
        return;
      }
      const res = await fetch(`/api/member/subscriptions/start-for-kid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kidMemberId: childId, priceId }),
      });
      const body = await res.json();
      if (!res.ok) {
        setActionMessage(body?.error ?? "Subscription failed");
        return;
      }
      // The Stripe SCA flow returns a clientSecret. v1 surfaces a "go to
      // Stripe to confirm" link rather than embedding Stripe Elements
      // (smaller surface to ship + Stripe-hosted is the safest path).
      if (body?.clientSecret) {
        setActionMessage("Subscription started. Confirm payment via the email Stripe just sent.");
      } else {
        setActionMessage("Subscription started.");
      }
      void refresh();
    } finally {
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
      <div className="rounded-2xl border p-5 flex items-center gap-2 text-sm" style={{ borderColor: "rgba(255,255,255,0.1)", color: "var(--tx-3)" }}>
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
          Payments are managed at the gym for now. Speak to staff to set up or change {data.kid.name}'s membership.
        </p>
      </div>
    );
  }

  const hasSub = data.kid.hasActiveSubscription;

  return (
    <div className="rounded-2xl border p-5 space-y-4" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
      <div className="flex items-center gap-2">
        <CreditCard className="w-4 h-4" style={{ color: primaryColor }} />
        <h3 className="text-white text-sm font-bold">Billing</h3>
      </div>

      {/* Current subscription line */}
      <div className="text-xs">
        {hasSub ? (
          <div className="flex items-center gap-2 text-emerald-400">
            <Check className="w-3.5 h-3.5" />
            <span>
              Active — {data.kid.membershipType ?? "subscribed"}, {data.kid.paymentStatus}
            </span>
          </div>
        ) : (
          <p className="text-gray-400">
            {data.kid.name} doesn't have a subscription yet. Pick a plan below to start.
          </p>
        )}
      </div>

      {/* Plan picker — shown only if no active subscription */}
      {!hasSub && (
        <div className="space-y-2">
          {data.plans.length === 0 ? (
            <p className="text-xs text-amber-400">
              The gym hasn't set up any kid plans yet. Speak to staff.
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
              <button
                onClick={subscribe}
                disabled={!selectedPlanId || actioning === "subscribe"}
                className="w-full py-2.5 rounded-lg text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
                style={{ background: primaryColor }}
              >
                {actioning === "subscribe" ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Starting…</>
                ) : (
                  "Subscribe + pay"
                )}
              </button>
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
            className="flex-1 min-w-0 py-2.5 rounded-lg text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2"
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
            style={{ color: "var(--tx-2)", borderColor: "rgba(255,255,255,0.15)" }}
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
