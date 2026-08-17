"use client";

import Link from "next/link";
import type { ComponentType, ReactNode, SVGProps } from "react";
import {
  AlertOctagon,
  CheckCircle2,
  Clock,
  RotateCcw,
  XCircle,
} from "lucide-react";

import { formatDate, formatTime } from "@/lib/date";
import { Card } from "@/components/ui/card";
import type { DataTableColumn } from "@/components/ui/data-table";
import { StatusPill } from "@/components/ui/StatusPill";

/**
 * The one payments table definition (docs/UI-RULES.md §5, §11).
 *
 * Two surfaces render payment rows — `/dashboard/payments` (the owner's full
 * history) and the Settings → Revenue panel (`PaymentsTable`) — and until now
 * each hand-rolled its own `<table>` with its own status colours, its own
 * money formatter and its own date format. The columns live here once; each
 * surface picks the ones it needs and appends its own actions column.
 *
 * The row type is the structural union of what both surfaces fetch: anything
 * a given surface does not select is optional, and the cell renders nothing
 * rather than inventing a value (§7).
 */

export type PaymentStatus =
  | "succeeded"
  | "failed"
  | "refunded"
  | "disputed"
  | "pending";

export interface PaymentColumnRow {
  id: string;
  amountPence: number;
  currency?: string | null;
  status: string;
  description?: string | null;
  createdAt: string;
  paidAt?: string | null;
  refundedAmountPence?: number | null;
  failureReason?: string | null;
  member: {
    id: string;
    name: string;
    email?: string | null;
    membershipType?: string | null;
  } | null;
}

// ── Status ───────────────────────────────────────────────────────────────────

/**
 * §2: hues come from the `--hue-*` tokens, not from per-file hex literals, so
 * a contrast fix is one token edit rather than twenty file edits.
 */
export const PAYMENT_STATUS_META: Record<
  string,
  { label: string; color: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }
> = {
  succeeded: { label: "Paid", color: "var(--hue-success)", Icon: CheckCircle2 },
  failed: { label: "Failed", color: "var(--hue-danger)", Icon: XCircle },
  refunded: { label: "Refunded", color: "var(--tx-3)", Icon: RotateCcw },
  disputed: { label: "Disputed", color: "var(--hue-warning)", Icon: AlertOctagon },
  pending: { label: "Pending", color: "var(--hue-info)", Icon: Clock },
};

export function paymentStatusMeta(status: string) {
  return PAYMENT_STATUS_META[status] ?? PAYMENT_STATUS_META.pending;
}

/** A 14% tint of a token colour — `hex()` cannot take a CSS variable. */
function tint(color: string): string {
  return `color-mix(in srgb, ${color} 14%, transparent)`;
}

export function PaymentStatusPill({ status }: { status: string }) {
  const meta = paymentStatusMeta(status);
  return (
    <StatusPill
      icon={meta.Icon}
      label={meta.label}
      bg={tint(meta.color)}
      color={meta.color}
    />
  );
}

// ── Money ────────────────────────────────────────────────────────────────────

export function currencySymbol(currency?: string | null): string {
  switch ((currency ?? "GBP").toUpperCase()) {
    case "USD":
      return "$";
    case "EUR":
      return "€";
    default:
      return "£";
  }
}

export function formatPaymentAmount(
  pence: number,
  currency?: string | null,
): string {
  return `${currencySymbol(currency)}${(pence / 100).toFixed(2)}`;
}

/** What is still refundable on a charge. */
export function remainingPence(row: PaymentColumnRow): number {
  return row.amountPence - (row.refundedAmountPence ?? 0);
}

/** When the money moved, falling back to when the record was written. */
function paymentDate(row: PaymentColumnRow): string {
  return row.paidAt ?? row.createdAt;
}

// ── Columns ──────────────────────────────────────────────────────────────────

export const paymentDateColumn: DataTableColumn<PaymentColumnRow> = {
  key: "date",
  header: "Date",
  width: "9rem",
  sortValue: (row) => new Date(paymentDate(row)),
  cell: (row) => (
    <div className="flex flex-col gap-0.5">
      <span className="whitespace-nowrap tabular-nums text-tx-2">
        {formatDate(paymentDate(row))}
      </span>
      <span className="whitespace-nowrap tabular-nums text-[11px] text-tx-4">
        {formatTime(paymentDate(row))}
      </span>
    </div>
  ),
};

export const paymentMemberColumn: DataTableColumn<PaymentColumnRow> = {
  key: "member",
  header: "Member",
  sortValue: (row) => row.member?.name ?? "",
  cell: (row) =>
    row.member ? (
      <Link
        href={`/dashboard/members/${row.member.id}`}
        className="block min-w-0 hover:underline"
      >
        <span className="block truncate font-medium text-tx-1">
          {row.member.name}
        </span>
        {row.member.email ? (
          <span className="block truncate text-[11px] text-tx-4">
            {row.member.email}
          </span>
        ) : null}
      </Link>
    ) : (
      <span className="text-tx-4">Unknown</span>
    ),
};

export const paymentTypeColumn: DataTableColumn<PaymentColumnRow> = {
  key: "type",
  header: "Type",
  width: "10rem",
  sortValue: (row) => row.member?.membershipType ?? "",
  cell: (row) => (
    <span className="text-tx-3">{row.member?.membershipType ?? "Ad-hoc"}</span>
  ),
};

export const paymentAmountColumn: DataTableColumn<PaymentColumnRow> = {
  key: "amount",
  header: "Amount",
  align: "right",
  width: "8rem",
  sortValue: (row) => row.amountPence,
  cell: (row) => (
    <div className="flex flex-col gap-0.5">
      <span className="whitespace-nowrap font-semibold tabular-nums text-tx-1">
        {formatPaymentAmount(row.amountPence, row.currency)}
      </span>
      {row.refundedAmountPence ? (
        <span className="whitespace-nowrap text-[11px] tabular-nums text-tx-4">
          -{formatPaymentAmount(row.refundedAmountPence, row.currency)} refunded
        </span>
      ) : null}
    </div>
  ),
};

export const paymentStatusColumn: DataTableColumn<PaymentColumnRow> = {
  key: "status",
  header: "Status",
  width: "8rem",
  sortValue: (row) => paymentStatusMeta(row.status).label,
  cell: (row) => (
    <div className="flex flex-col gap-1">
      <PaymentStatusPill status={row.status} />
      {row.failureReason && row.status === "failed" ? (
        <span className="text-[11px] text-tx-4">{row.failureReason}</span>
      ) : null}
    </div>
  ),
};

export const paymentDescriptionColumn: DataTableColumn<PaymentColumnRow> = {
  key: "description",
  header: "Description",
  cell: (row) => {
    const text = row.description ?? row.failureReason;
    return text ? (
      <span className="line-clamp-1 text-tx-3" title={text}>
        {text}
      </span>
    ) : (
      <span className="text-tx-4">—</span>
    );
  },
};

// ── Mobile card (§9: the staff dashboard must work at 375px) ─────────────────

/**
 * The card the DataTable renders below `sm:`. Shared so a payment looks the
 * same on a phone whichever surface listed it; `action` is the surface's own
 * row action (refund, view payments…).
 */
export function renderPaymentCard(
  row: PaymentColumnRow,
  action?: ReactNode,
): ReactNode {
  return (
    <Card padding="tight" className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-tx-1">
            {row.member?.name ?? "Unknown member"}
          </p>
          <p className="truncate text-[11px] text-tx-4">
            {formatDate(paymentDate(row))} · {formatTime(paymentDate(row))}
          </p>
        </div>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-tx-1">
          {formatPaymentAmount(row.amountPence, row.currency)}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <PaymentStatusPill status={row.status} />
        {action}
      </div>

      {row.refundedAmountPence ? (
        <p className="text-[11px] tabular-nums text-tx-4">
          {formatPaymentAmount(row.refundedAmountPence, row.currency)} refunded
        </p>
      ) : null}

      {row.description ?? row.failureReason ? (
        <p className="text-[11px] text-tx-3">
          {row.description ?? row.failureReason}
        </p>
      ) : null}
    </Card>
  );
}
