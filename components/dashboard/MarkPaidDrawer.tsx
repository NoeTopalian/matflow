"use client";

import { useId, useRef, useState } from "react";
import { CheckCircle2, Banknote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";

const METHODS: { value: "cash" | "exempt" | "external" | "comp" | "other"; label: string; description: string }[] = [
  { value: "cash", label: "Cash", description: "Collected in person" },
  { value: "exempt", label: "Exempt", description: "Employee, family, free trial" },
  { value: "external", label: "External", description: "Bank transfer / standing order outside Stripe" },
  { value: "comp", label: "Comp", description: "Complimentary / promotional" },
  { value: "other", label: "Other", description: "Anything else (note required)" },
];

export default function MarkPaidDrawer({
  memberId,
  memberName,
  primaryColor,
  onMarked,
}: {
  memberId: string;
  memberName: string;
  primaryColor: string;
  onMarked?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Ties the Sheet footer's submit Button back to the form in the body.
  const formId = useId();
  const [method, setMethod] = useState<typeof METHODS[number]["value"]>("cash");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [paidAt, setPaidAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  // Lane 1 iter-2 L1-I2-V-02 fix: synchronous in-flight guard for submit().
  const submittingRef = useRef(false);

  function reset() {
    setMethod("cash");
    setAmount("");
    setNotes("");
    setPaidAt(new Date().toISOString().slice(0, 10));
    setError(null);
    setSuccess(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Lane 1 iter-2 L1-I2-V-02 [High] fix: synchronous double-fire guard.
    // useState's setSaving(true) is batched; two rapid <form> submits within
    // the same event-loop tick can both pass the `if (saving)` JSX guard
    // before React re-renders. The ref flips in the same tick, so a second
    // entry sees `submittingRef.current === true` and returns immediately.
    if (submittingRef.current) return;
    if (method === "other" && !notes.trim()) {
      setError("Notes are required when method is 'Other'");
      return;
    }
    const pence = method === "exempt" || method === "comp"
      ? 0
      : Math.round(parseFloat(amount || "0") * 100);
    if (pence < 0 || (method !== "exempt" && method !== "comp" && pence === 0)) {
      setError("Enter an amount above £0 (or pick Exempt / Comp for £0).");
      return;
    }
    submittingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/payments/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId,
          amountPence: pence,
          method,
          notes: notes.trim() || undefined,
          paidAt: paidAt ? new Date(paidAt).toISOString() : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to record payment");
      } else {
        setSuccess(true);
        onMarked?.();
        setTimeout(() => { setOpen(false); reset(); }, 900);
      }
    } catch {
      // The `finally` releases `saving` (and with it the close guard), so a
      // throw without this catch left the drawer open, dismissible and silent —
      // indistinguishable from never having pressed the button.
      setError("Couldn't reach the server — check your connection and try again.");
    } finally {
      setSaving(false);
      submittingRef.current = false;
    }
  }

  return (
    <>
      {/* The trigger was white-alpha on white — an invisible border and 55%
          white text on the light staff shell (§4a.5). Button primitive now. */}
      <Button variant="secondary" size="compact" onClick={() => { reset(); setOpen(true); }}>
        <Banknote className="size-3.5" />
        Mark paid manually
      </Button>

      {/* Sheet (§4a.3): a five-option picker plus three fields is a
          multi-field form, so the slide-over shape. Submit logic untouched. */}
      <Sheet
        open={open}
        onClose={() => !saving && setOpen(false)}
        title="Mark as paid"
        description={memberName}
        footer={
          success ? null : (
            <Button type="submit" form={formId} loading={saving}>
              {!saving && <CheckCircle2 className="size-4" />}
              {saving ? "Saving…" : "Record payment"}
            </Button>
          )
        }
      >
            {success ? (
              <div className="flex flex-col items-center p-8 text-center">
                <CheckCircle2 className="mb-2 size-10" style={{ color: "#15803d" }} />
                <p className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>Recorded</p>
                <p className="mt-1 text-xs" style={{ color: "var(--tx-3)" }}>Payment row created and member marked paid.</p>
              </div>
            ) : (
              <form id={formId} onSubmit={submit} className="space-y-3">
                <div>
                  <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Method</label>
                  <div className="grid grid-cols-1 gap-1">
                    {METHODS.map((m) => {
                      const isSel = method === m.value;
                      return (
                        <button
                          key={m.value}
                          type="button"
                          onClick={() => setMethod(m.value)}
                          className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl border text-left transition-colors"
                          style={{
                            borderColor: isSel ? primaryColor : "var(--bd-default)",
                            background: isSel ? `${primaryColor}1f` : "transparent",
                          }}
                        >
                          <span>
                            <span className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>{m.label}</span>
                            <span className="block text-[11px]" style={{ color: "var(--tx-3)" }}>{m.description}</span>
                          </span>
                          {isSel && <span className="w-2 h-2 rounded-full" style={{ background: primaryColor }} />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Amount (£)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      disabled={method === "exempt" || method === "comp"}
                      placeholder={method === "exempt" || method === "comp" ? "—" : "80.00"}
                      className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none disabled:opacity-50"
                      style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
                    />
                  </div>
                  <div>
                    <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Date paid</label>
                    <input
                      type="date"
                      value={paidAt}
                      onChange={(e) => setPaidAt(e.target.value)}
                      className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none"
                      style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>
                    Notes {method === "other" && <span className="text-[var(--hue-danger-ink)]">*</span>}
                  </label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={2}
                    placeholder="Optional context (e.g. Sept covered)"
                    className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none resize-none placeholder-gray-600"
                    style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
                  />
                </div>

                {error && <p className="text-xs" style={{ color: "var(--hue-danger)" }}>{error}</p>}

                <p className="text-center text-[11px]" style={{ color: "var(--tx-4)" }}>
                  Audit-logged. The member&apos;s payment status flips to <strong>Paid</strong>.
                </p>
              </form>
            )}
      </Sheet>
    </>
  );
}
