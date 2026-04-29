"use client";

import { useEffect, useState } from "react";
import { CreditCard, Loader2, AlertCircle, ExternalLink, CheckCircle2, XCircle, RotateCcw, AlertOctagon, Clock, Mail, Globe } from "lucide-react";

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

interface GymBillingInfo {
  memberSelfBilling?: boolean;
  billingContactEmail?: string | null;
  billingContactUrl?: string | null;
  name?: string;
}

export default function MemberBillingTab({
  primaryColor = "#3b82f6",
  gym,
}: {
  primaryColor?: string;
  gym?: GymBillingInfo;
}) {
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
              <p className="font-semibold text-sm" style={{ color: "var(--member-text)" }}>Billing & payment methods</p>
              <p className="text-xs mt-0.5" style={{ color: "var(--member-text-muted)" }}>
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
        {gym?.memberSelfBilling ? (
          <button
            onClick={openPortal}
            disabled={opening}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold transition-colors disabled:opacity-60"
            style={{ background: primaryColor }}
          >
            {opening ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
            Manage billing
          </button>
        ) : (
          <div className="mt-4 rounded-xl border px-4 py-3 space-y-2" style={{ borderColor: "rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.02)" }}>
            <p className="text-xs font-semibold" style={{ color: "var(--member-text-muted)" }}>
              For billing changes or cancellations, contact {gym?.name ?? "your gym"}:
            </p>
            {gym?.billingContactEmail && (
              <a
                href={`mailto:${gym.billingContactEmail}`}
                className="flex items-center gap-2 text-xs"
                style={{ color: primaryColor }}
              >
                <Mail className="w-3.5 h-3.5 shrink-0" />
                {gym.billingContactEmail}
              </a>
            )}
            {gym?.billingContactUrl && (
              <a
                href={gym.billingContactUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-xs"
                style={{ color: primaryColor }}
              >
                <Globe className="w-3.5 h-3.5 shrink-0" />
                Visit billing page
              </a>
            )}
          </div>
        )}
      </div>

      <div
        className="rounded-2xl p-5 border"
        style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.08)" }}
      >
        <p className="font-semibold text-sm mb-1" style={{ color: "var(--member-text)" }}>Payment history</p>
        <p className="text-xs mb-3" style={{ color: "var(--member-text-muted)" }}>
          Last 100 payments on this account.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 py-4" style={{ color: "var(--member-text-muted)" }}>
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : payments.length === 0 ? (
          <p className="text-sm py-4" style={{ color: "var(--member-text-muted)" }}>
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
                      <p className="text-sm tabular-nums" style={{ color: "var(--member-text)" }}>{formatAmount(p.amountPence, p.currency)}</p>
                      <p className="text-[11px]" style={{ color: "var(--member-text-muted)" }}>
                        {formatDate(p.paidAt ?? p.createdAt)}{p.description ? ` · ${p.description}` : ""}
                      </p>
                      {/* Sprint 3 M: refunds shown as a separate labelled value, never subtracted from the original amount. */}
                      {p.refundedAmountPence != null && p.refundedAmountPence > 0 && (
                        <p className="text-[11px] tabular-nums" style={{ color: "#94a3b8" }}>
                          Refunded {formatAmount(p.refundedAmountPence, p.currency)}{p.refundedAt ? ` · ${formatDate(p.refundedAt)}` : ""}
                        </p>
                      )}
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
