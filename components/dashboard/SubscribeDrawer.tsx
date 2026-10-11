"use client";

import { useState, useEffect, useId, useRef, useCallback } from "react";
import Link from "next/link";
import { AlertTriangle, BadgePoundSterling, Info, CreditCard } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import ConfirmSubscriptionPayment from "@/components/billing/ConfirmSubscriptionPayment";
import { formatTierPrice } from "@/lib/membership-tier-format";
import { cycleBilledCopy } from "@/lib/billing-cycle";
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
 *     creates it with `payment_behavior: "default_incomplete"`, so the first
 *     invoice still has to be paid before it goes live. Saying "subscribed"
 *     here would be the same lie in a different hat.
 *
 * Payments lane PB (11 Oct 2026, audit F1): the drawer now TAKES that first
 * payment. After the server creates the subscription it moves to a payment
 * step (components/billing/ConfirmSubscriptionPayment) on the club's own
 * Stripe account; success is announced only once MatFlow has recorded the
 * payment. "Pay later" leaves it unpaid and offers Resume; reopening the
 * drawer for a member whose subscription is still unpaid offers the first
 * payment instead of a second subscription.
 */

/** What the drawer knows about the member's EXISTING subscription. */
type ExistingState = "none" | "checking" | "unpaid" | "live" | "expired" | "error";

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
  // Payment step (lane PB): the subscription being paid, whether the payer
  // set it aside, and a key that remounts the step on Resume.
  const [payingId, setPayingId] = useState<string | null>(null);
  const [abandoned, setAbandoned] = useState(false);
  const [paymentKey, setPaymentKey] = useState(0);
  const [existing, setExisting] = useState<ExistingState>(existingSubscriptionId ? "checking" : "none");
  // Synchronous in-flight guard. `useState` updates batch, so two clicks in
  // one tick can both slip past a `disabled` attribute; a ref flips
  // immediately. (Same defect class as the addPayment fix in MemberProfile.)
  const submittingRef = useRef(false);

  // The Stripe idempotency key for this subscribe intent. Held across retries
  // of the same click so a retry collapses to one subscription, and re-minted
  // when the chosen tier changes, which is a genuinely different intent. The
  // key used to be derived server-side from a 60-second clock bucket, so two
  // tabs on different tiers ALWAYS produced two subscriptions.
  const requestIdRef = useRef<string | null>(null);
  const lastTierRef = useRef<string | null>(null);

  useEffect(() => {
    if (open) return;
    setTierId("");
    setErrorMsg(null);
    setPayingId(null);
    setAbandoned(false);
  }, [open]);

  // The profile's subscription id is an SSR snapshot and says nothing about
  // whether the first payment was ever taken. Ask MatFlow before deciding
  // between "take the first payment" and "already subscribed".
  const checkExisting = useCallback(async () => {
    if (!existingSubscriptionId) {
      setExisting("none");
      return;
    }
    setExisting("checking");
    try {
      const res = await fetch(`/api/stripe/subscriptions/${encodeURIComponent(existingSubscriptionId)}/status`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setExisting("error");
        return;
      }
      const body = (await res.json()) as { subscription?: { status?: string; ended?: boolean } };
      const sub = body.subscription;
      if (!sub?.status) setExisting("error");
      else if (sub.ended) setExisting("expired");
      else if (sub.status === "incomplete") setExisting("unpaid");
      else setExisting("live");
    } catch {
      setExisting("error");
    }
  }, [existingSubscriptionId]);

  useEffect(() => {
    if (!open || payingId) return;
    void checkExisting();
  }, [open, payingId, checkExisting]);

  // Only a tier an owner has wired to a Stripe price can be subscribed to —
  // the endpoint requires a `price_…` id. Tiers without one are a real,
  // fixable state, so they get named rather than silently filtered into
  // nothing.
  const subscribable = tiers.filter((t) => !!t.stripePriceId);
  const unwired = tiers.length - subscribable.length;
  const selected = subscribable.find((t) => t.id === tierId) ?? null;

  const alreadySubscribed = !!existingSubscriptionId;
  const existingBlocker: string | null =
    existing === "checking"
      ? `Checking ${memberName}'s current subscription…`
      : existing === "expired"
        ? `${memberName}'s last sign-up expired before it was paid, so nothing was taken. Reload the profile to start a new membership.`
        : existing === "unpaid"
          ? `${memberName}'s membership was started but the first payment hasn't been taken, so it isn't active.`
          : existing === "error"
            ? null
            : `${memberName} is already on a Stripe subscription. Cancel that one before starting another, or the member will be billed twice.`;
  const blocker: string | null = !billing.stripeConnected
    ? "This gym cannot take card payments yet. Connect Stripe under Settings → Revenue, then you can put members on a paid membership."
    : billing.chargesEnabled === false
      ? "This gym's Stripe account needs attention before it can take payments. Finish the outstanding steps in Stripe, then try again."
      : alreadySubscribed
        ? existingBlocker
        : tiers.length === 0
          ? "This gym has no membership tiers yet. Create your price list under Memberships first."
          : subscribable.length === 0
            ? "None of this gym's membership tiers is linked to a Stripe price yet, so none can be billed. Add a Stripe price to a tier under Memberships."
            : null;

  const existingError = alreadySubscribed && existing === "error";
  const canSubmit = blocker === null && !existingError && selected !== null && !submitting && !payingId;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current) return;
    if (blocker !== null || existingError || payingId) return;
    if (!selected?.stripePriceId) return;

    submittingRef.current = true;

    if (lastTierRef.current !== selected.stripePriceId || !requestIdRef.current) {
      requestIdRef.current = crypto.randomUUID();
      lastTierRef.current = selected.stripePriceId;
    }
    setSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await fetch("/api/stripe/create-subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Exactly the endpoint's schema. `paymentMethodType` is left off so
        // the route applies its own "card" default rather than this UI
        // asserting a Direct Debit capability the gym may not have.
        body: JSON.stringify({
          memberId,
          priceId: selected.stripePriceId,
          requestId: requestIdRef.current,
        }),
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
      const createdId = data.subscriptionId;

      // The subscription exists, but the TIER still has to be written to the
      // member. Without it `membershipType` stays null, and the kiosk's
      // `selfTrainable` check (accountType !== "kids" && !!membershipType)
      // leaves the member unable to check themselves in — immediately after
      // being put on a paid membership. The members PATCH dual-writes the
      // legacy label alongside the FK, so one call covers both readers.
      let tierRecorded = true;
      try {
        const tierRes = await fetch(`/api/members/${memberId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ membershipTierId: selected.id }),
        });
        tierRecorded = tierRes.ok;
      } catch {
        tierRecorded = false;
      }

      if (!tierRecorded) {
        // Do not fold this into the subscription result: the subscription
        // exists and must not be retried, but the membership is only
        // half-recorded and someone has to finish it by hand. The first
        // payment can still be taken below.
        setErrorMsg(
          `The membership was created, but ${memberName}'s tier could not be saved. ` +
            `Set it on their profile — until then they cannot check themselves in.`,
        );
      }

      // Lane PB: nothing has been paid yet. Move to the payment step for the
      // subscription the server just created; no success toast until MatFlow
      // has recorded the payment.
      setAbandoned(false);
      setPayingId(createdId);
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
        payingId ? (
          <Button type="button" variant="secondary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <Button type="submit" form={formId} disabled={!canSubmit} loading={submitting}>
            {!submitting && <BadgePoundSterling className="size-4" />}
            {submitting
              ? "Starting…"
              : selected
                ? `Start ${formatTierPrice(selected)}`
                : "Start membership"}
          </Button>
        )
      }
    >
      <div className="space-y-4">
        {payingId ? (
          <div className="space-y-4">
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
            {abandoned ? (
              <div role="status" className="space-y-3">
                <div className="flex items-start gap-2">
                  <Info className="mt-0.5 size-4 shrink-0" style={{ color: "var(--tx-3)" }} />
                  <p className="text-sm" style={{ color: "var(--tx-2)" }}>
                    The first payment has not been taken, so {memberName}&apos;s membership is pending and gives no
                    access yet. Resume to take it now, or reopen this drawer later. Stripe cancels an unpaid
                    sign-up after about 23 hours; nothing is charged if it lapses.
                  </p>
                </div>
                <Button
                  type="button"
                  onClick={() => {
                    setAbandoned(false);
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
                payerLabel={memberName}
                onAbandon={() => setAbandoned(true)}
                onPaid={() => {
                  toast(`First payment received — ${memberName}'s membership is active`, "success");
                  onClose();
                }}
              />
            )}
          </div>
        ) : existingError ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-[var(--r-md)] p-3"
            style={{
              background: "color-mix(in srgb, var(--hue-danger) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--hue-danger) 20%, transparent)",
            }}
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{ color: "var(--sf-danger)" }} />
            <div className="min-w-0 space-y-2">
              <p className="text-sm" style={{ color: "var(--sf-danger)" }}>
                Couldn&apos;t check {memberName}&apos;s current subscription, so a new one can&apos;t be started safely.
              </p>
              <Button type="button" variant="secondary" size="compact" onClick={() => void checkExisting()}>
                Try again
              </Button>
            </div>
          </div>
        ) : blocker !== null ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-[var(--r-md)] p-3"
            style={{
              background: "color-mix(in srgb, var(--hue-warning) 10%, transparent)",
              border: "1px solid color-mix(in srgb, var(--hue-warning) 28%, transparent)",
            }}
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{ color: "var(--hue-warning)" }} />
            <div className="min-w-0 space-y-2">
              <p className="text-sm" style={{ color: "var(--tx-1)" }}>{blocker}</p>
              {alreadySubscribed && existing === "unpaid" && billing.stripeConnected && billing.chargesEnabled !== false && (
                <Button
                  type="button"
                  onClick={() => {
                    setAbandoned(false);
                    setPayingId(existingSubscriptionId ?? null);
                  }}
                >
                  <CreditCard className="size-4" />
                  Take the first payment
                </Button>
              )}
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
                  {cycleBilledCopy(selected.billingCycle)}
                </p>
              </div>
            )}

            {/* Never promise money has moved. The subscription is created
                incomplete; the next step takes the first payment. */}
            <div className="flex items-start gap-2">
              <Info className="mt-0.5 size-4 shrink-0" style={{ color: "var(--tx-3)" }} />
              <p className="text-xs" style={{ color: "var(--tx-3)" }}>
                Next you take the first payment by card. The membership goes active once Stripe confirms it.
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
