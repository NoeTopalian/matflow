"use client";

import { useEffect, useState } from "react";
import { Plus, Edit2, Trash2, Tag, Check, Users, CreditCard, MapPin } from "lucide-react";
import { Select } from "@/components/ui/select";
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
import { describeApiError } from "@/lib/api-field-errors";
import { BILLING_CYCLES, cycleLabel, isBillingCycle, type BillingCycle } from "@/lib/billing-cycle";

interface Props {
  initialTiers: MembershipTierRow[];
  primaryColor: string;
}

function formatPrice(pricePence: number, currency: string) {
  const symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : "$";
  return `${symbol}${(pricePence / 100).toFixed(2)}`;
}

/**
 * A tier made for a plan TeamUp bills, whose price MatFlow does not know
 * (Total BJJ handover, 3 Oct 2026; scripts/readiness/teamup-tier-plan.mjs):
 * price 0, cycle "none", description "Price not yet confirmed — billed by
 * TeamUp …". Price 0 + cycle none is what keeps it from seeding a due date or
 * an overdue; it must not then read as a £0.00 one-off drop-in to the owner.
 */
const PRICE_NOT_SET = /^price not (yet )?(confirmed|set)\b.*billed by teamup/i;
function priceNotSet(t: { pricePence: number; billingCycle: string; description?: string | null }): boolean {
  return t.pricePence === 0 && t.billingCycle === "none" && PRICE_NOT_SET.test(t.description ?? "");
}
export function tierPriceText(t: { pricePence: number; currency: string; billingCycle: string; description?: string | null }): string {
  return priceNotSet(t) ? "Price not set" : formatPrice(t.pricePence, t.currency);
}
export function tierCycleText(t: { pricePence: number; billingCycle: string; description?: string | null }): string {
  return priceNotSet(t) ? "Billed by TeamUp" : cycleLabel(t.billingCycle);
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
  billingCycle: "monthly" as BillingCycle,
  maxClassesPerWeek: "",
  isKids: false,
  // Stripe linkage. Owners paste the price_… and prod_… ids from their
  // Stripe dashboard so F2/F3 (member self-subscribe + parent-pays-for-
  // kid) can map server-side instead of trusting the client-supplied
  // priceId. Both empty by default — F2/F3 still 403 unless
  // Tenant.memberSelfBilling is on, so leaving these blank is safe.
  stripePriceId: "",
  stripeProductId: "",
  // ADR-001 D2 slice 2: the venue this tier covers; "" = every venue.
  locationId: "",
};

type FormState = typeof emptyForm;

export default function MembershipsManager({ initialTiers, primaryColor }: Props) {
  const { toast } = useToast();
  const [tiers, setTiers] = useState<MembershipTierRow[]>(initialTiers);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  // ADR-001 D2 slice 2: the venue picker appears only once the club has more
  // than one venue; a failed read is said, not shown as "one venue".
  const [venues, setVenues] = useState<{ id: string; name: string }[]>([]);
  const [venuesError, setVenuesError] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/locations");
        if (!r.ok) { if (alive) setVenuesError(true); return; }
        const d = (await r.json()) as { locations?: { id: string; name: string }[] };
        if (alive && d.locations) setVenues(d.locations);
      } catch {
        if (alive) setVenuesError(true);
      }
    })();
    return () => { alive = false; };
  }, []);
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
      billingCycle: isBillingCycle(tier.billingCycle) ? tier.billingCycle : "monthly",
      maxClassesPerWeek: tier.maxClassesPerWeek != null ? String(tier.maxClassesPerWeek) : "",
      isKids: tier.isKids,
      stripePriceId: tier.stripePriceId ?? "",
      stripeProductId: tier.stripeProductId ?? "",
      locationId: tier.locationId ?? "",
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
        locationId: form.locationId || null,
      };

      if (editingId) {
        const res = await fetch(`/api/memberships/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          toast(describeApiError(await res.json().catch(() => null)), "error");
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
          toast(describeApiError(await res.json().catch(() => null)), "error");
          return;
        }
        const created = await res.json();
        // A tier just created has nobody on it yet; the route does not count.
        setTiers((prev) => [...prev, { ...created, createdAt: created.createdAt ?? new Date().toISOString(), activeMembers: 0 }]);
        toast("Tier created", "success");
      }

      setShowModal(false);
    } catch {
      // `finally` releases `saving`, which is what `closeSheet` gates on — so
      // without a catch a network throw left the sheet open, dismissible and
      // completely silent, plus an unhandled rejection from `onClick`.
      toast("Couldn't reach the server — check your connection and try again.", "error");
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
      // Removing a tier deactivates it (the route never deletes). A tier with
      // active members stays listed as inactive so they are never invisible
      // (club-life C4.05); an empty one disappears from the list.
      setTiers((prev) => prev.flatMap((t) => (t.id !== id ? [t] : t.activeMembers > 0 ? [{ ...t, isActive: false }] : [])));
      toast(
        (tiers.find((t) => t.id === id)?.activeMembers ?? 0) > 0
          ? "Tier deactivated — its members keep it; nobody new can pick it"
          : "Tier removed",
        "success",
      );
    } catch {
      toast("Couldn't reach the server — the tier was not deleted.", "error");
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
          {tierPriceText(t)}
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
      sortValue: (t) => tierCycleText(t),
      cell: (t) => (
        <StatusPill
          icon={CreditCard}
          label={tierCycleText(t)}
          bg={CHIP.cycle.bg}
          color={CHIP.cycle.color}
        />
      ),
    },
    {
      key: "activeMembers",
      // The unit is in the header so "12" cannot be read as subscriptions,
      // payments or seats: it is people whose status is active on this tier.
      header: "Active members",
      width: "8rem",
      align: "right",
      sortValue: (t) => t.activeMembers,
      cell: (t) => (
        <span className="whitespace-nowrap tabular-nums text-tx-1" data-testid="tier-active-members">
          {t.activeMembers}
        </span>
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
      cell: (t) => (
        <span className="flex items-center gap-1.5">
          {t.isKids ? (
            <StatusPill icon={Users} label="Kids" bg={CHIP.kids.bg} color={CHIP.kids.color} />
          ) : (
            <span className="text-[11px] text-tx-4">Adult</span>
          )}
          {t.locationName && (
            <StatusPill icon={MapPin} label={t.locationName} bg={CHIP.cycle.bg} color={CHIP.cycle.color} />
          )}
          {!t.isActive && (
            <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--tx-3)" }} title="Not offered to new members; existing members keep it">
              Inactive
            </span>
          )}
        </span>
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
          white on white. No `overflow-hidden`: it would become the table's
          nearest scroll container and make the sticky <thead> inert. */}
      <div className="sm:rounded-[var(--r-md)] sm:border sm:border-bd-default sm:bg-sf-1">
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
                <Button onClick={openAdd} aria-label="Add your first tier">
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
                  {tierPriceText(t)} · {tierCycleText(t)}
                  {t.maxClassesPerWeek != null && ` · max ${t.maxClassesPerWeek}/wk`}
                  {` · ${t.activeMembers} active ${t.activeMembers === 1 ? "member" : "members"}`}
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
            {/* Club-life C4.04: say what a price change does to the people
                already on the tier, at the point of change. Stripe prices are
                immutable, so existing subscriptions keep theirs. */}
            {editingId && (tiers.find((t) => t.id === editingId)?.activeMembers ?? 0) > 0 && (
              <p className="mb-1.5 text-[11px] text-tx-3" role="note" data-testid="tier-price-impact">
                {tiers.find((t) => t.id === editingId)!.activeMembers} active {tiers.find((t) => t.id === editingId)!.activeMembers === 1 ? "member keeps" : "members keep"} their current price. A new price applies to people who join or switch after you save.
              </p>
            )}
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
                  billingCycle: isBillingCycle(e.target.value) ? e.target.value : "monthly",
                }))
              }
              className="w-full appearance-none rounded-[var(--r-md)] border border-bd-default bg-sf-1 px-3 py-2 text-sm text-tx-1 outline-none transition-colors focus:border-bd-active"
            >
              {BILLING_CYCLES.map((c) => (
                <option key={c} value={c}>{cycleLabel(c)}</option>
              ))}
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

          {venues.length > 1 && (
            <div className="sm:col-span-2">
              <label className="mb-1.5 block text-xs font-medium text-tx-3" htmlFor="tier-venue">Venue this tier covers</label>
              <Select id="tier-venue" aria-label="Venue this tier covers" value={form.locationId} onChange={(e) => setForm((f) => ({ ...f, locationId: e.target.value }))} className="w-full">
                <option value="">Every venue</option>
                {venues.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </Select>
              <p className="mt-1 text-[11px] text-tx-4">A member on a venue-bound tier is refused at classes held elsewhere; the desk can still mark them.</p>
            </div>
          )}
          {venuesError && (
            <p className="text-xs sm:col-span-2" style={{ color: "var(--hue-warning-ink)" }} role="alert">
              Could not load the club&rsquo;s venues — the tier keeps its current venue.
            </p>
          )}

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
