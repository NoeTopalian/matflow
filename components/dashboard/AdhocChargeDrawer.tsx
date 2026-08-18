"use client";

import { useState, useEffect, useId, useRef } from "react";
import { CreditCard, Check, AlertTriangle } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";

type CardInfo = {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
};

interface Props {
  memberId: string;
  memberName: string;
  open: boolean;
  onClose: () => void;
  /** Retained for the call sites; the Button primitive now sources the accent. */
  primaryColor?: string;
}

export default function AdhocChargeDrawer({
  memberId,
  memberName,
  open,
  onClose,
}: Props) {
  const { toast } = useToast();
  // Ties the footer's submit Button back to the form in the Sheet body.
  const formId = useId();
  const [card, setCard] = useState<CardInfo | null | undefined>(undefined); // undefined = loading
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [unknownMsg, setUnknownMsg] = useState<string | null>(null);
  const submittingRef = useRef(false);
  // The in-flight attempt's idempotency id, bound to the exact amount and
  // description it was minted for.
  //
  // Audit money-path P0-3: this used to be cleared on ANY server response,
  // including the 402 the route returned for network and timeout failures — so
  // a retry after a blip minted a fresh id, Stripe saw a fresh idempotency key,
  // and the member paid twice. It is now cleared only when the outcome is
  // settled: charged, or definitively rejected with no money moved. While the
  // outcome is unknown the id is held, so the retry replays the same Stripe
  // idempotency key and Stripe returns the original PaymentIntent.
  //
  // Bound to the parameters because Stripe rejects a key reused with different
  // ones: editing the amount or description makes it a different charge, which
  // must get its own id.
  const pendingAttemptRef = useRef<{
    requestId: string;
    amountPence: number;
    description: string;
  } | null>(null);

  // Fetch card on open
  useEffect(() => {
    if (!open) {
      // Reset state when closed
      setAmount("");
      setDescription("");
      setSuccessMsg(null);
      setErrorMsg(null);
      setUnknownMsg(null);
      setCard(undefined);
      pendingAttemptRef.current = null;
      return;
    }
    setCard(undefined);
    fetch(`/api/members/${memberId}/payment-method`)
      .then((r) => (r.ok ? r.json() : { card: null }))
      .then((data: { card?: CardInfo | null }) => {
        setCard(data?.card ?? null);
      })
      .catch(() => setCard(null));
  }, [open, memberId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current) return;
    const amountNum = parseFloat(amount);
    if (!amountNum || amountNum <= 0) return;
    if (!description.trim()) return;

    submittingRef.current = true;
    setSubmitting(true);
    setErrorMsg(null);
    setUnknownMsg(null);
    setSuccessMsg(null);

    const amountPence = Math.round(amountNum * 100);
    const trimmedDescription = description.trim();

    // Replay the held id only when this is genuinely the same charge as the
    // attempt whose outcome we never learned; otherwise mint a fresh one.
    const pending = pendingAttemptRef.current;
    const requestId =
      pending && pending.amountPence === amountPence && pending.description === trimmedDescription
        ? pending.requestId
        : crypto.randomUUID();
    pendingAttemptRef.current = { requestId, amountPence, description: trimmedDescription };

    try {
      const res = await fetch(`/api/members/${memberId}/charge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: window.location.origin,
        },
        body: JSON.stringify({
          amountPence,
          description: trimmedDescription,
          requestId,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        outcomeUnknown?: boolean;
        amountPence?: number;
      };

      if (res.ok && data.ok === true) {
        // Settled: the money moved. Next submit is a new attempt.
        pendingAttemptRef.current = null;
        const formatted = `£${(amountPence / 100).toFixed(2)}`;
        setSuccessMsg(`${formatted} charged successfully`);
        toast(`${formatted} charged to ${memberName}`, "success");
        setAmount("");
        setDescription("");
        setTimeout(() => {
          onClose();
          setSuccessMsg(null);
        }, 1800);
        return;
      }

      // Only a response that explicitly says so, or any 4xx (every 4xx this
      // route emits is a pre-Stripe guard or a settled decline), counts as
      // "no money moved". A 502/504 with no parseable body — the shape a
      // proxy timeout takes — is treated as unknown, because it is.
      const settledFailure =
        data.outcomeUnknown === false || (data.outcomeUnknown === undefined && res.status >= 400 && res.status < 500);

      if (settledFailure) {
        pendingAttemptRef.current = null;
        setErrorMsg(data?.error ?? "Charge failed — please try again");
        return;
      }

      // Outcome unknown — hold the attempt id so a retry replays it.
      setUnknownMsg(
        data?.error ??
          "We couldn't confirm this charge. It may still have gone through — check the member's payments before charging again.",
      );
    } catch {
      // The request never came back. It may have reached the server and Stripe,
      // so this is an unknown outcome, not a clean failure — hold the attempt id.
      setUnknownMsg(
        "We couldn't reach MatFlow to confirm this charge. It may still have gone through — check the member's payments before charging again. Retrying here is safe: it reuses the same request, so the member cannot be charged twice.",
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const inputCls = "w-full rounded-[var(--r-md)] px-3 py-2 text-sm focus:outline-none";
  const inputStyle: React.CSSProperties = {
    background: "var(--sf-1)",
    border: "1px solid var(--bd-default)",
    color: "var(--tx-1)",
  };
  const focusHandler = {
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      e.currentTarget.style.borderColor = "var(--bd-active)";
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      e.currentTarget.style.borderColor = "var(--bd-default)";
    },
  };

  const cardLoading = card === undefined;
  const hasCard = card !== null && card !== undefined;
  const canSubmit = hasCard && amount && parseFloat(amount) > 0 && description.trim().length > 0 && !submitting;

  return (
    // Sheet (§4a.3): multi-field form, so the slide-over shape. The primitive
    // brings the focus trap, Escape, scroll lock and unblurred scrim the
    // hand-rolled overlay never had. Handlers and state are untouched.
    <Sheet
      open={open}
      // Escape and the scrim must NOT close mid-charge: the close resets
      // `pendingAttemptRef`, so a retry after an in-flight charge would carry a
      // fresh idempotency key and Stripe would take the money twice. Same
      // guard as MarkPaidDrawer.
      onClose={() => !submitting && onClose()}
      title="Ad-hoc charge"
      description={memberName}
      footer={
        <Button type="submit" form={formId} disabled={!canSubmit} loading={submitting}>
          {!submitting && <CreditCard className="size-4" />}
          {submitting
            ? "Charging…"
            : amount && parseFloat(amount) > 0
              ? `Charge £${parseFloat(amount).toFixed(2)}`
              : "Charge"}
        </Button>
      }
    >
      <div className="space-y-4">
        {/* Card info */}
        <div
          className="flex items-center gap-3 rounded-xl border p-3"
          style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
        >
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{
              background: hasCard
                ? "color-mix(in srgb, var(--hue-success) 12%, transparent)"
                : "color-mix(in srgb, var(--tx-3) 12%, transparent)",
            }}
          >
            <CreditCard
              className="w-4 h-4"
              style={{ color: hasCard ? "var(--hue-success)" : "var(--tx-3)" }}
            />
          </div>
          <div className="min-w-0 flex-1">
            {cardLoading ? (
              <p className="text-sm" style={{ color: "var(--tx-3)" }}>
                Loading payment method…
              </p>
            ) : hasCard ? (
              <>
                <p className="text-sm font-semibold capitalize" style={{ color: "var(--tx-1)" }}>
                  {card.brand} •••• {card.last4}
                </p>
                <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
                  Expires {card.expMonth.toString().padStart(2, "0")}/{card.expYear}
                </p>
              </>
            ) : (
              <p className="text-sm" style={{ color: "var(--tx-3)" }}>
                No saved card — member must add a payment method first
              </p>
            )}
          </div>
        </div>

        {/* Success message. Tinted surface + token icon; body copy stays --tx-1
            because --hue-success is a tint hue and fails contrast as text on
            the light staff shell (UI-RULES §2, §8). */}
        {successMsg && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-xl p-3"
            style={{
              background: "color-mix(in srgb, var(--hue-success) 10%, transparent)",
              border: "1px solid color-mix(in srgb, var(--hue-success) 22%, transparent)",
            }}
          >
            <Check className="w-4 h-4 shrink-0" style={{ color: "var(--hue-success)" }} />
            <p className="text-sm font-medium" style={{ color: "var(--tx-1)" }}>
              {successMsg}
            </p>
          </div>
        )}

        {/* Unknown outcome — distinct from a decline on purpose. The charge may
            have succeeded at Stripe, so this must never read as "it failed".
            Retrying is safe: the drawer holds the attempt id, so the retry
            replays the same Stripe idempotency key. */}
        {unknownMsg && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl p-3"
            style={{
              background: "color-mix(in srgb, var(--hue-warning) 10%, transparent)",
              border: "1px solid color-mix(in srgb, var(--hue-warning) 28%, transparent)",
            }}
          >
            <AlertTriangle
              className="w-4 h-4 shrink-0 mt-0.5"
              style={{ color: "var(--hue-warning)" }}
            />
            <p className="text-sm" style={{ color: "var(--tx-1)" }}>
              {unknownMsg}
            </p>
          </div>
        )}

        {/* Form — the submit button lives in the Sheet footer, wired back here
            by `form={formId}` so the action row stays pinned above the fold. */}
        <form id={formId} onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div>
            <label className="text-xs mb-1.5 block" style={{ color: "var(--tx-3)" }}>
              Amount (£)
            </label>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              disabled={!hasCard || submitting}
              className={inputCls}
              style={inputStyle}
              {...focusHandler}
              required
            />
          </div>

          <div>
            <label className="text-xs mb-1.5 block" style={{ color: "var(--tx-3)" }}>
              Description
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Private lesson, equipment hire"
              maxLength={200}
              disabled={!hasCard || submitting}
              className={inputCls}
              style={inputStyle}
              {...focusHandler}
              required
            />
          </div>

          {/* Settled failure: the card was declined, or the request never
              reached Stripe. --sf-danger, not --hue-danger, because only the
              former clears the contrast floor as text on the light shell. */}
          {errorMsg && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl p-3"
              style={{
                background: "color-mix(in srgb, var(--hue-danger) 8%, transparent)",
                border: "1px solid color-mix(in srgb, var(--hue-danger) 20%, transparent)",
              }}
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "var(--sf-danger)" }} />
              <p className="text-sm" style={{ color: "var(--sf-danger)" }}>
                {errorMsg}
              </p>
            </div>
          )}

        </form>
      </div>
    </Sheet>
  );
}
