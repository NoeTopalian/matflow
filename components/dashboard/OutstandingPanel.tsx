"use client";

/**
 * The "who owes me" (accounts-receivable) view for the payments hub. Lists every
 * overdue member with their latest failed amount + how long they've been
 * overdue, and lets staff Chase (send a reminder email) or Open the member's
 * payments tab to charge/refund — without digging into each profile.
 *
 * Rows are PAYERS (review L2): a parent or guardian account that owes is
 * listed and counted, and the summary says how many there are.
 */

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { AlertCircle, ArrowRight, Banknote, CheckCircle2, Loader2, Send } from "lucide-react";

import { NO_PAYMENT_YET_REASON, outstandingPayerSummary, type OutstandingRow } from "@/lib/billing";
import RecordPaymentModal from "@/components/dashboard/RecordPaymentModal";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CHASE_ELSEWHERE_NOTE, isBilledElsewhere } from "@/lib/billing-source";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { useToast } from "@/components/ui/Toast";
import { OTHER_OWING_COPY, otherAccountsOwingLine } from "@/lib/member-population";
import type { OtherOwingRow } from "@/lib/other-accounts-owing";

/** `otherOwing` (D9): inactive or cancelled accounts that still owe — listed, never chased, not in the totals. */
type ApiResponse = { rows: OutstandingRow[]; total: number; totalPence: number; otherOwing?: OtherOwingRow[] };

function formatAmount(pence: number | null): string {
  if (pence == null) return "—";
  return `£${(pence / 100).toFixed(2)}`;
}

function overdueLabel(row: Pick<OutstandingRow, "daysOverdue" | "kind">): string {
  if (row.kind === "no_payment_yet") return NO_PAYMENT_YET_REASON;
  const days = row.daysOverdue;
  if (days == null) return "Overdue";
  if (days <= 0) return "Failed today";
  if (days === 1) return "1 day overdue";
  return `${days} days overdue`;
}

/**
 * `onRecorded` tells the Payments page a payment was recorded from a row, so
 * its header totals ("N payments total · Collected today £X") re-read too —
 * they stayed at the old figures until a reload (end-user check, 30 Sep 2026).
 */
export default function OutstandingPanel({ onRecorded }: { onRecorded?: () => void } = {}) {
  const { toast } = useToast();
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chasing, setChasing] = useState<string | null>(null);
  const [chased, setChased] = useState<Set<string>>(new Set());
  const [recordFor, setRecordFor] = useState<OutstandingRow | null>(null);
  // TeamUp bridge: a member TeamUp bills already gets TeamUp's reminders, so
  // the chase asks first and says so (readiness spec v3 §7).
  const [confirmChase, setConfirmChase] = useState<OutstandingRow | null>(null);

  function handleRecorded(memberId: string) {
    // A recorded payment flips the member to paid, so drop them from the AR list.
    setData((prev) => {
      if (!prev) return prev;
      const rows = prev.rows.filter((r) => r.memberId !== memberId);
      return { ...prev, rows, total: rows.length, totalPence: rows.reduce((s, r) => s + (r.amountPence ?? 0), 0) };
    });
    onRecorded?.();
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/payments/outstanding");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (err) {
      console.error("[outstanding] fetch failed", err);
      setError("Couldn't load who owes you");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function chase(memberId: string) {
    setChasing(memberId);
    try {
      const res = await fetch("/api/payments/chase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId }),
      });
      if (res.ok) {
        setChased((prev) => new Set(prev).add(memberId));
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Couldn't send the reminder.", "error");
      }
    } catch {
      toast("Couldn't send the reminder.", "error");
    } finally {
      setChasing(null);
    }
  }

  if (loading) {
    return (
      <div
        className="flex items-center justify-center gap-2 rounded-[var(--r-md)] border p-12"
        style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)", color: "var(--tx-3)" }}
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading outstanding…
      </div>
    );
  }

  // §7: an HTTP error is never an empty state — "nobody owes you" on a failed
  // fetch is the most expensive lie this screen could tell an owner.
  if (error) {
    return <ErrorState message={error} onRetry={() => void load()} />;
  }

  const rows = data?.rows ?? [];
  const summary = outstandingPayerSummary(rows);
  const otherOwing = data?.otherOwing ?? [];
  const otherOwingSection = otherOwing.length > 0 ? <OtherAccountsOwing rows={otherOwing} /> : null;

  if (rows.length === 0) {
    return (
      <div className="space-y-4">
        {/* "Nobody to chase", not "nobody owes": the accounts below still owe (D9). */}
        <EmptyState
          icon={<CheckCircle2 className="size-8" style={{ color: "var(--hue-success)" }} />}
          title={otherOwing.length > 0 ? "Nobody to chase right now" : "Nobody owes you right now"}
          hint="Every active member is up to date. Failed and overdue payments, and members on a plan with no payment yet, appear here."
        />
        {otherOwingSection}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div
        className="flex flex-wrap items-center gap-4 rounded-[var(--r-md)] border px-5 py-4"
        style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
      >
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-[var(--r-md)]"
          style={{
            background: "color-mix(in srgb, var(--hue-danger) 12%, transparent)",
            color: "var(--hue-danger-ink)",
          }}
        >
          <AlertCircle className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="text-2xl font-bold leading-none" style={{ color: "var(--tx-1)" }}>{formatAmount(data?.totalPence ?? 0)}</p>
          {/* Review L2: payers, in the words Reports and the Members tile use. */}
          <p className="mt-1 text-xs text-tx-3" data-testid="outstanding-summary">
            outstanding across {summary.headline} (failed charges, and plan prices for missed due dates and first payments)
          </p>
          <p className="mt-0.5 text-xs text-tx-3" data-testid="outstanding-split">
            {summary.split}. {summary.guardianNote}.
          </p>
          {otherOwing.length > 0 && (
            <p className="mt-0.5 text-xs text-tx-3" data-testid="outstanding-other-owing">
              {otherAccountsOwingLine(otherOwing.length)} — listed below, not in this total.
            </p>
          )}
        </div>
      </div>

      {/* Rows */}
      <div
        className="overflow-hidden rounded-[var(--r-md)] border"
        style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
      >
        {rows.map((r) => {
          const isChased = chased.has(r.memberId);
          return (
            <div key={r.memberId} className="flex items-center justify-between gap-3 px-4 py-3.5" style={{ borderBottom: "1px solid var(--bd-default)" }}>
              <div className="min-w-0">
                <Link href={`/dashboard/members/${r.memberId}?tab=payments`} className="block truncate text-sm font-semibold hover:underline" style={{ color: "var(--tx-1)" }}>
                  {r.memberName}
                </Link>
                <p className="mt-0.5 truncate text-xs" style={{ color: "var(--tx-3)" }}>
                  {r.membershipType ?? "Ad-hoc"}{r.reason && r.reason !== NO_PAYMENT_YET_REASON ? ` · ${r.reason}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-4">
                <div className="text-right">
                  <p className="text-sm font-semibold tabular-nums" style={{ color: "var(--tx-1)" }}>{formatAmount(r.amountPence)}</p>
                  {/* Ink, not the raw hue: this is 11px text on the card surface,
                      where --hue-danger measures 3.76:1 and fails the §7 floor. */}
                  <p className="text-[11px]" style={{ color: r.kind === "no_payment_yet" ? "var(--tx-3)" : "var(--hue-danger-ink)" }}>{overdueLabel(r)}</p>
                </div>
                {/* The chase email is the failed-payment reminder. A member who has
                    simply not paid yet has had nothing fail, so the desk records
                    or opens instead. But a declined FIRST charge is a "No payment
                    yet" row since round-3 M1 and carries its failed charge; this
                    panel is the only place it can be chased, so Chase shows
                    whenever a charge failed (round-4 review L1). */}
                {(r.kind !== "no_payment_yet" || r.amountSource === "failed_charge") && (
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={() => (isBilledElsewhere(r) ? setConfirmChase(r) : void chase(r.memberId))}
                  disabled={chasing === r.memberId || isChased}
                  style={isChased ? { color: "var(--hue-success-ink)" } : undefined}
                >
                  {isChased ? (
                    <><CheckCircle2 className="size-3.5" aria-hidden="true" /> Reminded</>
                  ) : chasing === r.memberId ? (
                    <><Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Sending…</>
                  ) : (
                    <><Send className="size-3.5" aria-hidden="true" /> Chase</>
                  )}
                </Button>
                )}
                <Button variant="secondary" size="compact" onClick={() => setRecordFor(r)}>
                  <Banknote className="size-3.5" aria-hidden="true" /> Record
                </Button>
                {/* The destructive FILL token, not --hue-danger: white on the raw
                    hue is 3.76:1. This pair is the one measured to carry it. */}
                <Link
                  href={`/dashboard/members/${r.memberId}?tab=payments`}
                  className="inline-flex items-center gap-1 rounded-[var(--r-md)] px-2.5 py-1.5 text-xs font-semibold transition-opacity hover:opacity-90"
                  style={{ background: "var(--sf-danger)", color: "var(--tx-on-danger)" }}
                >
                  Open <ArrowRight className="size-3.5" aria-hidden="true" />
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      {otherOwingSection}

      <ConfirmDialog
        open={confirmChase !== null}
        onClose={() => setConfirmChase(null)}
        title={confirmChase ? `Send ${confirmChase.memberName} a payment reminder?` : "Send a payment reminder?"}
        description={CHASE_ELSEWHERE_NOTE}
        confirmLabel="Send reminder"
        onConfirm={() => {
          const r = confirmChase;
          setConfirmChase(null);
          if (r) void chase(r.memberId);
        }}
      />

      <RecordPaymentModal
        open={recordFor !== null}
        onClose={() => setRecordFor(null)}
        member={recordFor ? { id: recordFor.memberId, name: recordFor.memberName } : null}
        suggestedAmountPence={recordFor?.amountPence ?? null}
        onRecorded={(id) => handleRecorded(id)}
      />
    </div>
  );
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * D9 (owner direction, 23 Oct 2026): inactive or cancelled accounts that
 * still owe. Named so the debt is never lost; no Chase button — the club does
 * not chase people who are inactive or have left — and not in the total
 * above. Open leads to the member's payments, where staff can record or
 * refund as for anyone.
 */
function OtherAccountsOwing({ rows }: { rows: OtherOwingRow[] }) {
  return (
    <section
      aria-labelledby="other-owing-heading"
      data-testid="outstanding-other-owing-list"
      className="overflow-hidden rounded-[var(--r-md)] border"
      style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
    >
      <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--bd-default)" }}>
        <h3 id="other-owing-heading" className="text-sm font-semibold text-tx-1">
          {OTHER_OWING_COPY.label} · {rows.length.toLocaleString("en-GB")}
        </h3>
        <p className="mt-0.5 text-xs text-tx-3">{OTHER_OWING_COPY.includes}. {OTHER_OWING_COPY.excludes}.</p>
      </div>
      {rows.map((r) => (
        <div key={r.memberId} className="flex items-center justify-between gap-3 px-4 py-3" style={{ borderBottom: "1px solid var(--bd-default)" }}>
          <div className="min-w-0">
            <Link href={`/dashboard/members/${r.memberId}?tab=payments`} className="block truncate text-sm font-semibold hover:underline" style={{ color: "var(--tx-1)" }}>
              {r.memberName}
            </Link>
            <p className="mt-0.5 truncate text-xs text-tx-3">
              {r.status === "cancelled" ? "Cancelled" : "Inactive"}
              {r.accountType === "parent" ? " · Parent or guardian" : ""}
              {" · "}
              {r.evidence === "failed_charge" && r.failedAt ? `Last charge failed on ${formatDay(r.failedAt)}` : "Marked overdue"}
              {r.reason ? ` · ${r.reason}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <p className="text-sm font-semibold tabular-nums" style={{ color: "var(--tx-1)" }}>{formatAmount(r.amountPence)}</p>
            <Link
              href={`/dashboard/members/${r.memberId}?tab=payments`}
              className="inline-flex items-center gap-1 rounded-[var(--r-md)] border px-2.5 py-1.5 text-xs font-semibold text-tx-1 transition-colors hover:bg-[var(--sf-2)]"
              style={{ borderColor: "var(--bd-default)" }}
            >
              Open <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>
      ))}
    </section>
  );
}
