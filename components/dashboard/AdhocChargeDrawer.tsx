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
  const submittingRef = useRef(false);
  // Per-attempt idempotency id. Kept across network-unknown outcomes so a retry
  // click replays the same Stripe request instead of charging twice; cleared on
  // any definitive server response.
  const requestIdRef = useRef<string | null>(null);

  // Fetch card on open
  useEffect(() => {
    if (!open) {
      // Reset state when closed
      setAmount("");
      setDescription("");
      setSuccessMsg(null);
      setErrorMsg(null);
      setCard(undefined);
      requestIdRef.current = null;
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
    setSuccessMsg(null);

    const amountPence = Math.round(amountNum * 100);
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();

    try {
      const res = await fetch(`/api/members/${memberId}/charge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: window.location.origin,
        },
        body: JSON.stringify({
          amountPence,
          description: description.trim(),
          requestId: requestIdRef.current,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        amountPence?: number;
      };

      // Definitive server response (success or decline) — next submit is a new attempt.
      requestIdRef.current = null;

      if (!res.ok || !data.ok) {
        setErrorMsg(data?.error ?? "Charge failed — please try again");
        return;
      }

      const formatted = `£${(amountPence / 100).toFixed(2)}`;
      setSuccessMsg(`${formatted} charged successfully`);
      toast(`${formatted} charged to ${memberName}`, "success");
      setAmount("");
      setDescription("");
      setTimeout(() => {
        onClose();
        setSuccessMsg(null);
      }, 1800);
    } catch {
      setErrorMsg("Network error — please try again");
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
      onClose={onClose}
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
            style={{ background: hasCard ? "rgba(34,197,94,0.12)" : "rgba(148,163,184,0.12)" }}
          >
            <CreditCard
              className="w-4 h-4"
              style={{ color: hasCard ? "#22c55e" : "var(--tx-3)" }}
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

        {/* Success message */}
        {successMsg && (
          <div className="flex items-center gap-2 rounded-xl p-3" style={{ background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.2)" }}>
            <Check className="w-4 h-4 shrink-0" style={{ color: "#22c55e" }} />
            <p className="text-sm font-medium" style={{ color: "#22c55e" }}>
              {successMsg}
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

          {errorMsg && (
            <div className="flex items-start gap-2 rounded-xl p-3" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "#f87171" }} />
              <p className="text-sm" style={{ color: "#f87171" }}>
                {errorMsg}
              </p>
            </div>
          )}

        </form>
      </div>
    </Sheet>
  );
}
