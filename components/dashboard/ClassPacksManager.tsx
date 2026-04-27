"use client";

import { useEffect, useState } from "react";
import { Package, Plus, Trash2, Loader2, AlertCircle, X, Check } from "lucide-react";

type Pack = {
  id: string;
  name: string;
  description: string | null;
  totalCredits: number;
  validityDays: number;
  pricePence: number;
  currency: string;
  isActive: boolean;
};

function formatPrice(pence: number, currency: string) {
  const symbol = currency === "GBP" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  return `${symbol}${(pence / 100).toFixed(2)}`;
}

export default function ClassPacksManager({ primaryColor }: { primaryColor: string }) {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", description: "", totalCredits: "10", validityDays: "90", price: "80" });

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/class-packs");
      const data = await res.json();
      setPacks(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/class-packs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description.trim() || undefined,
          totalCredits: Number(form.totalCredits),
          validityDays: Number(form.validityDays),
          pricePence: Math.round(parseFloat(form.price) * 100),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't create pack");
      } else {
        setPacks((prev) => [data, ...prev]);
        setDrawerOpen(false);
        setForm({ name: "", description: "", totalCredits: "10", validityDays: "90", price: "80" });
      }
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(pack: Pack) {
    const res = await fetch(`/api/class-packs/${pack.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !pack.isActive }),
    });
    if (res.ok) load();
  }

  async function deactivate(pack: Pack) {
    if (!confirm(`Deactivate "${pack.name}"? Existing member packs continue working but it disappears from the buy list.`)) return;
    const res = await fetch(`/api/class-packs/${pack.id}`, { method: "DELETE" });
    if (res.ok) load();
  }

  return (
    <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="font-semibold text-sm flex items-center gap-2" style={{ color: "var(--tx-1)" }}>
            <Package className="w-4 h-4" />
            Class packs
          </h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
            Pre-paid bundles. Members buy N classes for £X, valid Y days. Decremented on each check-in when there is no recurring subscription.
          </p>
        </div>
        <button
          onClick={() => setDrawerOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-white text-xs font-semibold"
          style={{ background: primaryColor }}
        >
          <Plus className="w-3.5 h-3.5" />
          New pack
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6" style={{ color: "var(--tx-3)" }}>
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading…</span>
        </div>
      ) : packs.length === 0 ? (
        <div className="py-8 text-center text-sm" style={{ color: "var(--tx-3)" }}>
          No class packs yet. Create one to start selling pre-paid bundles.
        </div>
      ) : (
        <ul className="space-y-2">
          {packs.map((p) => (
            <li
              key={p.id}
              className="rounded-xl border p-3 flex items-center justify-between gap-3"
              style={{ background: p.isActive ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.01)", borderColor: "var(--bd-default)", opacity: p.isActive ? 1 : 0.55 }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>{p.name}</p>
                  {!p.isActive && <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider" style={{ background: "rgba(255,255,255,0.06)", color: "var(--tx-3)" }}>Inactive</span>}
                </div>
                <p className="text-[11px] mt-1" style={{ color: "var(--tx-3)" }}>
                  {p.totalCredits} classes · valid {p.validityDays} days · {formatPrice(p.pricePence, p.currency)}
                </p>
                {p.description && <p className="text-[11px] mt-1" style={{ color: "var(--tx-3)" }}>{p.description}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => toggleActive(p)}
                  className="text-[11px] px-2 py-1 rounded-lg border transition-colors hover:bg-white/5"
                  style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
                >
                  {p.isActive ? "Deactivate" : "Reactivate"}
                </button>
                {p.isActive && (
                  <button
                    onClick={() => deactivate(p)}
                    className="p-1.5 rounded-lg transition-colors hover:bg-white/5"
                    style={{ color: "var(--tx-3)" }}
                    aria-label="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {drawerOpen && (
        <>
          <div className="fixed inset-0 bg-black/60 z-40" onClick={() => !creating && setDrawerOpen(false)} />
          <div
            className="fixed bottom-0 left-0 right-0 md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:bottom-auto md:w-full md:max-w-md z-50 rounded-t-3xl md:rounded-3xl border"
            style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
          >
            <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: "var(--bd-default)" }}>
              <h3 className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>Create class pack</h3>
              <button onClick={() => !creating && setDrawerOpen(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={create} className="p-4 space-y-3">
              <div>
                <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Name</label>
                <input
                  required value={form.name} maxLength={100}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. 10 classes for £80"
                  className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none placeholder-gray-600"
                  style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Credits</label>
                  <input type="number" min={1} max={1000} required value={form.totalCredits} onChange={(e) => setForm((f) => ({ ...f, totalCredits: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none" style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }} />
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Valid (days)</label>
                  <input type="number" min={1} max={3650} required value={form.validityDays} onChange={(e) => setForm((f) => ({ ...f, validityDays: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none" style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }} />
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Price (£)</label>
                  <input type="number" step="0.01" min={0} required value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none" style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }} />
                </div>
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Description (optional)</label>
                <textarea value={form.description} maxLength={500} rows={2} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none resize-none placeholder-gray-600"
                  style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }} placeholder="What members get from this pack" />
              </div>
              {error && <div className="flex items-start gap-2 px-3 py-2 rounded-xl border text-xs" style={{ borderColor: "rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.06)", color: "#f87171" }}><AlertCircle className="w-4 h-4 shrink-0" />{error}</div>}
              <button type="submit" disabled={creating} className="w-full py-3 rounded-xl text-white font-semibold text-sm inline-flex items-center justify-center gap-2 disabled:opacity-50" style={{ background: primaryColor }}>
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {creating ? "Creating in Stripe…" : "Create pack"}
              </button>
              <p className="text-[11px] text-center" style={{ color: "var(--tx-4)" }}>
                A Stripe Product + Price is created on your connected account. Audit-logged.
              </p>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
