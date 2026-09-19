"use client";

/**
 * The client half of /dashboard/payments — full payment history for the tenant,
 * with the "who owes me" panel above it.
 *
 * Fetches paginated payment records from GET /api/payments with status filter
 * and member-name search (client-side on the loaded page).
 *
 * THE GATE LIVES IN app/dashboard/payments/page.tsx, not here. The previous
 * comment claimed "the API enforces requireOwner() so any direct URL hit by
 * non-owners gets a redirect from the server" — which described the API, not
 * this page. The page had no server-side gate at all, so a coach opening the
 * URL got the whole payments screen and merely empty data. Money screens must
 * refuse, not render blank.
 *
 * The table is the shared `DataTable` primitive driven by the column
 * definitions in `payments-columns.tsx` — the same ones the Settings → Revenue
 * panel uses — so the two surfaces cannot drift again, and the primitive's
 * card-collapse gives this page the mobile layout it never had (§9).
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, CreditCard, Loader2, Plus, Search, ShoppingBag } from "lucide-react";

import OutstandingPanel from "@/components/dashboard/OutstandingPanel";
import RecordPaymentModal from "@/components/dashboard/RecordPaymentModal";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/page-header";
import { useToast } from "@/components/ui/Toast";
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

// ─── Desk orders (X-6 K13) ────────────────────────────────────────────────────

type DeskOrderItem = { name: string; quantity: number; price: number };
type DeskOrderRow = {
  id: string;
  orderRef: string;
  memberId: string | null;
  memberName: string | null;
  items: DeskOrderItem[];
  totalPence: number;
  currency: string;
  createdAt: string;
};
type DeskOrdersResponse = {
  orders: DeskOrderRow[];
  total: number;
  totalPence: number;
  truncated: boolean;
};

function currencySymbol(code: string | null): string {
  const c = code?.toUpperCase();
  return c === "EUR" ? "€" : c === "USD" ? "$" : "£";
}

/**
 * `now` is the reading taken when the payload landed, not one taken in the
 * render body — the same rule DisputePanel follows, and for the same reason: a
 * `Date.now()` in render makes the component impure and lets an SSR reading and
 * a client reading disagree about how long a member has been waiting.
 */
function waitedLabel(iso: string, now: number | null): string {
  if (now === null) return "";
  const mins = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * The till's queue: every pay-at-desk shop order still waiting to be collected.
 *
 * Why this exists. A member checks out on the pay-at-desk rail, the product
 * tells them "show this to staff at the front desk", and until now there was no
 * screen anywhere that listed those orders — while
 * POST /api/orders/[id]/mark-paid sat gated, tenant-scoped and idempotent with
 * zero callers. The shop advertised something the dashboard could not finish.
 *
 * What it deliberately does NOT claim. Settling an order flips the Order row
 * and writes an `order.mark_paid` audit entry. It does not mint a Payment, so
 * the amount does not appear in payment history or the revenue reports — the
 * card rail does mint one (the Stripe webhook), so the two rails disagree. The
 * hint below says so rather than letting an owner infer otherwise, and staff
 * who want it in the books can Record payment above.
 */
function DeskOrdersPanel({ onCountChange }: { onCountChange: (n: number | null) => void }) {
  const { toast } = useToast();
  const [data, setData] = useState<DeskOrdersResponse | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settling, setSettling] = useState<DeskOrderRow | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/payments/desk-orders");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: DeskOrdersResponse = await res.json();
      setData(json);
      setLoadedAt(Date.now());
      onCountChange(json.total);
    } catch (err) {
      console.error("[desk orders] fetch failed", err);
      // §7: an HTTP error is never an empty state. "No orders waiting" on a
      // failed fetch is the one lie this screen must never tell — a member is
      // standing at the desk holding a reference.
      setError("Couldn't load the orders waiting at the desk");
      onCountChange(null);
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => { void load(); }, [load]);

  function openSettle(row: DeskOrderRow) {
    setSettling(row);
    setReason("");
    setFormError(null);
  }

  async function settle() {
    if (!settling) return;
    const trimmed = reason.trim();
    // The route requires 3..200 characters; say so here rather than letting the
    // desk press a button that answers 400.
    if (trimmed.length < 3) {
      setFormError("Say how it was paid — at least 3 characters.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch(`/api/orders/${settling.id}/mark-paid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: trimmed }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setFormError(j.error ?? `Couldn't settle this order (HTTP ${res.status}).`);
        return;
      }
      const settledId = settling.id;
      setData((prev) => {
        if (!prev) return prev;
        const orders = prev.orders.filter((o) => o.id !== settledId);
        const next = {
          ...prev,
          orders,
          total: orders.length,
          totalPence: orders.reduce((s, o) => s + o.totalPence, 0),
        };
        onCountChange(next.total);
        return next;
      });
      setSettling(null);
      toast(`Order ${settling.orderRef} marked paid.`, "success");
    } catch {
      setFormError("Couldn't settle this order — check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div
        className="flex items-center justify-center gap-2 rounded-[var(--r-md)] border p-12"
        style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)", color: "var(--tx-3)" }}
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading desk orders…
      </div>
    );
  }

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  const rows = data?.orders ?? [];

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<ShoppingBag className="size-8 text-tx-4" />}
        title="Nothing waiting at the desk"
        hint="Shop orders a member chose to pay for at the desk appear here until you collect the money."
      />
    );
  }

  return (
    <>
      <div
        className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-md)] border px-4 py-3"
        style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
      >
        <p className="text-sm" style={{ color: "var(--tx-2)" }}>
          <span className="font-semibold" style={{ color: "var(--tx-1)" }}>
            {rows.length} order{rows.length === 1 ? "" : "s"}
          </span>{" "}
          waiting · {currencySymbol(rows[0]?.currency ?? null)}
          {((data?.totalPence ?? 0) / 100).toFixed(2)} to collect
        </p>
        <Button variant="ghost" size="compact" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      <ul className="space-y-2" aria-label="Orders waiting at the desk">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-col gap-3 rounded-[var(--r-md)] border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>
                  {row.memberId && row.memberName ? (
                    <Link
                      href={`/dashboard/members/${row.memberId}`}
                      className="underline underline-offset-2 hover:no-underline"
                    >
                      {row.memberName}
                    </Link>
                  ) : (
                    // Order.memberId is nullable and the relation is SetNull, so
                    // an order really can outlive its member. Say that, rather
                    // than inventing a name.
                    (row.memberName ?? "Member no longer on the roster")
                  )}
                </span>
                <span className="font-mono text-xs" style={{ color: "var(--tx-3)" }}>
                  {row.orderRef}
                </span>
                <span className="text-xs" style={{ color: "var(--tx-3)" }}>
                  {waitedLabel(row.createdAt, loadedAt)}
                </span>
              </div>
              <p className="mt-0.5 truncate text-xs" style={{ color: "var(--tx-2)" }}>
                {row.items.length === 0
                  ? "Item list unavailable — the total below is the amount due"
                  : row.items.map((i) => `${i.quantity} × ${i.name}`).join(", ")}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-sm font-semibold tabular-nums" style={{ color: "var(--tx-1)" }}>
                {currencySymbol(row.currency)}
                {(row.totalPence / 100).toFixed(2)}
              </span>
              <Button variant="primary" size="compact" onClick={() => openSettle(row)}>
                Mark paid
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {data?.truncated ? (
        <p className="mt-3 text-xs" style={{ color: "var(--tx-3)" }}>
          Showing the 200 oldest orders. Settle some to see the rest.
        </p>
      ) : null}

      <p className="mt-3 text-xs" style={{ color: "var(--tx-3)" }}>
        Marking an order paid closes it and records who collected the money. It does not add a row to
        payment history — use Record payment for that.
      </p>

      <Dialog
        open={settling !== null}
        onClose={() => setSettling(null)}
        title="Mark this order paid"
        description={
          settling
            ? `${settling.orderRef} · ${currencySymbol(settling.currency)}${(settling.totalPence / 100).toFixed(2)}`
            : undefined
        }
        footer={
          <Button className="w-full" onClick={() => void settle()} loading={submitting}>
            {submitting ? "Marking paid…" : "Mark paid"}
          </Button>
        }
      >
        <div className="space-y-3">
          <div>
            <label
              htmlFor="desk-order-reason"
              className="mb-1 block text-xs font-medium"
              style={{ color: "var(--tx-3)" }}
            >
              How was it paid?
            </label>
            <input
              id="desk-order-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. cash at the desk, receipt 4123"
              maxLength={200}
              className="w-full rounded-[var(--r-md)] border bg-transparent px-3 py-2 text-sm outline-none"
              style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
            />
            <p className="mt-1 text-xs" style={{ color: "var(--tx-3)" }}>
              Saved to the audit trail so the till can be reconciled later.
            </p>
          </div>
          {formError ? (
            <p role="alert" className="text-xs" style={{ color: "var(--hue-danger-ink)" }}>
              {formError}
            </p>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function PaymentsPageClient() {
  // The hub leads with "who owes me" (outstanding); the desk queue and full
  // history follow.
  const [view, setView] = useState<"outstanding" | "desk" | "history">("outstanding");
  // Null until the desk panel has loaded once, and back to null if its fetch
  // fails — a "0" badge on a failed load would tell the desk nobody is waiting.
  const [deskCount, setDeskCount] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | PaymentStatus>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ApiResponse | null>(null);
  // Clock reading taken when `data` landed — drives the dispute countdown.
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);

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

  // The desk badge has to be right BEFORE anyone opens the desk tab — a queue
  // nobody looks at is the state this whole surface exists to end. One cheap
  // read on mount seeds it; the panel keeps it current once it is open. A
  // failure leaves it null, so the tab says nothing rather than saying zero.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/payments/desk-orders");
        if (!res.ok) return;
        const json = (await res.json()) as { total?: number };
        if (!cancelled && typeof json.total === "number") setDeskCount(json.total);
      } catch {
        // Silent: the tab simply carries no badge. The panel itself shows the
        // error with a retry when it is opened.
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
        action={
          <Button variant="primary" size="compact" onClick={() => setRecordOpen(true)}>
            <Plus className="size-3.5" aria-hidden="true" />
            Record payment
          </Button>
        }
      />

      {/* Open disputes — renders nothing when there are none. Sits ABOVE the
          view tabs deliberately: an unanswered dispute is lost automatically
          along with a fee, so it must never be hidden behind a tab. */}
      <DisputePanel disputes={data?.openDisputes ?? []} now={loadedAt} />

      {/* Top-level view tabs: who-owes (default) vs full history */}
      <div
        className="mb-4 flex w-fit gap-1 rounded-[var(--r-md)] p-1"
        style={{ background: "var(--sf-0)", border: "1px solid var(--bd-default)" }}
      >
        {([
          { value: "outstanding", label: "Outstanding" },
          { value: "desk", label: "At the desk" },
          { value: "history", label: "All payments" },
        ] as const).map((t) => {
          const active = view === t.value;
          return (
            <Button
              key={t.value}
              size="compact"
              variant={active ? "primary" : "ghost"}
              aria-pressed={active}
              onClick={() => setView(t.value)}
            >
              {t.label}
              {t.value === "desk" && deskCount !== null && deskCount > 0 ? (
                <span
                  className="ml-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums"
                  style={{ background: "var(--sf-2)", color: "var(--tx-1)" }}
                >
                  {deskCount}
                </span>
              ) : null}
            </Button>
          );
        })}
      </div>

      {view === "outstanding" ? (
        <OutstandingPanel />
      ) : view === "desk" ? (
        <DeskOrdersPanel onCountChange={setDeskCount} />
      ) : (
        <>
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
        </>
      )}

      <RecordPaymentModal
        open={recordOpen}
        onClose={() => setRecordOpen(false)}
        onRecorded={() => {
          if (view === "history") void fetchPayments(statusFilter, page);
        }}
      />
    </div>
  );
}
