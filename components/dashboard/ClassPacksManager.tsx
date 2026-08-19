"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Package, Plus, Trash2, Loader2, AlertCircle, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/Toast";

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
  const { toast } = useToast();
  const formId = useId();
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", description: "", totalCredits: "10", validityDays: "90", price: "80" });
  // The pack awaiting deactivation, or null. Drives the ConfirmDialog that
  // replaced the browser's native confirm prompt (UI-RULES §5.4).
  const [pendingDeactivate, setPendingDeactivate] = useState<Pack | null>(null);

  // `useCallback` because `load` now closes over `toast` (from context), so it
  // is no longer provably stable and the mount effect has to depend on it.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/class-packs");
      const data = await res.json();
      setPacks(Array.isArray(data) ? data : []);
    } catch {
      // The throw used to escape an un-awaited promise and leave "No class
      // packs yet" on screen — a failed request reading as an empty list (§7).
      toast("Couldn't load class packs — check your connection and reload.", "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

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
    } catch {
      setError("Couldn't reach the server — the pack was not created.");
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(pack: Pack) {
    try {
      const res = await fetch(`/api/class-packs/${pack.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !pack.isActive }),
      });
      if (!res.ok) {
        toast(`Couldn't ${pack.isActive ? "pause" : "reactivate"} ${pack.name}`, "error");
        return;
      }
      await load();
    } catch {
      toast("Couldn't reach the server — nothing was changed.", "error");
    }
  }

  async function deactivate(pack: Pack) {
    // The `finally` closes the dialog either way, so a failure that says
    // nothing is indistinguishable from a success — hence the explicit
    // not-ok and throw branches.
    try {
      const res = await fetch(`/api/class-packs/${pack.id}`, { method: "DELETE" });
      if (!res.ok) {
        toast(`Couldn't deactivate ${pack.name} — it is still active.`, "error");
        return;
      }
      await load();
    } catch {
      toast("Couldn't reach the server — the pack is still active.", "error");
    } finally {
      setPendingDeactivate(null);
    }
  }

  return (
    // §4a.5: `rgba(255,255,255,0.025)` is a dark-theme leftover — 2.5% white
    // over the light staff shell composites to the shell itself (1.00:1), so
    // the card painted nothing and hung off its hairline border alone.
    <div className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
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
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[var(--tx-on-accent)] text-xs font-semibold"
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
              // Both row fills were white-over-white (1.00:1). The de-emphasis
              // for an inactive pack is now the --sf-2 surface plus the
              // "Inactive" chip, NOT `opacity: 0.55` — that opacity multiplied
              // through the text as well, dropping --tx-3 to 2.12:1 and --tx-1
              // to 3.54:1, so a deactivated pack's own name failed the floor.
              style={{ background: p.isActive ? "var(--sf-1)" : "var(--sf-2)", borderColor: "var(--bd-default)" }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>{p.name}</p>
                  {!p.isActive && <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider" style={{ background: "var(--sf-1)", color: "var(--tx-3)" }}>Inactive</span>}
                </div>
                <p className="text-[11px] mt-1" style={{ color: "var(--tx-3)" }}>
                  {p.totalCredits} classes · valid {p.validityDays} days · {formatPrice(p.pricePence, p.currency)}
                </p>
                {p.description && <p className="text-[11px] mt-1" style={{ color: "var(--tx-3)" }}>{p.description}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => toggleActive(p)}
                  className="text-[11px] px-2 py-1 rounded-lg border transition-colors hover:bg-sf-2"
                  style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
                >
                  {p.isActive ? "Deactivate" : "Reactivate"}
                </button>
                {p.isActive && (
                  <button
                    onClick={() => setPendingDeactivate(p)}
                    className="p-1.5 rounded-lg transition-colors hover:bg-sf-2"
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

      {/*
        Dialog (§4a.3): a short create form. The primitive supplies aria-modal,
        Escape, the focus trap and scroll lock; `create` and the mid-flight
        `creating` guard on dismissal are unchanged.
      */}
      <Dialog
        open={drawerOpen}
        onClose={() => !creating && setDrawerOpen(false)}
        title="Create class pack"
        footer={
          <Button type="submit" form={formId} loading={creating}>
            {!creating && <Check className="w-4 h-4" />}
            {creating ? "Creating in Stripe…" : "Create pack"}
          </Button>
        }
      >
            <form id={formId} onSubmit={create} className="space-y-3">
              <div>
                <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Name</label>
                <input aria-label="Name"
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
                  <input aria-label="Credits" type="number" min={1} max={1000} required value={form.totalCredits} onChange={(e) => setForm((f) => ({ ...f, totalCredits: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none" style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }} />
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Valid (days)</label>
                  <input aria-label="Valid (days)" type="number" min={1} max={3650} required value={form.validityDays} onChange={(e) => setForm((f) => ({ ...f, validityDays: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none" style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }} />
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Price (£)</label>
                  <input aria-label="Price (£)" type="number" step="0.01" min={0} required value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none" style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }} />
                </div>
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Description (optional)</label>
                <textarea aria-label="Description (optional)" value={form.description} maxLength={500} rows={2} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none resize-none placeholder-gray-600"
                  style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }} placeholder="What members get from this pack" />
              </div>
              {error && <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-xl border text-xs" style={{ borderColor: "rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.06)", color: "#f87171" }}><AlertCircle className="w-4 h-4 shrink-0" />{error}</div>}
              <p className="text-[11px] text-center" style={{ color: "var(--tx-4)" }}>
                A Stripe Product + Price is created on your connected account. Audit-logged.
              </p>
            </form>
      </Dialog>

      <ConfirmDialog
        open={pendingDeactivate !== null}
        onClose={() => setPendingDeactivate(null)}
        onConfirm={() => {
          if (pendingDeactivate) return deactivate(pendingDeactivate);
        }}
        title="Deactivate pack?"
        description={
          pendingDeactivate
            ? `${pendingDeactivate.name} disappears from the buy list. Existing member packs carry on working.`
            : undefined
        }
        confirmLabel="Deactivate pack"
        destructive
      />
    </div>
  );
}
