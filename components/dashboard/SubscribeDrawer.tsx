"use client";

import { useState, useEffect, useId, useRef } from "react";
import Link from "next/link";
import { AlertTriangle, BadgePoundSterling, Info } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { formatTierPrice } from "@/lib/membership-tier-format";
import type { MembershipTierOption, TenantBilling } from "@/components/dashboard/MemberProfile";

/**
 * C1 — staff-side "put this member on a paid membership".
 *
 * POST /api/stripe/create-subscription has existed, gated and unit-tested,
 * with no caller: a club literally could not take a recurring payment through
 * MatFlow. This is that caller. The endpoint's contract is authoritative and
 * unchanged — `{ memberId, priceId }`, owner/manager only, 400 when Stripe is
 * not connected, 503 when the gym's account cannot accept charges.
 *
 * Two honesty rules drive the whole component (UI-RULES §7):
 *
 *  1. **A failed request never reads as a success.** `res.ok` is checked, the
 *     server's own message is surfaced, and nothing about the member's
 *     billing state is updated unless the server said the subscription
 *     exists.
 *  2. **A created subscription is not a collected payment.** The helper
 *     creates it with `payment_behavior: "default_incomplete"`, so the member
 *     still has to pay the first invoice before it goes live. Saying
 *     "subscribed" here would be the same lie in a different hat.
 */

interface Props {
  memberId: string;
  memberName: string;
  open: boolean;
  onClose: () => void;
  tiers: MembershipTierOption[];
  billing: TenantBilling;
  /** Already on a subscription — a second one would double-bill. */
  existingSubscriptionId?: string | null;
  /** Fired ONLY after the server confirmed the subscription exists. */
  onSubscribed: (subscriptionId: string) => void;
}

export default function SubscribeDrawer({
  memberId,
  memberName,
  open,
  onClose,
  tiers,
  billing,
  existingSubscriptionId,
  onSubscribed,
}: Props) {
  const { toast } = useToast();
  const formId = useId();
  const [tierId, setTierId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Synchronous in-flight guard. `useState` updates batch, so two clicks in
  // one tick can both slip past a `disabled` attribute; a ref flips
  // immediately. (Same defect class as the addPayment fix in MemberProfile.)
  const submittingRef = useRef(false);

  useEffect(() => {
    if (open) return;
    setTierId("");
    setErrorMsg(null);
  }, [open]);

  // Only a tier an owner has wired to a Stripe price can be subscribed to —
  // the endpoint requires a `price_…` id. Tiers without one are a real,
  // fixable state, so they get named rather than silently filtered into
  // nothing.
  const subscribable = tiers.filter((t) => !!t.stripePriceId);
  const unwired = tiers.length - subscribable.length;
  const selected = subscribable.find((t) => t.id === tierId) ?? null;

  const alreadySubscribed = !!existingSubscriptionId;
  const blocker: string | null = !billing.stripeConnected
    ? "This gym cannot take card payments yet. Connect Stripe under Settings → Revenue, then you can put members on a paid membership."
    : billing.chargesEnabled === false
      ? "This gym's Stripe account needs attention before it can take payments. Finish the outstanding steps in Stripe, then try again."
      : alreadySubscribed
        ? `${memberName} is already on a Stripe subscription. Cancel that one before starting another, or the member will be billed twice.`
        : tiers.length === 0
          ? "This gym has no membership tiers yet. Create your price list under Memberships first."
          : subscribable.length === 0
            ? "None of this gym's membership tiers is linked to a Stripe price yet, so none can be billed. Add a Stripe price to a tier under Memberships."
            : null;

  const canSubmit = blocker === null && selected !== null && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current) return;
    if (blocker !== null) return;
    if (!selected?.stripePriceId) return;

    submittingRef.current = true;
    setSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await fetch("/api/stripe/create-subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Exactly the endpoint's schema. `paymentMethodType` is left off so
        // the route applies its own "card" default rather than this UI
        // asserting a Direct Debit capability the gym may not have.
        body: JSON.stringify({ memberId, priceId: selected.stripePriceId }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        subscriptionId?: string;
        error?: string;
      };

      // A non-ok response, or an ok one with no subscription id, is a
      // failure. Neither may toast success, and neither may tell the profile
      // that this member now has a membership.
      if (!res.ok || !data.subscriptionId) {
        setErrorMsg(
          data.error ??
            "Couldn't start this membership. Nothing has been charged — please try again.",
        );
        return;
      }

      onSubscribed(data.subscriptionId);
      toast(`Membership created for ${memberName}`, "success");
      onClose();
    } catch {
      // The request never came back, so we do not know whether Stripe created
      // anything. Say exactly that rather than guessing in either direction.
      setErrorMsg(
        "We couldn't reach MatFlow to confirm this. Check the member's billing before trying again — a subscription may already have been created.",
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      // Escape and the scrim must not close mid-request: the reset would wipe
      // the error the desk still needs to read. Same guard as AdhocChargeDrawer.
      onClose={() => !submitting && onClose()}
      title="Start a membership"
      description={memberName}
      footer={
        <Button type="submit" form={formId} disabled={!canSubmit} loading={submitting}>
          {!submitting && <BadgePoundSterling className="size-4" />}
          {submitting
            ? "Starting…"
            : selected
              ? `Start ${formatTierPrice(selected)}`
              : "Start membership"}
        </Button>
      }
    >
      <div className="space-y-4">
        {blocker !== null ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-[var(--r-md)] p-3"
            style={{
              background: "color-mix(in srgb, var(--hue-warning) 10%, transparent)",
              border: "1px solid color-mix(in srgb, var(--hue-warning) 28%, transparent)",
            }}
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{ color: "var(--hue-warning)" }} />
            <div className="min-w-0">
              <p className="text-sm" style={{ color: "var(--tx-1)" }}>{blocker}</p>
              {(tiers.length === 0 || subscribable.length === 0) && billing.stripeConnected && !alreadySubscribed && (
                <Link
                  href="/dashboard/memberships"
                  className="mt-1 inline-block text-sm underline"
                  style={{ color: "var(--tx-1)" }}
                >
                  Open Memberships
                </Link>
              )}
            </div>
          </div>
        ) : (
          <form id={formId} onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            <div>
              <label
                htmlFor={`${formId}-tier`}
                className="mb-1.5 block text-xs"
                style={{ color: "var(--tx-3)" }}
              >
                Membership tier
              </label>
              <select
                id={`${formId}-tier`}
                value={tierId}
                onChange={(e) => setTierId(e.target.value)}
                disabled={submitting}
                className="w-full appearance-none rounded-[var(--r-md)] px-3 py-2 text-sm focus:outline-none"
                style={{
                  background: "var(--sf-1)",
                  border: "1px solid var(--bd-default)",
                  color: "var(--tx-1)",
                }}
              >
                <option value="">Select a tier…</option>
                {subscribable.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} — {formatTierPrice(t)}
                  </option>
                ))}
              </select>
              {unwired > 0 && (
                <p className="mt-1.5 text-xs" style={{ color: "var(--tx-3)" }}>
                  {unwired} more {unwired === 1 ? "tier is" : "tiers are"} not linked to a Stripe price, so
                  cannot be billed.
                </p>
              )}
            </div>

            {/* What the member is about to be signed up to, before confirming. */}
            {selected && (
              <div
                className="rounded-[var(--r-md)] border p-3"
                style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
              >
                <p className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>{selected.name}</p>
                <p className="mt-0.5 text-sm" style={{ color: "var(--tx-2)" }}>
                  {formatTierPrice(selected)}
                  {selected.billingCycle === "monthly" && ", billed monthly until cancelled"}
                  {selected.billingCycle === "annual" && ", billed yearly until cancelled"}
                </p>
              </div>
            )}

            {/* Never promise money has moved. The subscription is created
                incomplete; the member pays the first invoice themselves. */}
            <div className="flex items-start gap-2">
              <Info className="mt-0.5 size-4 shrink-0" style={{ color: "var(--tx-3)" }} />
              <p className="text-xs" style={{ color: "var(--tx-3)" }}>
                Starting a membership does not take payment here. Stripe raises the first invoice and{" "}
                {memberName} pays it; the membership goes active once that payment clears.
              </p>
            </div>

            {errorMsg && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-[var(--r-md)] p-3"
                style={{
                  background: "color-mix(in srgb, var(--hue-danger) 8%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--hue-danger) 20%, transparent)",
                }}
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{ color: "var(--sf-danger)" }} />
                <p className="text-sm" style={{ color: "var(--sf-danger)" }}>{errorMsg}</p>
              </div>
            )}
          </form>
        )}
      </div>
    </Sheet>
  );
}
