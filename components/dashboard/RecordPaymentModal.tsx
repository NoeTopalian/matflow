"use client";

/**
 * Record a payment taken OUTSIDE Stripe (cash at the desk, bank transfer, comp,
 * etc.) straight from the payments hub — without opening the member's profile.
 * Posts to the existing /api/payments/manual route (creates a succeeded Payment
 * + flips the member to paid). If `member` is supplied the picker is skipped
 * (used by the Outstanding rows); otherwise it offers a member-search typeahead.
 *
 * Built on the `Dialog` primitive (UI-RULES §4a.3) rather than a hand-rolled
 * pair of fixed full-screen layers. That is not a cosmetic swap: the hand-rolled
 * version had no focus trap, no Escape handler, no scroll lock and no focus
 * restoration, so a keyboard user could tab straight out of an open payment form
 * into the page behind it. All four come from the primitive for free.
 */

import { useState, useEffect, useRef } from "react";
import { Search, Loader2, CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { MANUAL_PAYMENT_METHODS, isFreeMethod, manualPaymentFormIsValid } from "@/lib/payment-methods";

type PickedMember = { id: string; name: string };

// Shared with the route that validates it and the member-profile drawer that
// offers it — this file used to keep its own copy of the same five while the
// profile posted a sixth that did not exist.
const METHODS = MANUAL_PAYMENT_METHODS;

interface Props {
  open: boolean;
  onClose: () => void;
  onRecorded?: (memberId: string) => void;
  member?: PickedMember | null;
  suggestedAmountPence?: number | null;
}

export default function RecordPaymentModal({ open, onClose, onRecorded, member, suggestedAmountPence }: Props) {
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
  // Held across retries of the SAME payment and re-minted for a different
  // one, so a club can still legitimately take two identical £40s in a day
  // while a double-submit of one of them cannot become two rows. The server
  // enforces it — a client guard cannot see the other till.
  const attemptRef = useRef<{ key: string; sig: string } | null>(null);

  // Latest `member` without making it a dependency — see below.
  const memberRef = useRef(member);
  memberRef.current = member;

  /**
   * Reset when (re)opened, or when this is genuinely a DIFFERENT member.
   *
   * The dependency is `member?.id`, not `member`. That distinction is the whole
   * fix: every caller builds the prop inline —
   *
   *     member={recordFor ? { id: recordFor.memberId, name: recordFor.memberName } : null}
   *
   * — so `member` is a brand-new object on every render of the parent, and an
   * effect keyed on it re-ran on every parent render and wiped the form. Not
   * theoretically: `ToastProvider` passes `value={{ toast }}`, also a fresh
   * object each render, so ANY toast appearing or auto-dismissing anywhere in
   * the dashboard re-rendered every `useToast()` consumer — this modal's parent
   * among them. A staff member half-way through typing an amount watched it
   * reset to blank, on the money path, for a reason nothing on screen explained.
   *
   * Found by an e2e test whose filled fields came back empty in the failure
   * screenshot. No unit test could have seen it: it needs a real parent
   * re-rendering underneath a real open dialog.
   */
  useEffect(() => {
    if (!open) return;
    setPicked(memberRef.current ?? null);
    setQ("");
    setResults([]);
    setAmount(suggestedAmountPence != null ? (suggestedAmountPence / 100).toFixed(2) : "");
    setMethod("cash");
    setNotes("");
    setError(null);
    setDone(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the
    // member's IDENTITY, not the object's reference; `memberRef` supplies the
    // value. Adding `member` here is the bug this comment exists to prevent.
  }, [open, member?.id, suggestedAmountPence]);

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

  const isFree = isFreeMethod(method);
  const amountPence = Math.round((parseFloat(amount) || 0) * 100);
  // Same predicate the member-profile drawer and the route use, so the three
  // cannot drift apart again.
  const canSubmit =
    !!picked &&
    !submitting &&
    manualPaymentFormIsValid({ description: notes, amount, method });

  async function submit() {
    if (!picked) return;
    const sig = `${picked.id}|${amountPence}|${method}|${notes.trim()}`;
    const held = attemptRef.current;
    const requestId = held && held.sig === sig ? held.key : crypto.randomUUID();
    attemptRef.current = { key: requestId, sig };
    if (!picked) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/payments/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: picked.id, amountPence, method, notes: notes.trim() || undefined, requestId }),
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

  const fieldClass = "w-full rounded-[var(--r-md)] border bg-transparent px-3 py-2 text-sm outline-none";
  const fieldStyle = { borderColor: "var(--bd-default)", color: "var(--tx-1)" };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Record a payment"
      footer={
        done ? undefined : (
          <Button className="w-full" onClick={submit} disabled={!canSubmit} loading={submitting}>
            {submitting ? "Recording…" : "Record payment"}
          </Button>
        )
      }
    >
      <div className="space-y-4">
        {done ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <CheckCircle2 className="size-9" style={{ color: "var(--hue-success)" }} aria-hidden="true" />
            <p className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>Payment recorded</p>
          </div>
        ) : (
          <>
            {/* Member */}
            {picked ? (
              <div
                className="flex items-center justify-between gap-2 rounded-[var(--r-md)] border px-3 py-2.5"
                style={{ borderColor: "var(--bd-default)" }}
              >
                <span className="text-sm font-medium" style={{ color: "var(--tx-1)" }}>{picked.name}</span>
                {!member && (
                  <Button variant="ghost" size="compact" onClick={() => setPicked(null)}>
                    Change
                  </Button>
                )}
              </div>
            ) : (
              <div>
                <div
                  className="flex items-center gap-2 rounded-[var(--r-md)] border px-3 py-2"
                  style={{ borderColor: "var(--bd-default)" }}
                >
                  <Search className="size-4 shrink-0" style={{ color: "var(--tx-4)" }} aria-hidden="true" />
                  <input
                    autoFocus
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search member by name…"
                    aria-label="Search for a member by name"
                    className="flex-1 bg-transparent text-sm outline-none"
                    style={{ color: "var(--tx-1)" }}
                  />
                  {searching && <Loader2 className="size-3.5 animate-spin" style={{ color: "var(--tx-4)" }} aria-hidden="true" />}
                </div>
                {results.length > 0 && (
                  <div
                    className="mt-1 overflow-hidden rounded-[var(--r-md)] border"
                    style={{ borderColor: "var(--bd-default)" }}
                  >
                    {results.map((m) => (
                      <Button
                        key={m.id}
                        variant="ghost"
                        className="w-full justify-start rounded-none"
                        onClick={() => { setPicked(m); setQ(""); setResults([]); }}
                      >
                        {m.name}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Amount */}
            <div>
              <label htmlFor="record-payment-amount" className="mb-1 block text-xs font-medium" style={{ color: "var(--tx-3)" }}>
                Amount (£){isFree ? " — optional for comp/exempt" : ""}
              </label>
              <input
                id="record-payment-amount"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className={fieldClass}
                style={fieldStyle}
              />
            </div>

            {/* Method */}
            <div>
              <label htmlFor="record-payment-method" className="mb-1 block text-xs font-medium" style={{ color: "var(--tx-3)" }}>
                Method
              </label>
              <select
                id="record-payment-method"
                value={method}
                onChange={(e) => setMethod(e.target.value as typeof method)}
                className={fieldClass}
                style={fieldStyle}
              >
                {/* The option list is painted by the OS, not the page, so it takes
                    the platform's own colours — no token reaches inside it. */}
                {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>

            {/* Notes */}
            <div>
              <label htmlFor="record-payment-notes" className="mb-1 block text-xs font-medium" style={{ color: "var(--tx-3)" }}>
                Notes{method === "other" ? " (required)" : " (optional)"}
              </label>
              <input
                id="record-payment-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. paid cash at the desk"
                maxLength={500}
                className={fieldClass}
                style={fieldStyle}
              />
            </div>

            {error && (
              <p role="alert" className="text-xs" style={{ color: "var(--hue-danger-ink)" }}>{error}</p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
