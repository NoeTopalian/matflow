"use client";

import { useState } from "react";
import { Plus, Edit2, Trash2, Tag, Check, Users, CreditCard } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { AvatarInitials } from "@/components/ui/AvatarInitials";
import { StatusPill } from "@/components/ui/StatusPill";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/page-header";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
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

/** Chip surfaces derived from tokens, so they stay legible on the light shell. */
const CHIP = {
  kids: {
    bg: "color-mix(in srgb, var(--hue-info) 12%, transparent)",
    color: "var(--hue-info)",
  },
  cycle: {
    bg: "color-mix(in srgb, var(--hue-success) 12%, transparent)",
    color: "var(--hue-success)",
  },
} as const;

const emptyForm = {
  name: "",
  description: "",
  pricePence: "",
  currency: "GBP",
  billingCycle: "monthly" as "monthly" | "annual" | "none",
  maxClassesPerWeek: "",
  isKids: false,
  // Stripe linkage. Owners paste the price_… and prod_… ids from their
  // Stripe dashboard so F2/F3 (member self-subscribe + parent-pays-for-
  // kid) can map server-side instead of trusting the client-supplied
  // priceId. Both empty by default — F2/F3 still 403 unless
  // Tenant.memberSelfBilling is on, so leaving these blank is safe.
  stripePriceId: "",
  stripeProductId: "",
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

  function closeSheet() {
    if (saving) return;
    setShowModal(false);
  }

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
      stripePriceId: tier.stripePriceId ?? "",
      stripeProductId: tier.stripeProductId ?? "",
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
        stripePriceId: form.stripePriceId.trim() || null,
        stripeProductId: form.stripeProductId.trim() || null,
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

  /**
   * Tier columns (UI-RULES §1.5.4 dense spec via the DataTable primitive).
   * Declared inside the component because the action cells close over
   * `openEdit` / `setConfirmDeleteId`; the row set is small enough that the
   * re-created array costs nothing.
   */
  const columns: DataTableColumn<MembershipTierRow>[] = [
    {
      key: "name",
      header: "Tier",
      sortValue: (t) => t.name,
      // B2 density: name-over-description was the one stacked cell left in this
      // table and it is what held the rows at 53px against the 36px spec. The
      // description trails the name inline; `sm` (28px) is the largest avatar a
      // 36px row can hold.
      cell: (t) => (
        <div className="flex min-w-0 items-center gap-3" title={t.description ?? undefined}>
          <AvatarInitials name={t.name} color={primaryColor} size="sm" />
          <p className="min-w-0 truncate">
            <span className="font-semibold text-tx-1">{t.name}</span>
            {t.description && (
              <span className="ml-1.5 text-[11px] text-tx-3">· {t.description}</span>
            )}
          </p>
        </div>
      ),
    },
    {
      key: "price",
      header: "Price",
      width: "7rem",
      align: "right",
      sortValue: (t) => t.pricePence,
      cell: (t) => (
        <span className="whitespace-nowrap font-medium text-tx-1">
          {formatPrice(t.pricePence, t.currency)}
        </span>
      ),
    },
    {
      key: "cycle",
      header: "Cycle",
      width: "9rem",
      // Sort on the label the cell actually shows, not the raw enum — sorting
      // "One-off / Drop-in" under `none` puts it in a position the reader
      // cannot account for.
      sortValue: (t) => BILLING_LABELS[t.billingCycle] ?? t.billingCycle,
      cell: (t) => (
        <StatusPill
          icon={CreditCard}
          label={BILLING_LABELS[t.billingCycle] ?? t.billingCycle}
          bg={CHIP.cycle.bg}
          color={CHIP.cycle.color}
        />
      ),
    },
    {
      key: "classLimit",
      header: "Class limit",
      width: "7rem",
      align: "right",
      // Null means "Unlimited", which is the LARGEST class limit, not a blank.
      // Left raw it sorts as an empty value and sinks to the bottom in both
      // directions, which reads as the smallest.
      sortValue: (t) => t.maxClassesPerWeek ?? Number.MAX_SAFE_INTEGER,
      cell: (t) => (
        <span className="whitespace-nowrap text-tx-2">
          {t.maxClassesPerWeek != null ? `${t.maxClassesPerWeek}/wk` : "Unlimited"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "6rem",
      cell: (t) =>
        t.isKids ? (
          <StatusPill icon={Users} label="Kids" bg={CHIP.kids.bg} color={CHIP.kids.color} />
        ) : (
          <span className="text-[11px] text-tx-4">Adult</span>
        ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      headerLabel: "Actions",
      width: "6rem",
      align: "right",
      cell: (t) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="compact"
            onClick={() => openEdit(t)}
            aria-label={`Edit ${t.name}`}
          >
            <Edit2 className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="compact"
            onClick={() => setConfirmDeleteId(t.id)}
            aria-label={`Delete ${t.name}`}
            style={{ color: "var(--hue-danger)" }}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ),
    },
  ];

  const pendingDelete = tiers.find((t) => t.id === confirmDeleteId) ?? null;

  return (
    <>
      <PageHeader
        title="Membership tiers"
        description="Define the membership plans available at your gym."
        action={
          <Button onClick={openAdd}>
            <Plus className="size-4" />
            Add tier
          </Button>
        }
      />

      {/* ── Tiers (DataTable — §1.5.4 dense spec; card-collapse below sm:) ──
          The card chrome only applies from sm: up, because below that the
          primitive renders its own per-row Cards and an outer card would nest
          white on white. */}
      <div className="sm:overflow-hidden sm:rounded-[var(--r-md)] sm:border sm:border-bd-default sm:bg-sf-1">
        <DataTable
          label="Membership tiers"
          rows={tiers}
          rowKey={(t) => t.id}
          columns={columns}
          empty={
            <EmptyState
              icon={<Tag className="size-10" />}
              title="No membership tiers yet"
              hint="Create your first tier to get started."
              action={
                <Button onClick={openAdd}>
                  <Plus className="size-4" />
                  Add tier
                </Button>
              }
            />
          }
          // renderCard contains interactive Buttons — do NOT add onRowClick to this table (nested-button a11y violation).
          renderCard={(t) => (
            <Card padding="tight" className="flex items-center gap-3">
              <AvatarInitials name={t.name} color={primaryColor} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-tx-1">{t.name}</p>
                {t.description && (
                  <p className="truncate text-[11px] text-tx-4">{t.description}</p>
                )}
                <p className="truncate text-xs text-tx-4">
                  {formatPrice(t.pricePence, t.currency)} · {BILLING_LABELS[t.billingCycle] ?? t.billingCycle}
                  {t.maxClassesPerWeek != null && ` · max ${t.maxClassesPerWeek}/wk`}
                </p>
                {t.isKids && (
                  <span className="mt-1 inline-flex">
                    <StatusPill icon={Users} label="Kids" bg={CHIP.kids.bg} color={CHIP.kids.color} />
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="compact" onClick={() => openEdit(t)} aria-label={`Edit ${t.name}`}>
                  <Edit2 className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => setConfirmDeleteId(t.id)}
                  aria-label={`Delete ${t.name}`}
                  style={{ color: "var(--hue-danger)" }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </Card>
          )}
        />
      </div>

      {/* Add / Edit — Sheet (UI-RULES §4a.3: multi-field form). */}
      <Sheet
        open={showModal}
        // Escape and the scrim have to agree with the disabled Cancel button —
        // otherwise a mid-save dismissal loses the in-flight request's result.
        onClose={closeSheet}
        title={editingId ? "Edit tier" : "Add tier"}
        footer={
          <>
            <Button variant="secondary" onClick={closeSheet} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving}>
              {editingId ? "Save changes" : "Create tier"}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="tier-name" className="mb-1 block text-xs text-tx-2">Name *</label>
            <input
              id="tier-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full rounded-[var(--r-md)] border border-bd-default bg-sf-1 px-3 py-2 text-sm text-tx-1 outline-none transition-colors placeholder:text-tx-3 focus:border-bd-active"
              placeholder="e.g. Monthly Adult"
              maxLength={100}
            />
          </div>

          <div className="sm:col-span-2">
            <label htmlFor="tier-description" className="mb-1 block text-xs text-tx-2">Description</label>
            <input
              id="tier-description"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              className="w-full rounded-[var(--r-md)] border border-bd-default bg-sf-1 px-3 py-2 text-sm text-tx-1 outline-none transition-colors placeholder:text-tx-3 focus:border-bd-active"
              placeholder="Optional short description"
              maxLength={500}
            />
          </div>

          <div>
            <label htmlFor="tier-price" className="mb-1 block text-xs text-tx-2">Price</label>
            <input
              id="tier-price"
              type="number"
              min="0"
              step="0.01"
              value={form.pricePence}
              onChange={(e) => setForm((f) => ({ ...f, pricePence: e.target.value }))}
              className="w-full rounded-[var(--r-md)] border border-bd-default bg-sf-1 px-3 py-2 text-sm text-tx-1 outline-none transition-colors placeholder:text-tx-3 focus:border-bd-active"
              placeholder="0.00"
            />
          </div>

          <div>
            <label htmlFor="tier-currency" className="mb-1 block text-xs text-tx-2">Currency</label>
            <select
              id="tier-currency"
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
              className="w-full appearance-none rounded-[var(--r-md)] border border-bd-default bg-sf-1 px-3 py-2 text-sm text-tx-1 outline-none transition-colors focus:border-bd-active"
            >
              <option value="GBP">GBP</option>
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
            </select>
          </div>

          <div>
            <label htmlFor="tier-cycle" className="mb-1 block text-xs text-tx-2">Billing cycle</label>
            <select
              id="tier-cycle"
              value={form.billingCycle}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  billingCycle: e.target.value as "monthly" | "annual" | "none",
                }))
              }
              className="w-full appearance-none rounded-[var(--r-md)] border border-bd-default bg-sf-1 px-3 py-2 text-sm text-tx-1 outline-none transition-colors focus:border-bd-active"
            >
              <option value="monthly">Monthly</option>
              <option value="annual">Annual</option>
              <option value="none">One-off / Drop-in</option>
            </select>
          </div>

          <div>
            <label htmlFor="tier-max-classes" className="mb-1 block text-xs text-tx-2">Max classes/week</label>
            <input
              id="tier-max-classes"
              type="number"
              min="1"
              max="30"
              value={form.maxClassesPerWeek}
              onChange={(e) => setForm((f) => ({ ...f, maxClassesPerWeek: e.target.value }))}
              className="w-full rounded-[var(--r-md)] border border-bd-default bg-sf-1 px-3 py-2 text-sm text-tx-1 outline-none transition-colors placeholder:text-tx-3 focus:border-bd-active"
              placeholder="Unlimited"
            />
          </div>

          <div className="flex items-center gap-3 sm:col-span-2">
            <Switch
              id="tier-is-kids"
              checked={form.isKids}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, isKids: checked }))}
              aria-labelledby="tier-is-kids-label"
            />
            <span id="tier-is-kids-label" className="text-sm text-tx-2">
              Kids tier
            </span>
            {form.isKids && <Check className="size-4" style={{ color: "var(--hue-info)" }} />}
          </div>

          {/* Stripe linkage — optional. Required only if you want members
              or parents to self-subscribe to this tier from the app
              (Tenant.memberSelfBilling must also be on). */}
          <div className="mt-2 border-t border-bd-default pt-3 sm:col-span-2">
            <p className="mb-1 text-xs font-semibold tracking-wider text-tx-3 uppercase">
              Stripe linkage (optional)
            </p>
            <p className="mb-3 text-xs text-tx-4">
              Paste the <code className="text-[10px]">price_…</code> and <code className="text-[10px]">prod_…</code> ids from your Stripe dashboard. Leave blank if members shouldn&apos;t self-subscribe to this tier.
            </p>
          </div>

          <div>
            <label htmlFor="tier-stripe-price" className="mb-1.5 block text-xs font-medium text-tx-3">
              Stripe price id
            </label>
            <input
              id="tier-stripe-price"
              type="text"
              placeholder="price_1AbCdEfGhIjKlMnO"
              value={form.stripePriceId}
              onChange={(e) => setForm((f) => ({ ...f, stripePriceId: e.target.value }))}
              className="w-full rounded-[var(--r-sm)] border border-bd-default bg-sf-2 px-3 py-2 font-mono text-sm text-tx-1 outline-none transition-colors focus:border-bd-active"
            />
          </div>

          <div>
            <label htmlFor="tier-stripe-product" className="mb-1.5 block text-xs font-medium text-tx-3">
              Stripe product id
            </label>
            <input
              id="tier-stripe-product"
              type="text"
              placeholder="prod_AbCdEfGhIjKlMnOp"
              value={form.stripeProductId}
              onChange={(e) => setForm((f) => ({ ...f, stripeProductId: e.target.value }))}
              className="w-full rounded-[var(--r-sm)] border border-bd-default bg-sf-2 px-3 py-2 font-mono text-sm text-tx-1 outline-none transition-colors focus:border-bd-active"
            />
          </div>
        </div>
      </Sheet>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          if (confirmDeleteId) return handleDelete(confirmDeleteId);
        }}
        title="Delete tier?"
        description={
          pendingDelete
            ? `${pendingDelete.name} will no longer be available to assign. Members already on it keep their membership.`
            : undefined
        }
        confirmLabel="Delete tier"
        destructive
        loading={deletingId !== null}
      />
    </>
  );
}
