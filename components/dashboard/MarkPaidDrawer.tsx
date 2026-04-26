"use client";

import { useState } from "react";
import { CheckCircle2, X, Loader2, Banknote } from "lucide-react";

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
  const [method, setMethod] = useState<typeof METHODS[number]["value"]>("cash");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [paidAt, setPaidAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

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
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        onClick={() => { reset(); setOpen(true); }}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors hover:bg-white/5"
        style={{ borderColor: "rgba(0,0,0,0.10)", color: "rgba(0,0,0,0.55)" }}
      >
        <Banknote className="w-3.5 h-3.5" />
        Mark paid manually
      </button>

      {open && (
        <>
          <div className="fixed inset-0 bg-black/60 z-40" onClick={() => !saving && setOpen(false)} />
          <div
            className="fixed bottom-0 left-0 right-0 md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:bottom-auto md:w-full md:max-w-md z-50 rounded-t-3xl md:rounded-3xl border"
            style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
          >
            <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: "var(--bd-default)" }}>
              <h3 className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>
                Mark <span className="font-normal" style={{ color: "var(--tx-3)" }}>{memberName}</span> as paid
              </h3>
              <button onClick={() => !saving && setOpen(false)} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            {success ? (
              <div className="p-8 flex flex-col items-center text-center">
                <CheckCircle2 className="w-10 h-10 mb-2" style={{ color: "#22c55e" }} />
                <p className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>Recorded</p>
                <p className="text-xs mt-1" style={{ color: "var(--tx-3)" }}>Payment row created and member marked paid.</p>
              </div>
            ) : (
              <form onSubmit={submit} className="p-4 space-y-3">
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
                    Notes {method === "other" && <span className="text-red-400">*</span>}
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

                {error && <p className="text-xs text-red-400">{error}</p>}

                <button
                  type="submit"
                  disabled={saving}
                  className="w-full py-3 rounded-xl text-white font-semibold text-sm disabled:opacity-50 inline-flex items-center justify-center gap-2"
                  style={{ background: primaryColor }}
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  {saving ? "Saving…" : "Record payment"}
                </button>
                <p className="text-[11px] text-center" style={{ color: "var(--tx-4)" }}>
                  Audit-logged. The member&apos;s payment status flips to <strong>Paid</strong>.
                </p>
              </form>
            )}
          </div>
        </>
      )}
    </>
  );
}
