"use client";

import { useEffect, useState } from "react";
import { Download, Loader2, AlertCircle, RotateCcw, CheckCircle2, XCircle, Clock, AlertOctagon } from "lucide-react";

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

  async function refund(id: string) {
    if (!confirm("Refund this payment in full? Money returns to the member's card. The gym's Stripe balance covers the refund.")) return;
    setRefunding(id);
    setError(null);
    try {
      const res = await fetch(`/api/payments/${id}/refund`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Refund failed");
      } else {
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
                          onClick={() => refund(r.id)}
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
    </div>
  );
}
