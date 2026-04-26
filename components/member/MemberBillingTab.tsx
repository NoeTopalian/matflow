"use client";

import { useEffect, useState } from "react";
import { CreditCard, Loader2, AlertCircle, ExternalLink, CheckCircle2, XCircle, RotateCcw, AlertOctagon, Clock } from "lucide-react";

type Payment = {
  id: string;
  amountPence: number;
  currency: string;
  status: string;
  description: string | null;
  paidAt: string | null;
  refundedAt: string | null;
  refundedAmountPence: number | null;
  createdAt: string;
};

const STATUS_META: Record<string, { label: string; color: string; Icon: typeof CheckCircle2 }> = {
  succeeded: { label: "Paid", color: "#22c55e", Icon: CheckCircle2 },
  failed: { label: "Failed", color: "#ef4444", Icon: XCircle },
  refunded: { label: "Refunded", color: "#94a3b8", Icon: RotateCcw },
  disputed: { label: "Disputed", color: "#f59e0b", Icon: AlertOctagon },
  pending: { label: "Pending", color: "#38bdf8", Icon: Clock },
};

function formatAmount(pence: number, currency: string) {
  const symbol = currency === "GBP" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  return `${symbol}${(pence / 100).toFixed(2)}`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function MemberBillingTab({ primaryColor = "#3b82f6" }: { primaryColor?: string }) {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/member/me/payments")
      .then((r) => r.ok ? r.json() : [])
      .then((d) => Array.isArray(d) && setPayments(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function openPortal() {
    setOpening(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/portal", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(data.error ?? "Couldn't open the billing portal");
      } else {
        window.location.href = data.url;
        return;
      }
    } catch {
      setError("Network error");
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="space-y-4">
      <div
        className="rounded-2xl p-5 border"
        style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.08)" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: `${primaryColor}1f` }}
            >
              <CreditCard className="w-5 h-5" style={{ color: primaryColor }} />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-sm text-white">Billing & payment methods</p>
              <p className="text-xs mt-0.5" style={{ color: "rgba(255,255,255,0.5)" }}>
                Manage your card, switch to Direct Debit, view invoices, or cancel — all on Stripe&apos;s secure portal.
              </p>
            </div>
          </div>
        </div>
        {error && (
          <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-xl border" style={{ borderColor: "rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.06)", color: "#f87171" }}>
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="text-xs">{error}</p>
          </div>
        )}
        <button
          onClick={openPortal}
          disabled={opening}
          className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold transition-colors disabled:opacity-60"
          style={{ background: primaryColor }}
        >
          {opening ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
          Manage billing
        </button>
      </div>

      <div
        className="rounded-2xl p-5 border"
        style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.08)" }}
      >
        <p className="font-semibold text-sm text-white mb-1">Payment history</p>
        <p className="text-xs mb-3" style={{ color: "rgba(255,255,255,0.5)" }}>
          Last 100 payments on this account.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 py-4" style={{ color: "rgba(255,255,255,0.5)" }}>
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : payments.length === 0 ? (
          <p className="text-sm py-4" style={{ color: "rgba(255,255,255,0.5)" }}>
            No payments yet. They&apos;ll appear here once your first invoice clears.
          </p>
        ) : (
          <ul className="space-y-1">
            {payments.map((p) => {
              const meta = STATUS_META[p.status] ?? STATUS_META.pending;
              const Icon = meta.Icon;
              return (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl"
                  style={{ background: "rgba(255,255,255,0.02)" }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className="inline-flex items-center justify-center w-7 h-7 rounded-lg shrink-0"
                      style={{ background: `${meta.color}1f`, color: meta.color }}
                    >
                      <Icon className="w-3.5 h-3.5" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm text-white tabular-nums">{formatAmount(p.amountPence, p.currency)}</p>
                      <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.5)" }}>
                        {formatDate(p.paidAt ?? p.createdAt)}{p.description ? ` · ${p.description}` : ""}
                      </p>
                    </div>
                  </div>
                  <span className="text-[11px] font-semibold" style={{ color: meta.color }}>{meta.label}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
