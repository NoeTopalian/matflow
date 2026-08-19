"use client";

/**
 * /dashboard/payments — full payment history for the tenant.
 *
 * Fetches paginated payment records from GET /api/payments with status filter
 * and member-name search (client-side on the loaded page). Owner-only route;
 * the API enforces requireOwner() so any direct URL hit by non-owners gets a
 * redirect from the server.
 */

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { CreditCard, ChevronLeft, ChevronRight, Search } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type PaymentStatus = "succeeded" | "failed" | "refunded" | "disputed" | "pending";

type PaymentRow = {
  id: string;
  amountPence: number;
  status: PaymentStatus;
  description: string | null;
  createdAt: string;
  paidAt: string | null;
  failureReason: string | null;
  stripePaymentIntentId: string | null;
  member: { id: string; name: string; membershipType: string | null } | null;
};

type OpenDispute = {
  id: string;
  amountPence: number;
  currency: string | null;
  reason: string;
  status: string;
  evidenceDueAt: string | null;
  createdAt: string;
  memberName: string | null;
};

type ApiResponse = {
  payments: PaymentRow[];
  total: number;
  page: number;
  pages: number;
  openDisputes: OpenDispute[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_TABS: Array<{ value: "all" | PaymentStatus; label: string }> = [
  { value: "all", label: "All" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "refunded", label: "Refunded" },
  { value: "disputed", label: "Disputed" },
  { value: "pending", label: "Pending" },
];

const STATUS_STYLES: Record<PaymentStatus, { text: string; bg: string; label: string }> = {
  succeeded: { text: "text-green-400",  bg: "bg-green-400/10",  label: "Succeeded" },
  failed:    { text: "text-red-400",    bg: "bg-red-400/10",    label: "Failed"    },
  pending:   { text: "text-yellow-400", bg: "bg-yellow-400/10", label: "Pending"   },
  refunded:  { text: "text-slate-400",  bg: "bg-slate-400/10",  label: "Refunded"  },
  disputed:  { text: "text-orange-400", bg: "bg-orange-400/10", label: "Disputed"  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatAmount(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: PaymentStatus }) {
  const s = STATUS_STYLES[status];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold ${s.text} ${s.bg}`}
    >
      {s.label}
    </span>
  );
}

function SkeletonRow() {
  return (
    <tr>
      {Array.from({ length: 7 }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-4 rounded animate-pulse" style={{ background: "var(--bd-default)", width: i === 1 ? "80%" : "60%" }} />
        </td>
      ))}
    </tr>
  );
}

// Open disputes carry a hard evidence deadline — miss it and the dispute is
// lost by default. Previously this data was visible only to the platform
// admin; the owner learnt about it from a single email (audit money-gap (a)).
// `loadedAt` is the epoch-ms clock reading taken when the payload was
// fetched. Reading Date.now() here in render would be impure — and the
// deadline countdown is genuinely "as at the moment the data was loaded".
function DisputePanel({ disputes, loadedAt }: { disputes: OpenDispute[]; loadedAt: number }) {
  if (disputes.length === 0) return null;

  const symbol = (c: string | null) =>
    c?.toUpperCase() === "EUR" ? "€" : c?.toUpperCase() === "USD" ? "$" : "£";
  const daysLeft = (iso: string | null) => {
    if (!iso) return null;
    return Math.ceil((new Date(iso).getTime() - loadedAt) / 86_400_000);
  };

  return (
    <section
      aria-label="Open disputes"
      className="rounded-2xl p-4 space-y-3"
      style={{
        background: "rgba(245,158,11,0.08)",
        border: "1px solid rgba(245,158,11,0.30)",
      }}
    >
      <p className="text-sm font-semibold" style={{ color: "#b45309" }}>
        {disputes.length === 1 ? "1 open dispute needs" : `${disputes.length} open disputes need`} your attention
      </p>
      <div className="space-y-2">
        {disputes.map((d) => {
          const days = daysLeft(d.evidenceDueAt);
          const urgent = days !== null && days <= 3;
          return (
            <div
              key={d.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm rounded-xl px-3 py-2.5"
              style={{ background: "var(--sf-1)", border: "1px solid var(--bd-default)" }}
            >
              <span className="font-semibold" style={{ color: "var(--tx-1)" }}>
                {symbol(d.currency)}{(d.amountPence / 100).toFixed(2)}
              </span>
              <span style={{ color: "var(--tx-2)" }}>{d.memberName ?? "Unknown member"}</span>
              <span className="text-xs" style={{ color: "var(--tx-3)" }}>
                {d.reason.replaceAll("_", " ")}
              </span>
              <span
                className="ml-auto text-xs font-semibold px-2 py-0.5 rounded-full"
                style={
                  urgent
                    ? { background: "rgba(239,68,68,0.12)", color: "#dc2626" }
                    : { background: "rgba(245,158,11,0.12)", color: "#b45309" }
                }
              >
                {days === null
                  ? "No deadline given"
                  : days <= 0
                    ? "Evidence overdue"
                    : `Evidence due in ${days} day${days === 1 ? "" : "s"}`}
              </span>
            </div>
          );
        })}
      </div>
      <a
        href="https://dashboard.stripe.com/disputes"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block text-xs font-semibold underline underline-offset-2"
        style={{ color: "#b45309" }}
      >
        Respond with evidence in your Stripe dashboard →
      </a>
    </section>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function PaymentHistoryPage() {
  const [statusFilter, setStatusFilter] = useState<"all" | PaymentStatus>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ApiResponse | null>(null);
  // Clock reading taken when `data` landed — drives the dispute countdown.
  const [loadedAt, setLoadedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPayments = useCallback(async (status: "all" | PaymentStatus, p: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(p) });
      if (status !== "all") params.set("status", status);
      const res = await fetch(`/api/payments?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: ApiResponse = await res.json();
      setData(json);
      setLoadedAt(Date.now());
    } catch (err) {
      console.error("[payments page] fetch failed", err);
      setError("Failed to load payments. Please refresh.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPage(1);
    void fetchPayments(statusFilter, 1);
  }, [statusFilter, fetchPayments]);

  useEffect(() => {
    if (page !== 1) void fetchPayments(statusFilter, page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // Client-side member-name filter on the already-loaded page
  const visibleRows =
    data?.payments.filter((p) => {
      if (!search.trim()) return true;
      return p.member?.name.toLowerCase().includes(search.trim().toLowerCase());
    }) ?? [];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <header className="flex items-start gap-4">
        <div
          className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0"
          style={{ background: "var(--color-primary-dim)", color: "var(--color-primary)" }}
        >
          <CreditCard className="w-6 h-6" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--tx-1)" }}>
            Payment History
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--tx-3)" }}>
            {data
              ? `${data.total.toLocaleString()} payment${data.total === 1 ? "" : "s"} total`
              : "Loading…"}
          </p>
        </div>
      </header>

      {/* Open disputes — renders nothing when there are none */}
      <DisputePanel disputes={data?.openDisputes ?? []} loadedAt={loadedAt} />

      {/* Filter row */}
      <div className="flex flex-col sm:flex-row gap-3">
        {/* Status tabs */}
        <div
          className="flex gap-1 p-1 rounded-xl"
          style={{ background: "var(--sf-0)", border: "1px solid var(--bd-default)" }}
        >
          {STATUS_TABS.map((tab) => {
            const active = statusFilter === tab.value;
            return (
              <button
                key={tab.value}
                onClick={() => setStatusFilter(tab.value)}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                style={
                  active
                    ? { background: "var(--color-primary)", color: "#fff" }
                    : { color: "var(--tx-3)" }
                }
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Member search */}
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-xl flex-1 sm:max-w-xs"
          style={{ background: "var(--sf-0)", border: "1px solid var(--bd-default)" }}
        >
          <Search className="w-4 h-4 shrink-0" style={{ color: "var(--tx-4)" }} />
          <input
            type="text"
            placeholder="Search member name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-[--tx-4]"
            style={{ color: "var(--tx-1)" }}
          />
        </div>
      </div>

      {/* Table */}
      <div
        className="rounded-2xl border overflow-hidden"
        style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
      >
        {error ? (
          <div className="p-12 text-center">
            <p className="text-sm" style={{ color: "var(--tx-3)" }}>{error}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--bd-default)" }}>
                  {["Date", "Member", "Type", "Amount", "Status", "Description", "Actions"].map(
                    (col) => (
                      <th
                        key={col}
                        className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider"
                        style={{ color: "var(--tx-4)" }}
                      >
                        {col}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)
                ) : visibleRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-16 text-center">
                      <CreditCard
                        className="w-10 h-10 mx-auto mb-3"
                        style={{ color: "var(--tx-4)" }}
                      />
                      <p
                        className="text-base font-semibold mb-1"
                        style={{ color: "var(--tx-1)" }}
                      >
                        No payments found
                      </p>
                      <p className="text-sm" style={{ color: "var(--tx-3)" }}>
                        {search
                          ? "Try a different member name."
                          : statusFilter !== "all"
                            ? "No payments match this status filter."
                            : "Payment records will appear here once charges are processed."}
                      </p>
                    </td>
                  </tr>
                ) : (
                  visibleRows.map((payment) => (
                    <tr
                      key={payment.id}
                      style={{ borderBottom: "1px solid var(--bd-default)" }}
                      className="transition-colors hover:bg-black/[0.02]"
                    >
                      {/* Date */}
                      <td
                        className="px-4 py-3 whitespace-nowrap tabular-nums text-xs"
                        style={{ color: "var(--tx-3)" }}
                      >
                        {formatDate(payment.createdAt)}
                      </td>

                      {/* Member */}
                      <td className="px-4 py-3">
                        {payment.member ? (
                          <Link
                            href={`/dashboard/members/${payment.member.id}`}
                            className="font-medium hover:underline"
                            style={{ color: "var(--tx-1)" }}
                          >
                            {payment.member.name}
                          </Link>
                        ) : (
                          <span style={{ color: "var(--tx-4)" }}>—</span>
                        )}
                      </td>

                      {/* Type */}
                      <td className="px-4 py-3 text-xs" style={{ color: "var(--tx-3)" }}>
                        {payment.member?.membershipType ?? "Ad-hoc"}
                      </td>

                      {/* Amount */}
                      <td
                        className="px-4 py-3 font-semibold tabular-nums whitespace-nowrap"
                        style={{ color: "var(--tx-1)" }}
                      >
                        {formatAmount(payment.amountPence)}
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3">
                        <StatusBadge status={payment.status} />
                      </td>

                      {/* Description */}
                      <td
                        className="px-4 py-3 max-w-[200px] truncate text-xs"
                        style={{ color: "var(--tx-3)" }}
                        title={payment.description ?? payment.failureReason ?? ""}
                      >
                        {payment.description ?? payment.failureReason ?? (
                          <span style={{ color: "var(--tx-4)" }}>—</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3">
                        {payment.status === "succeeded" && payment.amountPence > 0 && payment.member ? (
                          <Link
                            href={`/dashboard/members/${payment.member.id}?tab=payments`}
                            className="text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors hover:bg-black/5"
                            style={{
                              borderColor: "var(--bd-default)",
                              color: "var(--tx-2)",
                            }}
                          >
                            {/* Audit N1: labelled "Refund" but the member
                                payments tab has no refund control — the
                                refund modal lives in Settings → Revenue.
                                Honest label until refunds move here. */}
                            View payments
                          </Link>
                        ) : (
                          <span style={{ color: "var(--tx-4)" }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {data && data.pages > 1 && !loading && (
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderTop: "1px solid var(--bd-default)" }}
          >
            <p className="text-xs" style={{ color: "var(--tx-3)" }}>
              Page {data.page} of {data.pages} · {data.total} total
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-40"
                style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
              >
                <ChevronLeft className="w-3 h-3" />
                Previous
              </button>
              <button
                onClick={() => setPage((p) => Math.min(data.pages, p + 1))}
                disabled={page >= data.pages}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-40"
                style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
              >
                Next
                <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
