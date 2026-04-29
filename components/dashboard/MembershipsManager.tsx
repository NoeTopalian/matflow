"use client";

import { useState } from "react";
import { Plus, Edit2, Trash2, Tag, X, Loader2, Check, Users } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import type { MembershipTierRow } from "@/app/dashboard/memberships/page";

interface Props {
  initialTiers: MembershipTierRow[];
  primaryColor: string;
}

const BILLING_LABELS: Record<string, string> = {
  monthly: "Monthly",
  annual: "Annual",
  none: "One-off / Drop-in",
};

function formatPrice(pricePence: number, currency: string) {
  const symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : "$";
  return `${symbol}${(pricePence / 100).toFixed(2)}`;
}

const emptyForm = {
  name: "",
  description: "",
  pricePence: "",
  currency: "GBP",
  billingCycle: "monthly" as "monthly" | "annual" | "none",
  maxClassesPerWeek: "",
  isKids: false,
};

type FormState = typeof emptyForm;

export default function MembershipsManager({ initialTiers, primaryColor }: Props) {
  const { toast } = useToast();
  const [tiers, setTiers] = useState<MembershipTierRow[]>(initialTiers);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  function openAdd() {
    setEditingId(null);
    setForm(emptyForm);
    setShowModal(true);
  }

  function openEdit(tier: MembershipTierRow) {
    setEditingId(tier.id);
    setForm({
      name: tier.name,
      description: tier.description ?? "",
      pricePence: String(tier.pricePence / 100),
      currency: tier.currency,
      billingCycle: tier.billingCycle as "monthly" | "annual" | "none",
      maxClassesPerWeek: tier.maxClassesPerWeek != null ? String(tier.maxClassesPerWeek) : "",
      isKids: tier.isKids,
    });
    setShowModal(true);
  }

  async function handleSave() {
    if (!form.name.trim()) {
      toast("Name is required", "error");
      return;
    }
    const pricePence = Math.round(parseFloat(form.pricePence || "0") * 100);
    if (isNaN(pricePence) || pricePence < 0) {
      toast("Invalid price", "error");
      return;
    }

    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        pricePence,
        currency: form.currency,
        billingCycle: form.billingCycle,
        maxClassesPerWeek: form.maxClassesPerWeek ? parseInt(form.maxClassesPerWeek) : undefined,
        isKids: form.isKids,
      };

      if (editingId) {
        const res = await fetch(`/api/memberships/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          toast((await res.json()).error ?? "Failed to update tier", "error");
          return;
        }
        const updated = await res.json();
        setTiers((prev) => prev.map((t) => (t.id === editingId ? { ...t, ...updated, createdAt: t.createdAt } : t)));
        toast("Tier updated", "success");
      } else {
        const res = await fetch("/api/memberships", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          toast((await res.json()).error ?? "Failed to create tier", "error");
          return;
        }
        const created = await res.json();
        setTiers((prev) => [...prev, { ...created, createdAt: created.createdAt ?? new Date().toISOString() }]);
        toast("Tier created", "success");
      }

      setShowModal(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/memberships/${id}`, { method: "DELETE" });
      if (!res.ok) {
        toast((await res.json()).error ?? "Failed to delete tier", "error");
        return;
      }
      setTiers((prev) => prev.filter((t) => t.id !== id));
      toast("Tier deleted", "success");
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  }

  const inputCls =
    "w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-white/30";

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--tx-1)" }}>
            Membership Tiers
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--tx-4)" }}>
            Define the membership plans available at your gym.
          </p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white"
          style={{ background: primaryColor }}
        >
          <Plus className="w-4 h-4" />
          Add tier
        </button>
      </div>

      {/* Tier list */}
      {tiers.length === 0 ? (
        <div
          className="rounded-2xl border p-12 text-center"
          style={{ borderColor: "var(--bd-default)", background: "rgba(255,255,255,0.02)" }}
        >
          <Tag className="w-10 h-10 mx-auto mb-3" style={{ color: "var(--tx-4)" }} />
          <p className="font-medium" style={{ color: "var(--tx-2)" }}>
            No membership tiers yet
          </p>
          <p className="text-sm mt-1" style={{ color: "var(--tx-4)" }}>
            Create your first tier to get started.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {tiers.map((tier) => (
            <div
              key={tier.id}
              className="flex items-center gap-4 rounded-2xl border px-5 py-4"
              style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}
            >
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>
                    {tier.name}
                  </span>
                  {tier.isKids && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold"
                      style={{ background: "rgba(96,165,250,0.15)", color: "#60a5fa" }}
                    >
                      <Users className="w-2.5 h-2.5" />
                      Kids
                    </span>
                  )}
                  <span
                    className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold"
                    style={{ background: "rgba(167,139,250,0.12)", color: "#a78bfa" }}
                  >
                    {BILLING_LABELS[tier.billingCycle] ?? tier.billingCycle}
                  </span>
                </div>
                {tier.description && (
                  <p className="text-xs truncate" style={{ color: "var(--tx-4)" }}>
                    {tier.description}
                  </p>
                )}
                <p className="text-xs mt-1" style={{ color: "var(--tx-3)" }}>
                  {formatPrice(tier.pricePence, tier.currency)}
                  {tier.maxClassesPerWeek != null && ` · max ${tier.maxClassesPerWeek} classes/week`}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {confirmDeleteId === tier.id ? (
                  <>
                    <span className="text-xs" style={{ color: "var(--tx-3)" }}>
                      Delete?
                    </span>
                    <button
                      onClick={() => handleDelete(tier.id)}
                      disabled={deletingId === tier.id}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-red-500/80 hover:bg-red-500 transition-colors disabled:opacity-60"
                    >
                      {deletingId === tier.id ? <Loader2 className="w-3 h-3 animate-spin" /> : "Confirm"}
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="px-3 py-1.5 rounded-lg text-xs border transition-colors"
                      style={{ borderColor: "var(--bd-default)", color: "var(--tx-3)" }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => openEdit(tier)}
                      className="p-2 rounded-lg border transition-colors hover:text-white"
                      style={{ borderColor: "var(--bd-default)", color: "var(--tx-4)" }}
                      aria-label="Edit tier"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(tier.id)}
                      className="p-2 rounded-lg border transition-colors hover:text-red-400"
                      style={{ borderColor: "var(--bd-default)", color: "var(--tx-4)" }}
                      aria-label="Delete tier"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowModal(false)}
          />
          <div
            className="relative w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl border p-6 space-y-4"
            style={{ background: "var(--sf-0)", borderColor: "rgba(255,255,255,0.1)" }}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold" style={{ color: "var(--tx-1)" }}>
                {editingId ? "Edit tier" : "Add tier"}
              </h3>
              <button
                onClick={() => setShowModal(false)}
                className="text-gray-500 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="text-gray-400 text-xs mb-1 block">Name *</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className={inputCls}
                  placeholder="e.g. Monthly Adult"
                  maxLength={100}
                />
              </div>

              <div className="sm:col-span-2">
                <label className="text-gray-400 text-xs mb-1 block">Description</label>
                <input
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  className={inputCls}
                  placeholder="Optional short description"
                  maxLength={500}
                />
              </div>

              <div>
                <label className="text-gray-400 text-xs mb-1 block">Price</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.pricePence}
                  onChange={(e) => setForm((f) => ({ ...f, pricePence: e.target.value }))}
                  className={inputCls}
                  placeholder="0.00"
                />
              </div>

              <div>
                <label className="text-gray-400 text-xs mb-1 block">Currency</label>
                <select
                  value={form.currency}
                  onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
                  className={inputCls + " appearance-none"}
                >
                  <option value="GBP">GBP</option>
                  <option value="EUR">EUR</option>
                  <option value="USD">USD</option>
                </select>
              </div>

              <div>
                <label className="text-gray-400 text-xs mb-1 block">Billing cycle</label>
                <select
                  value={form.billingCycle}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      billingCycle: e.target.value as "monthly" | "annual" | "none",
                    }))
                  }
                  className={inputCls + " appearance-none"}
                >
                  <option value="monthly">Monthly</option>
                  <option value="annual">Annual</option>
                  <option value="none">One-off / Drop-in</option>
                </select>
              </div>

              <div>
                <label className="text-gray-400 text-xs mb-1 block">Max classes/week</label>
                <input
                  type="number"
                  min="1"
                  max="30"
                  value={form.maxClassesPerWeek}
                  onChange={(e) => setForm((f) => ({ ...f, maxClassesPerWeek: e.target.value }))}
                  className={inputCls}
                  placeholder="Unlimited"
                />
              </div>

              <div className="sm:col-span-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, isKids: !f.isKids }))}
                  className={`w-10 h-6 rounded-full relative transition-colors ${
                    form.isKids ? "bg-blue-500" : "bg-white/10"
                  }`}
                  aria-label="Toggle kids tier"
                >
                  <span
                    className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                      form.isKids ? "translate-x-5" : "translate-x-1"
                    }`}
                  />
                </button>
                <span className="text-sm" style={{ color: "var(--tx-2)" }}>
                  Kids tier
                </span>
                {form.isKids && (
                  <Check className="w-4 h-4 text-blue-400" />
                )}
              </div>
            </div>

            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full py-3 rounded-xl font-semibold text-white text-sm disabled:opacity-50 flex items-center justify-center gap-2"
              style={{ background: primaryColor }}
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Saving…
                </>
              ) : (
                editingId ? "Save changes" : "Create tier"
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
