"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, CreditCard, Loader2, CheckCircle2, AlertCircle } from "lucide-react";

type Pack = {
  id: string;
  name: string;
  description: string | null;
  totalCredits: number;
  validityDays: number;
  pricePence: number;
  currency: string;
};

function formatPrice(pence: number, currency: string) {
  const symbol = currency === "GBP" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  return `${symbol}${(pence / 100).toFixed(2)}`;
}

export default function PurchasePackClient({
  pack,
  gymName,
  stripeAvailable,
  primaryColor,
}: {
  pack: Pack;
  gymName: string;
  stripeAvailable: boolean;
  primaryColor: string;
}) {
  // Card is the only self-serve method: off-Stripe intents (cash / bank
  // transfer) had no fulfilment path — members paid and never got credits —
  // so those options are hidden until an owner-side flow exists.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ kind: "card_redirect" | "intent"; message: string } | null>(null);

  async function purchase() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/member/class-packs/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId: pack.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(data.error ?? "Couldn't start card checkout");
        return;
      }
      window.location.href = data.url;
    } finally {
      setBusy(false);
    }
  }

  if (success) {
    return (
      <div className="px-4 pt-6 pb-12 max-w-md mx-auto">
        <div
          className="rounded-2xl p-8 text-center border"
          style={{ background: "rgba(34,197,94,0.06)", borderColor: "rgba(34,197,94,0.25)" }}
        >
          <CheckCircle2 className="w-10 h-10 mx-auto mb-3" style={{ color: "#22c55e" }} />
          <h2 className="text-xl font-bold text-white mb-2">Recorded</h2>
          <p className="text-sm" style={{ color: "rgba(255,255,255,0.7)" }}>{success.message}</p>
          <Link
            href="/member/profile"
            className="inline-block mt-6 px-4 py-2 rounded-xl text-[var(--tx-on-accent)] text-sm font-semibold"
            style={{ background: primaryColor }}
          >
            Back to profile
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pt-4 pb-12 max-w-md mx-auto">
      <Link
        href="/member/profile"
        className="inline-flex items-center gap-1.5 text-sm mb-4"
        style={{ color: "rgba(255,255,255,0.5)" }}
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </Link>

      <h1 className="text-white text-2xl font-bold tracking-tight mb-1">Register for {gymName}</h1>
      <p className="text-sm mb-5" style={{ color: "rgba(255,255,255,0.55)" }}>
        Pick your pack and how you want to pay.
      </p>

      {/* Options card — single pack for now; extensible later */}
      <Card title="Options">
        <Option
          label={pack.name}
          description={`${pack.totalCredits} classes · valid ${pack.validityDays} days`}
          price={formatPrice(pack.pricePence, pack.currency)}
          selected
        />
        {pack.description && (
          <p className="text-xs mt-2" style={{ color: "rgba(255,255,255,0.45)" }}>{pack.description}</p>
        )}
      </Card>

      {/* Payment method card */}
      <Card title="Payment method">
        <PaymentRadio
          icon={CreditCard}
          label="Credit / debit card"
          description={stripeAvailable ? "Stripe Checkout — saved cards appear automatically." : "Card payments not yet enabled by the gym."}
          checked
          onSelect={() => {}}
          disabled={!stripeAvailable}
          accent={primaryColor}
        />
        <p className="text-xs mt-1" style={{ color: "rgba(255,255,255,0.45)" }}>
          Prefer to pay cash or by bank transfer? Speak to the front desk and they&apos;ll set your pack up for you.
        </p>
      </Card>

      {error && (
        <div className="mt-4 flex items-start gap-2 px-3 py-2 rounded-xl border" style={{ borderColor: "rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.06)", color: "#f87171" }}>
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      <div
        className="mt-5 rounded-2xl p-5 border"
        style={{ background: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.08)" }}
      >
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm font-semibold" style={{ color: "rgba(255,255,255,0.55)" }}>Total</span>
          <span className="text-2xl font-bold text-white tabular-nums">{formatPrice(pack.pricePence, pack.currency)}</span>
        </div>
        {/* Audit D5: a disabled-forever primary CTA is a dead end — when the
            gym has no online payments, say so and route back instead. */}
        {stripeAvailable ? (
          <>
            <button
              onClick={purchase}
              disabled={busy}
              className="w-full py-3.5 rounded-xl text-[var(--tx-on-accent)] font-bold text-sm tracking-wide uppercase disabled:opacity-60"
              style={{ background: primaryColor }}
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin inline" /> : "Purchase"}
            </button>
            <p className="text-[11px] text-center mt-3" style={{ color: "rgba(255,255,255,0.4)" }}>
              Card data goes directly to Stripe — never stored by MatFlow.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-center" style={{ color: "rgba(255,255,255,0.6)" }}>
              Online payments aren&apos;t enabled at this gym yet — speak to the front desk to buy this pack.
            </p>
            <Link
              href="/member/profile"
              className="mt-3 block w-full py-3.5 rounded-xl text-center text-sm font-semibold border"
              style={{ borderColor: "rgba(255,255,255,0.14)", color: "rgba(255,255,255,0.75)" }}
            >
              Back to profile
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-2xl p-5 border mb-4"
      style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.08)" }}
    >
      <p className="font-semibold text-sm text-white mb-3">{title}</p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Option({
  label, description, price, selected,
}: { label: string; description: string; price: string; selected: boolean }) {
  return (
    <div
      className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border"
      style={{
        borderColor: selected ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)",
        background: selected ? "rgba(255,255,255,0.04)" : "transparent",
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span
          className="w-4 h-4 rounded-full border flex items-center justify-center shrink-0"
          style={{ borderColor: selected ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.2)" }}
        >
          {selected && <span className="w-2 h-2 rounded-full bg-white" />}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-white truncate">{label}</p>
          <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.5)" }}>{description}</p>
        </div>
      </div>
      <span className="text-sm font-semibold text-white shrink-0 tabular-nums">{price}</span>
    </div>
  );
}

function PaymentRadio({
  icon: Icon, label, description, checked, onSelect, disabled, accent,
}: {
  icon: typeof CreditCard;
  label: string;
  description: string;
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  accent: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        borderColor: checked ? accent : "rgba(255,255,255,0.08)",
        background: checked ? `${accent}1c` : "transparent",
      }}
      aria-pressed={checked}
    >
      <span
        className="w-4 h-4 rounded-full border flex items-center justify-center shrink-0"
        style={{ borderColor: checked ? accent : "rgba(255,255,255,0.2)" }}
      >
        {checked && <span className="w-2 h-2 rounded-full" style={{ background: accent }} />}
      </span>
      <Icon className="w-4 h-4 shrink-0" style={{ color: checked ? accent : "rgba(255,255,255,0.5)" }} />
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-white">{label}</span>
        <span className="block text-[11px]" style={{ color: "rgba(255,255,255,0.45)" }}>{description}</span>
      </span>
    </button>
  );
}
