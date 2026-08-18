"use client";

/**
 * /dashboard/payments — full payment history for the tenant.
 *
 * Fetches paginated payment records from GET /api/payments with status filter
 * and member-name search (client-side on the loaded page). Owner-only route;
 * the API enforces requireOwner() so any direct URL hit by non-owners gets a
 * redirect from the server.
 *
 * The table is the shared `DataTable` primitive driven by the column
 * definitions in `payments-columns.tsx` — the same ones the Settings → Revenue
 * panel uses — so the two surfaces cannot drift again, and the primitive's
 * card-collapse gives this page the mobile layout it never had (§9).
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, CreditCard, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/page-header";
import {
  PAYMENT_STATUS_META,
  paymentAmountColumn,
  paymentDateColumn,
  paymentDescriptionColumn,
  paymentMemberColumn,
  paymentStatusColumn,
  paymentTypeColumn,
  renderPaymentCard,
  type PaymentStatus,
} from "@/components/dashboard/payments-columns";

// ─── Types ────────────────────────────────────────────────────────────────────

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

// Values are the API's status filter; labels come from the shared status meta
// so a pill and its tab never disagree about what "succeeded" is called.
const STATUS_TABS: Array<{ value: "all" | PaymentStatus; label: string }> = [
  { value: "all", label: "All" },
  { value: "succeeded", label: PAYMENT_STATUS_META.succeeded.label },
  { value: "failed", label: PAYMENT_STATUS_META.failed.label },
  { value: "refunded", label: PAYMENT_STATUS_META.refunded.label },
  { value: "disputed", label: PAYMENT_STATUS_META.disputed.label },
  { value: "pending", label: PAYMENT_STATUS_META.pending.label },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

// Open disputes carry a hard evidence deadline — miss it and the dispute is
// lost by default. Previously this data was visible only to the platform
// admin; the owner learnt about it from a single email (audit money-gap (a)).
/**
 * `now` is the clock reading taken when the payments payload landed, not one
 * taken during render: `Date.now()` in a render body is impure, and an SSR
 * reading and a client reading can straddle midnight and disagree by a day on
 * a legal deadline. Null until the first load resolves, and the countdown
 * simply is not claimed until then (§7).
 */
function DisputePanel({ disputes, now }: { disputes: OpenDispute[]; now: number | null }) {
  if (disputes.length === 0) return null;

  const symbol = (c: string | null) =>
    c?.toUpperCase() === "EUR" ? "€" : c?.toUpperCase() === "USD" ? "$" : "£";
  const daysLeft = (iso: string | null) => {
    if (!iso || now === null) return null;
    return Math.ceil((new Date(iso).getTime() - now) / 86_400_000);
  };

  return (
    <section
      aria-label="Open disputes"
      className="mb-6 rounded-[var(--r-md)] p-4 space-y-3"
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
              className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm rounded-[var(--r-sm)] px-3 py-2.5"
              style={{ background: "var(--sf-1)", border: "1px solid var(--bd-default)" }}
            >
              <span className="font-semibold" style={{ color: "var(--tx-1)" }}>
                {symbol(d.currency)}{(d.amountPence / 100).toFixed(2)}
              </span>
              <span style={{ color: "var(--tx-2)" }}>{d.memberName ?? "Unknown member"}</span>
              <span className="text-xs" style={{ color: "var(--tx-3)" }}>
                {d.reason.replaceAll("_", " ")}
              </span>
              {d.evidenceDueAt === null ? (
                <span className="ml-auto text-xs font-semibold" style={{ color: "var(--tx-3)" }}>
                  No deadline given
                </span>
              ) : days === null ? null : (
                <span
                  className="ml-auto text-xs font-semibold px-2 py-0.5 rounded-full"
                  style={
                    urgent
                      ? { background: "rgba(239,68,68,0.12)", color: "#dc2626" }
                      : { background: "rgba(245,158,11,0.12)", color: "#b45309" }
                  }
                >
                  {days <= 0
                    ? "Evidence overdue"
                    : `Evidence due in ${days} day${days === 1 ? "" : "s"}`}
                </span>
              )}
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

/**
 * Refunds are not issued from this page — the refund flow lives in
 * Settings → Revenue. The link is labelled for what it actually does (§7).
 */
function ViewPaymentsLink({ row }: { row: PaymentRow }) {
  if (row.status !== "succeeded" || row.amountPence <= 0 || !row.member) {
    return <span className="text-tx-4">—</span>;
  }
  return (
    <Link
      href={`/dashboard/members/${row.member.id}?tab=payments`}
      onClick={(event) => event.stopPropagation()}
      className="inline-flex h-8 items-center rounded-[var(--r-sm)] border border-bd-default px-2.5 text-[13px] font-medium text-tx-2 transition-colors hover:border-bd-hover hover:text-tx-1"
    >
      View payments
    </Link>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function PaymentHistoryPage() {
  const [statusFilter, setStatusFilter] = useState<"all" | PaymentStatus>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ApiResponse | null>(null);
  // Clock reading taken when `data` landed — drives the dispute countdown.
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
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
      // The clock reading the dispute countdown is measured against.
      setLoadedAt(Date.now());
    } catch (err) {
      console.error("[payments page] fetch failed", err);
      setError("Couldn't load payments — tap to retry");
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

  // The six shared columns plus this page's own action column. Module-scope
  // column identities keep the table's sort memo stable across renders.
  const columns = useMemo<DataTableColumn<PaymentRow>[]>(
    () => [
      paymentDateColumn,
      paymentMemberColumn,
      paymentTypeColumn,
      paymentAmountColumn,
      paymentStatusColumn,
      paymentDescriptionColumn,
      {
        key: "actions",
        header: "",
        headerLabel: "",
        align: "right",
        width: "9rem",
        cell: (row: PaymentRow) => <ViewPaymentsLink row={row} />,
      },
    ],
    [],
  );

  return (
    <div className="w-full">
      <PageHeader
        title="Payment history"
        description={
          data
            ? `${data.total.toLocaleString()} payment${data.total === 1 ? "" : "s"} total`
            : "Loading…"
        }
      />

      {/* Open disputes — renders nothing when there are none */}
      <DisputePanel disputes={data?.openDisputes ?? []} now={loadedAt} />

      {/* Filter row */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        {/* Status tabs. §4a.7: they wrap rather than hide behind a scrollbar. */}
        <div
          className="flex flex-wrap gap-1 rounded-[var(--r-md)] p-1"
          style={{ background: "var(--sf-0)", border: "1px solid var(--bd-default)" }}
        >
          {STATUS_TABS.map((tab) => {
            const active = statusFilter === tab.value;
            return (
              <Button
                key={tab.value}
                size="compact"
                variant={active ? "primary" : "ghost"}
                aria-pressed={active}
                onClick={() => setStatusFilter(tab.value)}
              >
                {tab.label}
              </Button>
            );
          })}
        </div>

        {/* Member search */}
        <div
          className="flex flex-1 items-center gap-2 rounded-[var(--r-md)] px-3 py-2 sm:max-w-xs"
          style={{ background: "var(--sf-0)", border: "1px solid var(--bd-default)" }}
        >
          <Search className="size-4 shrink-0" style={{ color: "var(--tx-4)" }} aria-hidden="true" />
          <input
            type="search"
            placeholder="Search member name…"
            aria-label="Search payments by member name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-tx-4"
            style={{ color: "var(--tx-1)" }}
          />
        </div>
      </div>

      {/* §7: an HTTP error is never an empty state — it gets a retry. */}
      {error ? (
        <ErrorState
          message={error}
          onRetry={() => void fetchPayments(statusFilter, page)}
        />
      ) : (
        // No `overflow-hidden`: it would make this wrapper the table's nearest
        // scroll container and silently kill the sticky <thead>. DataTable
        // rounds its own corner cells instead.
        <div className="sm:rounded-[var(--r-md)] sm:border sm:border-bd-default sm:bg-sf-1">
          <DataTable
            label="Payment history"
            rows={visibleRows}
            rowKey={(row) => row.id}
            columns={columns}
            loading={loading}
            skeletonRows={6}
            empty={
              <EmptyState
                icon={<CreditCard className="size-8 text-tx-4" />}
                title="No payments found"
                hint={
                  search
                    ? "Try a different member name."
                    : statusFilter !== "all"
                      ? "No payments match this status filter."
                      : "Payment records will appear here once charges are processed."
                }
              />
            }
            renderCard={(row) => renderPaymentCard(row, <ViewPaymentsLink row={row} />)}
          />

          {/* Pagination */}
          {data && data.pages > 1 && !loading && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              style={{ borderTop: "1px solid var(--bd-default)" }}
            >
              <p className="text-xs" style={{ color: "var(--tx-3)" }}>
                Page {data.page} of {data.pages} · {data.total} total
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  <ChevronLeft className="size-3.5" aria-hidden="true" />
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={() => setPage((p) => Math.min(data.pages, p + 1))}
                  disabled={page >= data.pages}
                >
                  Next
                  <ChevronRight className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
