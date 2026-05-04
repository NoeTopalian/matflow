"use client";

import { useEffect, useState } from "react";
import { Download, Loader2, AlertCircle, RotateCcw, CheckCircle2, XCircle, Clock, AlertOctagon, X } from "lucide-react";

type Payment = {
  id: string;
  amountPence: number;
  currency: string;
  status: string;
  description: string | null;
  paidAt: string | null;
  refundedAt: string | null;
  refundedAmountPence: number | null;
  failureReason: string | null;
  createdAt: string;
  member: { id: string; name: string; email: string } | null;
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

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function PaymentsTable({ primaryColor }: { primaryColor: string }) {
  const [rows, setRows] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [refunding, setRefunding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Refund modal state — `target` holds the row being refunded; null = closed.
  const [target, setTarget] = useState<Payment | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [reasonInput, setReasonInput] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const url = filterStatus ? `/api/payments?status=${filterStatus}` : `/api/payments`;
      const res = await fetch(url);
      const data = await res.json();
      setRows(Array.isArray(data?.payments) ? data.payments : []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filterStatus]);

  function openRefund(row: Payment) {
    setTarget(row);
    setAmountInput((row.amountPence / 100).toFixed(2));
    setReasonInput("");
    setAmountError(null);
    setError(null);
  }

  function closeRefund() {
    setTarget(null);
    setAmountInput("");
    setReasonInput("");
    setAmountError(null);
  }

  async function submitRefund() {
    if (!target) return;
    const parsedAmount = Number(amountInput);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setAmountError("Enter a valid amount greater than zero.");
      return;
    }
    const amountPence = Math.round(parsedAmount * 100);
    if (amountPence > target.amountPence) {
      setAmountError(`Amount cannot exceed the original charge (${formatAmount(target.amountPence, target.currency)}).`);
      return;
    }
    if (reasonInput.length > 200) {
      setAmountError("Reason must be 200 characters or fewer.");
      return;
    }
    setRefunding(target.id);
    setError(null);
    try {
      // Send full-refund as no body so the backend uses payment.amountPence
      // directly (matches the existing route's optional `amountPence` semantics).
      const isFullRefund = amountPence === target.amountPence;
      const res = await fetch(`/api/payments/${target.id}/refund`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(isFullRefund ? {} : { amountPence }),
          ...(reasonInput.trim() ? { reason: reasonInput.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Refund failed");
      } else {
        closeRefund();
        await load();
      }
    } finally {
      setRefunding(null);
    }
  }

  return (
    <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}>
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div>
          <h2 className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>Payment history</h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
            All Stripe-recorded payments for this gym. Refunds settle from the gym's Stripe balance.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="px-3 py-1.5 rounded-xl text-xs bg-transparent border outline-none"
            style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
          >
            <option value="">All statuses</option>
            <option value="succeeded">Paid</option>
            <option value="failed">Failed</option>
            <option value="refunded">Refunded</option>
            <option value="disputed">Disputed</option>
            <option value="pending">Pending</option>
          </select>
          <a
            href="/api/payments/export.csv"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors hover:bg-white/[0.04]"
            style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </a>
        </div>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-xl border" style={{ borderColor: "rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.06)", color: "#f87171" }}>
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-6" style={{ color: "var(--tx-3)" }}>
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading payments…</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="py-8 text-center text-sm" style={{ color: "var(--tx-3)" }}>
          No payments yet. Stripe events will populate this table automatically.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider" style={{ color: "var(--tx-3)" }}>
                <th className="text-left py-2 pr-3">Date</th>
                <th className="text-left py-2 pr-3">Member</th>
                <th className="text-right py-2 pr-3">Amount</th>
                <th className="text-left py-2 pr-3">Status</th>
                <th className="text-right py-2 pr-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const meta = STATUS_META[r.status] ?? STATUS_META.pending;
                const Icon = meta.Icon;
                return (
                  <tr key={r.id} className="border-t" style={{ borderColor: "var(--bd-default)" }}>
                    <td className="py-2 pr-3 whitespace-nowrap" style={{ color: "var(--tx-2)" }}>
                      {formatDate(r.paidAt ?? r.createdAt)}
                    </td>
                    <td className="py-2 pr-3 min-w-0" style={{ color: "var(--tx-1)" }}>
                      {r.member ? (
                        <div className="min-w-0">
                          <p className="truncate font-medium">{r.member.name}</p>
                          <p className="text-[11px] truncate" style={{ color: "var(--tx-4)" }}>{r.member.email}</p>
                        </div>
                      ) : <span style={{ color: "var(--tx-4)" }}>Unknown</span>}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap" style={{ color: "var(--tx-1)" }}>
                      {formatAmount(r.amountPence, r.currency)}
                      {r.refundedAmountPence ? (
                        <p className="text-[11px]" style={{ color: "var(--tx-4)" }}>
                          -{formatAmount(r.refundedAmountPence, r.currency)} refunded
                        </p>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold"
                        style={{ background: `${meta.color}1f`, color: meta.color }}
                      >
                        <Icon className="w-3 h-3" />
                        {meta.label}
                      </span>
                      {r.failureReason && r.status === "failed" && (
                        <p className="text-[11px] mt-1" style={{ color: "var(--tx-4)" }}>{r.failureReason}</p>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-right whitespace-nowrap">
                      {r.status === "succeeded" && (
                        <button
                          onClick={() => openRefund(r)}
                          disabled={refunding === r.id}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold border transition-colors hover:bg-white/[0.04] disabled:opacity-50"
                          style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
                        >
                          {refunding === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                          Refund
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Refund modal — replaces the prior window.confirm so owners can pick
          partial amounts + capture a reason that lands in the audit log. */}
      {target && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <button
            type="button"
            aria-label="Close refund dialog"
            onClick={closeRefund}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="refund-modal-title"
            className="relative w-full max-w-md rounded-2xl border p-5"
            style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)" }}
          >
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h3 id="refund-modal-title" className="text-base font-semibold" style={{ color: "var(--tx-1)" }}>
                  Refund payment
                </h3>
                <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
                  {target.member?.name ?? "Unknown member"} · {formatAmount(target.amountPence, target.currency)} on {formatDate(target.paidAt ?? target.createdAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={closeRefund}
                aria-label="Close"
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors hover:bg-white/5"
                style={{ color: "var(--tx-4)" }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <label className="block text-xs font-semibold mb-1" style={{ color: "var(--tx-2)" }}>
              Amount to refund ({target.currency === "GBP" ? "£" : target.currency === "USD" ? "$" : target.currency === "EUR" ? "€" : ""})
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              max={(target.amountPence / 100).toFixed(2)}
              value={amountInput}
              onChange={(e) => { setAmountInput(e.target.value); setAmountError(null); }}
              className="w-full px-3 py-2 rounded-xl text-sm bg-transparent border outline-none"
              style={{ borderColor: amountError ? "rgba(239,68,68,0.4)" : "var(--bd-default)", color: "var(--tx-1)" }}
            />
            <p className="text-[11px] mt-1" style={{ color: "var(--tx-4)" }}>
              Max {formatAmount(target.amountPence, target.currency)}. Leave at full amount for a complete refund.
            </p>

            <label className="block text-xs font-semibold mt-4 mb-1" style={{ color: "var(--tx-2)" }}>
              Reason (optional, ≤ 200 chars)
            </label>
            <textarea
              value={reasonInput}
              onChange={(e) => { setReasonInput(e.target.value.slice(0, 200)); setAmountError(null); }}
              placeholder="e.g. Member cancelled before first class · stored in audit log only"
              rows={3}
              className="w-full px-3 py-2 rounded-xl text-sm bg-transparent border outline-none resize-y"
              style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
            />
            <p className="text-[11px] mt-1 text-right tabular-nums" style={{ color: "var(--tx-4)" }}>
              {reasonInput.length}/200
            </p>

            {amountError && (
              <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-xl border" style={{ borderColor: "rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.06)", color: "#f87171" }}>
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <p className="text-xs">{amountError}</p>
              </div>
            )}

            <p className="text-[11px] mt-4" style={{ color: "var(--tx-4)" }}>
              Money returns to the member&apos;s card from the gym&apos;s Stripe balance. If this payment funded a class pack, any unredeemed credits will be voided.
            </p>

            <div className="flex items-center justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={closeRefund}
                disabled={refunding === target.id}
                className="px-3 py-2 rounded-xl text-sm font-semibold border transition-colors hover:bg-white/5 disabled:opacity-50"
                style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitRefund}
                disabled={refunding === target.id}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-opacity disabled:opacity-50"
                style={{ background: primaryColor }}
              >
                {refunding === target.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                Confirm refund
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
