"use client";

/**
 * The "who owes me" (accounts-receivable) view for the payments hub. Lists every
 * overdue member with their latest failed amount + how long they've been
 * overdue, and lets staff Chase (send a reminder email) or Open the member's
 * payments tab to charge/refund — without digging into each profile.
 */

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { AlertCircle, ArrowRight, CheckCircle2, Loader2, Send } from "lucide-react";
import type { OutstandingRow } from "@/lib/billing";

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
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chasing, setChasing] = useState<string | null>(null);
  const [chased, setChased] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/payments/outstanding");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (err) {
      console.error("[outstanding] fetch failed", err);
      setError("Failed to load outstanding payments. Please refresh.");
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
        alert(j.error ?? "Couldn't send the reminder.");
      }
    } catch {
      alert("Couldn't send the reminder.");
    } finally {
      setChasing(null);
    }
  }

  if (loading) {
    return (
      <div className="rounded-2xl border p-12 flex items-center justify-center gap-2" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)", color: "var(--tx-3)" }}>
        <Loader2 className="w-4 h-4 animate-spin" /> Loading outstanding…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-2xl border p-12 text-center" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)", color: "var(--tx-3)" }}>
        <p className="text-sm">{error}</p>
      </div>
    );
  }

  const rows = data?.rows ?? [];

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border p-16 flex flex-col items-center gap-2 text-center" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
        <CheckCircle2 className="w-10 h-10" style={{ color: "#22c55e" }} />
        <p className="text-base font-semibold" style={{ color: "var(--tx-1)" }}>Nobody owes you right now</p>
        <p className="text-sm" style={{ color: "var(--tx-3)" }}>Every active member is up to date.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border px-5 py-4" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: "rgba(239,68,68,0.12)", color: "#ef4444" }}>
          <AlertCircle className="w-5 h-5" />
        </div>
        <div>
          <p className="text-2xl font-bold leading-none" style={{ color: "var(--tx-1)" }}>{formatAmount(data?.totalPence ?? 0)}</p>
          <p className="text-xs mt-1" style={{ color: "var(--tx-3)" }}>
            outstanding across {rows.length} member{rows.length === 1 ? "" : "s"} (known failed amounts)
          </p>
        </div>
      </div>

      {/* Rows */}
      <div className="rounded-2xl border overflow-hidden" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
        {rows.map((r) => {
          const isChased = chased.has(r.memberId);
          return (
            <div key={r.memberId} className="flex items-center justify-between gap-3 px-4 py-3.5" style={{ borderBottom: "1px solid var(--bd-default)" }}>
              <div className="min-w-0">
                <Link href={`/dashboard/members/${r.memberId}?tab=payments`} className="text-sm font-semibold hover:underline truncate block" style={{ color: "var(--tx-1)" }}>
                  {r.memberName}
                </Link>
                <p className="text-xs mt-0.5 truncate" style={{ color: "var(--tx-3)" }}>
                  {r.membershipType ?? "Ad-hoc"}{r.reason ? ` · ${r.reason}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <div className="text-right">
                  <p className="text-sm font-semibold tabular-nums" style={{ color: "var(--tx-1)" }}>{formatAmount(r.amountPence)}</p>
                  <p className="text-[11px]" style={{ color: "#ef4444" }}>{overdueLabel(r.daysOverdue)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => chase(r.memberId)}
                  disabled={chasing === r.memberId || isChased}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg border transition-colors hover:bg-black/5 disabled:opacity-50"
                  style={{ borderColor: "var(--bd-default)", color: isChased ? "#22c55e" : "var(--tx-2)" }}
                >
                  {isChased ? (
                    <><CheckCircle2 className="w-3.5 h-3.5" /> Reminded</>
                  ) : chasing === r.memberId ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Sending…</>
                  ) : (
                    <><Send className="w-3.5 h-3.5" /> Chase</>
                  )}
                </button>
                <Link
                  href={`/dashboard/members/${r.memberId}?tab=payments`}
                  className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg text-white transition-opacity hover:opacity-90"
                  style={{ background: "#ef4444" }}
                >
                  Open <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
