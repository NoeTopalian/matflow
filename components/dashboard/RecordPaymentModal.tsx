"use client";

/**
 * Record a payment taken OUTSIDE Stripe (cash at the desk, bank transfer, comp,
 * etc.) straight from the payments hub — without opening the member's profile.
 * Posts to the existing /api/payments/manual route (creates a succeeded Payment
 * + flips the member to paid). If `member` is supplied the picker is skipped
 * (used by the Outstanding rows); otherwise it offers a member-search typeahead.
 */

import { useState, useEffect, useRef } from "react";
import { X, Search, Loader2, CheckCircle2 } from "lucide-react";

type PickedMember = { id: string; name: string };

const METHODS = [
  { value: "cash", label: "Cash" },
  { value: "external", label: "Bank transfer / external" },
  { value: "comp", label: "Comp (free)" },
  { value: "exempt", label: "Exempt" },
  { value: "other", label: "Other" },
] as const;

interface Props {
  open: boolean;
  onClose: () => void;
  onRecorded?: (memberId: string) => void;
  member?: PickedMember | null;
  suggestedAmountPence?: number | null;
  primaryColor?: string;
}

export default function RecordPaymentModal({ open, onClose, onRecorded, member, suggestedAmountPence, primaryColor = "#3b82f6" }: Props) {
  const [picked, setPicked] = useState<PickedMember | null>(member ?? null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PickedMember[]>([]);
  const [searching, setSearching] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<(typeof METHODS)[number]["value"]>("cash");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset when (re)opened.
  useEffect(() => {
    if (open) {
      setPicked(member ?? null);
      setQ("");
      setResults([]);
      setAmount(suggestedAmountPence != null ? (suggestedAmountPence / 100).toFixed(2) : "");
      setMethod("cash");
      setNotes("");
      setError(null);
      setDone(false);
    }
  }, [open, member, suggestedAmountPence]);

  // Debounced member search (only when no member is pre-selected).
  useEffect(() => {
    if (picked || !q.trim()) { setResults([]); return; }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/members?search=${encodeURIComponent(q.trim())}&take=8`);
        if (res.ok) {
          const json = await res.json();
          const list = (json.members ?? json.items ?? json ?? []) as { id: string; name: string }[];
          setResults(Array.isArray(list) ? list.map((m) => ({ id: m.id, name: m.name })) : []);
        }
      } catch { /* ignore */ } finally { setSearching(false); }
    }, 250);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [q, picked]);

  if (!open) return null;

  const isFree = method === "comp" || method === "exempt";
  const amountPence = Math.round((parseFloat(amount) || 0) * 100);
  const canSubmit =
    !!picked &&
    (isFree || amountPence >= 1) &&
    (method !== "other" || notes.trim().length > 0) &&
    !submitting;

  async function submit() {
    if (!picked) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/payments/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: picked.id, amountPence, method, notes: notes.trim() || undefined }),
      });
      if (res.ok) {
        setDone(true);
        onRecorded?.(picked.id);
        setTimeout(onClose, 700);
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Couldn't record the payment.");
      }
    } catch {
      setError("Couldn't record the payment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="w-full max-w-md rounded-2xl border shadow-2xl pointer-events-auto"
          style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)" }}
        >
          <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "var(--bd-default)" }}>
            <h2 className="text-base font-semibold" style={{ color: "var(--tx-1)" }}>Record a payment</h2>
            <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ color: "var(--tx-3)" }} aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-5 space-y-4">
            {done ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center">
                <CheckCircle2 className="w-9 h-9" style={{ color: "#22c55e" }} />
                <p className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>Payment recorded</p>
              </div>
            ) : (
              <>
                {/* Member */}
                {picked ? (
                  <div className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5" style={{ borderColor: "var(--bd-default)" }}>
                    <span className="text-sm font-medium" style={{ color: "var(--tx-1)" }}>{picked.name}</span>
                    {!member && (
                      <button onClick={() => setPicked(null)} className="text-xs" style={{ color: "var(--tx-3)" }}>Change</button>
                    )}
                  </div>
                ) : (
                  <div>
                    <div className="flex items-center gap-2 px-3 py-2 rounded-xl border" style={{ borderColor: "var(--bd-default)" }}>
                      <Search className="w-4 h-4 shrink-0" style={{ color: "var(--tx-4)" }} />
                      <input
                        autoFocus
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search member by name…"
                        className="flex-1 bg-transparent text-sm outline-none"
                        style={{ color: "var(--tx-1)" }}
                      />
                      {searching && <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: "var(--tx-4)" }} />}
                    </div>
                    {results.length > 0 && (
                      <div className="mt-1 rounded-xl border overflow-hidden" style={{ borderColor: "var(--bd-default)" }}>
                        {results.map((m) => (
                          <button key={m.id} onClick={() => { setPicked(m); setQ(""); setResults([]); }} className="w-full text-left px-3 py-2 text-sm hover:bg-white/5" style={{ color: "var(--tx-1)" }}>
                            {m.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Amount */}
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: "var(--tx-3)" }}>Amount (£){isFree ? " — optional for comp/exempt" : ""}</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2 rounded-xl border bg-transparent text-sm outline-none"
                    style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
                  />
                </div>

                {/* Method */}
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: "var(--tx-3)" }}>Method</label>
                  <select
                    value={method}
                    onChange={(e) => setMethod(e.target.value as typeof method)}
                    className="w-full px-3 py-2 rounded-xl border bg-transparent text-sm outline-none"
                    style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
                  >
                    {METHODS.map((m) => <option key={m.value} value={m.value} style={{ color: "#000" }}>{m.label}</option>)}
                  </select>
                </div>

                {/* Notes */}
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: "var(--tx-3)" }}>Notes{method === "other" ? " (required)" : " (optional)"}</label>
                  <input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="e.g. paid cash at the desk"
                    maxLength={500}
                    className="w-full px-3 py-2 rounded-xl border bg-transparent text-sm outline-none"
                    style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
                  />
                </div>

                {error && <p className="text-xs" style={{ color: "#ef4444" }}>{error}</p>}

                <button
                  onClick={submit}
                  disabled={!canSubmit}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                  style={{ background: primaryColor }}
                >
                  {submitting ? "Recording…" : "Record payment"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
