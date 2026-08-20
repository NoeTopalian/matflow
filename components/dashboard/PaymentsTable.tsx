"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Download, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  currencySymbol,
  formatPaymentAmount,
  paymentAmountColumn,
  paymentDateColumn,
  paymentMemberColumn,
  paymentStatusColumn,
  remainingPence,
  renderPaymentCard,
} from "@/components/dashboard/payments-columns";

/**
 * Settings → Revenue payment history.
 *
 * Shares its columns with /dashboard/payments via `payments-columns.tsx`
 * (§11: one table definition, not two), renders through the `DataTable`
 * primitive so it card-collapses on a phone, and its refund modal is now the
 * `Dialog` primitive — a confirm with two short fields, which is exactly the
 * shape §4a.3 gives Dialog rather than Sheet.
 */

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
  stripeInvoiceId: string | null;
  member: { id: string; name: string; email: string } | null;
};

type SubscriptionAction = "refund_only" | "cancel_at_period_end" | "cancel_now";

const SUBSCRIPTION_ACTIONS: ReadonlyArray<readonly [SubscriptionAction, string]> = [
  ["refund_only", "Refund only — keep the subscription active (they'll be billed again next cycle)"],
  ["cancel_at_period_end", "Refund and cancel at the end of the current period"],
  ["cancel_now", "Refund and cancel immediately"],
];

const STATUS_FILTERS = [
  { value: "", label: "All statuses" },
  { value: "succeeded", label: "Paid" },
  { value: "failed", label: "Failed" },
  { value: "refunded", label: "Refunded" },
  { value: "disputed", label: "Disputed" },
  { value: "pending", label: "Pending" },
];

export default function PaymentsTable({ primaryColor }: { primaryColor: string }) {
  const [rows, setRows] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [refunding, setRefunding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Refund modal state — `target` holds the row being refunded; null = closed.
  const [target, setTarget] = useState<Payment | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [reasonInput, setReasonInput] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  // Subscription payments require an explicit decision; null until chosen.
  const [subAction, setSubAction] = useState<SubscriptionAction | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = filterStatus ? `/api/payments?status=${filterStatus}` : `/api/payments`;
      const res = await fetch(url);
      // §7: a failed request is an error state, never an empty table that
      // tells the owner they have taken no money.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(Array.isArray(data?.payments) ? data.payments : []);
      setLoadError(false);
    } catch {
      setRows([]);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [filterStatus]);

  useEffect(() => { void load(); }, [load]);

  function openRefund(row: Payment) {
    setTarget(row);
    setAmountInput((remainingPence(row) / 100).toFixed(2));
    setReasonInput("");
    setAmountError(null);
    setError(null);
    setSubAction(null);
  }

  function closeRefund() {
    setTarget(null);
    setAmountInput("");
    setReasonInput("");
    setAmountError(null);
    setSubAction(null);
  }

  async function submitRefund() {
    if (!target) return;
    const parsedAmount = Number(amountInput);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setAmountError("Enter a valid amount greater than zero.");
      return;
    }
    const amountPence = Math.round(parsedAmount * 100);
    const remaining = remainingPence(target);
    if (amountPence > remaining) {
      setAmountError(`Amount cannot exceed the ${formatPaymentAmount(remaining, target.currency)} remaining on this charge.`);
      return;
    }
    if (reasonInput.length > 200) {
      setAmountError("Reason must be 200 characters or fewer.");
      return;
    }
    if (target.stripeInvoiceId && !subAction) {
      setAmountError("This is a subscription payment — choose what happens to the subscription below.");
      return;
    }
    setRefunding(target.id);
    setError(null);
    try {
      // Omitting amountPence refunds whatever remains on the charge (the
      // backend derives the remainder), matching the route's semantics.
      const isFullRefund = amountPence === remaining;
      const res = await fetch(`/api/payments/${target.id}/refund`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(isFullRefund ? {} : { amountPence }),
          ...(reasonInput.trim() ? { reason: reasonInput.trim() } : {}),
          ...(target.stripeInvoiceId && subAction ? { subscriptionAction: subAction } : {}),
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

  const refundAction = (row: Payment) =>
    row.status === "succeeded" ? (
      <Button
        variant="secondary"
        size="compact"
        loading={refunding === row.id}
        onClick={(event) => {
          event.stopPropagation();
          openRefund(row);
        }}
      >
        {refunding === row.id ? null : <RotateCcw className="size-3" aria-hidden="true" />}
        Refund
      </Button>
    ) : null;

  // Four shared columns plus this surface's refund action.
  const columns = useMemo<DataTableColumn<Payment>[]>(
    () => [
      paymentDateColumn,
      paymentMemberColumn,
      paymentAmountColumn,
      paymentStatusColumn,
      {
        key: "actions",
        header: "",
        headerLabel: "",
        align: "right",
        width: "7rem",
        cell: (row: Payment) => refundAction(row),
      },
    ],
    // `refundAction` closes over `refunding`, which is the only thing that
    // changes what the cell renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refunding],
  );

  const inputCls =
    "w-full rounded-[var(--r-sm)] border border-bd-default bg-sf-1 px-3 py-2 text-sm text-tx-1 outline-none transition-colors focus:border-bd-active";

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-tx-1">Payment history</h2>
          <p className="mt-0.5 text-xs text-tx-3">
            All Stripe-recorded payments for this gym. Refunds settle from the gym&apos;s Stripe balance.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="payments-status-filter" className="sr-only">
            Filter by status
          </label>
          <select
            id="payments-status-filter"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="h-8 rounded-[var(--r-sm)] border border-bd-default bg-sf-1 px-3 text-[13px] text-tx-1 outline-none"
          >
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <a
            href="/api/payments/export.csv"
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-sm)] border border-bd-default px-3 text-[13px] font-medium text-tx-1 transition-colors hover:border-bd-hover"
          >
            <Download className="size-3.5" aria-hidden="true" />
            Export CSV
          </a>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-3 flex items-start gap-2 rounded-[var(--r-sm)] border px-3 py-2"
          style={{
            borderColor: "color-mix(in srgb, var(--hue-danger) 30%, transparent)",
            background: "color-mix(in srgb, var(--hue-danger) 8%, transparent)",
            color: "var(--hue-danger)",
          }}
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {loadError ? (
        <ErrorState
          message="Couldn't load payments — tap to retry"
          onRetry={() => void load()}
        />
      ) : (
        <DataTable
          label="Payment history"
          rows={rows}
          rowKey={(row) => row.id}
          columns={columns}
          loading={loading}
          empty={
            <EmptyState
              title="No payments yet"
              hint="Stripe events will populate this table automatically."
            />
          }
          renderCard={(row) => renderPaymentCard(row, refundAction(row))}
        />
      )}

      {/* Refund dialog — replaces the prior window.confirm so owners can pick
          partial amounts + capture a reason that lands in the audit log. */}
      <Dialog
        open={target !== null}
        onClose={closeRefund}
        title="Refund payment"
        description={
          target
            ? `${target.member?.name ?? "Unknown member"} · ${formatPaymentAmount(target.amountPence, target.currency)}`
            : undefined
        }
        footer={
          <>
            <Button
              variant="secondary"
              onClick={closeRefund}
              disabled={refunding === target?.id}
            >
              Cancel
            </Button>
            {/* The tenant accent, which is also what the primary variant
                resolves to via --color-primary; the explicit value keeps the
                Settings call site's `primaryColor` prop the source of truth
                until that surface is migrated too. */}
            <Button
              onClick={() => void submitRefund()}
              loading={refunding === target?.id}
              style={{ background: primaryColor }}
            >
              {refunding === target?.id ? null : <RotateCcw className="size-4" aria-hidden="true" />}
              Confirm refund
            </Button>
          </>
        }
      >
        {target ? (
          <div className="space-y-4">
            <div>
              <label htmlFor="refund-amount" className="mb-1 block text-xs font-semibold text-tx-2">
                Amount to refund ({currencySymbol(target.currency)})
              </label>
              <input
                id="refund-amount"
                type="number"
                step="0.01"
                min="0"
                max={(remainingPence(target) / 100).toFixed(2)}
                value={amountInput}
                onChange={(e) => { setAmountInput(e.target.value); setAmountError(null); }}
                aria-describedby="refund-amount-hint"
                aria-invalid={amountError ? true : undefined}
                className={inputCls}
                style={
                  amountError
                    ? { borderColor: "color-mix(in srgb, var(--hue-danger) 45%, transparent)" }
                    : undefined
                }
              />
              <p id="refund-amount-hint" className="mt-1 text-[11px] text-tx-4">
                Max {formatPaymentAmount(remainingPence(target), target.currency)}
                {target.refundedAmountPence ? ` (${formatPaymentAmount(target.refundedAmountPence, target.currency)} already refunded)` : ""}.
                Partial refunds can be repeated until the charge is exhausted.
              </p>
            </div>

            {target.stripeInvoiceId && (
              <fieldset>
                <legend className="mb-1 block text-xs font-semibold text-tx-2">
                  This payment is a subscription invoice — what happens to the subscription?
                </legend>
                <div className="mt-1 space-y-1.5">
                  {SUBSCRIPTION_ACTIONS.map(([value, label]) => (
                    <label key={value} className="flex cursor-pointer items-start gap-2 text-xs text-tx-2">
                      <input
                        type="radio"
                        name="subscription-action"
                        value={value}
                        checked={subAction === value}
                        onChange={() => { setSubAction(value); setAmountError(null); }}
                        className="mt-0.5"
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            <div>
              <label htmlFor="refund-reason" className="mb-1 block text-xs font-semibold text-tx-2">
                Reason (optional, ≤ 200 chars)
              </label>
              <textarea
                id="refund-reason"
                value={reasonInput}
                onChange={(e) => { setReasonInput(e.target.value.slice(0, 200)); setAmountError(null); }}
                placeholder="e.g. Member cancelled before first class · stored in audit log only"
                rows={3}
                className={`${inputCls} resize-y`}
              />
              <p className="mt-1 text-right text-[11px] tabular-nums text-tx-4">
                {reasonInput.length}/200
              </p>
            </div>

            {amountError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-[var(--r-sm)] border px-3 py-2"
                style={{
                  borderColor: "color-mix(in srgb, var(--hue-danger) 30%, transparent)",
                  background: "color-mix(in srgb, var(--hue-danger) 8%, transparent)",
                  color: "var(--hue-danger)",
                }}
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <p className="text-xs">{amountError}</p>
              </div>
            )}

            <p className="text-[11px] text-tx-4">
              Money returns to the member&apos;s card from the gym&apos;s Stripe balance. If this payment funded a class pack, any unredeemed credits will be voided.
            </p>
          </div>
        ) : null}
      </Dialog>
    </Card>
  );
}
