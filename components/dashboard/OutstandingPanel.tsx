"use client";

/**
 * The "who owes me" (accounts-receivable) view for the payments hub. Lists every
 * overdue member with their latest failed amount + how long they've been
 * overdue, and lets staff Chase (send a reminder email) or Open the member's
 * payments tab to charge/refund — without digging into each profile.
 */

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { AlertCircle, ArrowRight, Banknote, CheckCircle2, Loader2, Send } from "lucide-react";

import type { OutstandingRow } from "@/lib/billing";
import RecordPaymentModal from "@/components/dashboard/RecordPaymentModal";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { useToast } from "@/components/ui/Toast";

type ApiResponse = { rows: OutstandingRow[]; total: number; totalPence: number };

function formatAmount(pence: number | null): string {
  if (pence == null) return "—";
  return `£${(pence / 100).toFixed(2)}`;
}

function overdueLabel(days: number | null): string {
  if (days == null) return "Overdue";
  if (days <= 0) return "Failed today";
  if (days === 1) return "1 day overdue";
  return `${days} days overdue`;
}

export default function OutstandingPanel() {
  const { toast } = useToast();
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chasing, setChasing] = useState<string | null>(null);
  const [chased, setChased] = useState<Set<string>>(new Set());
  const [recordFor, setRecordFor] = useState<OutstandingRow | null>(null);

  function handleRecorded(memberId: string) {
    // A recorded payment flips the member to paid, so drop them from the AR list.
    setData((prev) => {
      if (!prev) return prev;
      const rows = prev.rows.filter((r) => r.memberId !== memberId);
      return { rows, total: rows.length, totalPence: rows.reduce((s, r) => s + (r.amountPence ?? 0), 0) };
    });
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

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<CheckCircle2 className="size-8" style={{ color: "var(--hue-success)" }} />}
        title="Nobody owes you right now"
        hint="Every active member is up to date. Failed and overdue payments appear here."
      />
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
        <div>
          <p className="text-2xl font-bold leading-none" style={{ color: "var(--tx-1)" }}>{formatAmount(data?.totalPence ?? 0)}</p>
          <p className="mt-1 text-xs" style={{ color: "var(--tx-3)" }}>
            outstanding across {rows.length} member{rows.length === 1 ? "" : "s"} (known failed amounts)
          </p>
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
                  {r.membershipType ?? "Ad-hoc"}{r.reason ? ` · ${r.reason}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-4">
                <div className="text-right">
                  <p className="text-sm font-semibold tabular-nums" style={{ color: "var(--tx-1)" }}>{formatAmount(r.amountPence)}</p>
                  {/* Ink, not the raw hue: this is 11px text on the card surface,
                      where --hue-danger measures 3.76:1 and fails the §7 floor. */}
                  <p className="text-[11px]" style={{ color: "var(--hue-danger-ink)" }}>{overdueLabel(r.daysOverdue)}</p>
                </div>
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={() => chase(r.memberId)}
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
