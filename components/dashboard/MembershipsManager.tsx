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
import {
  ALLOWANCE_BASES,
  CLASS_LIMIT_MAX,
  CLASS_LIMIT_MIN,
  CLASS_LIMIT_WEEK_OPTIONS,
  allowanceSummary,
  classLimitSortValue,
  classLimitText,
  dateMinute,
  minuteToLocal,
  nowMinute,
  periodContaining,
  tierAllowance,
  type AllowanceBasis,
  type ClassAllowance,
} from "@/lib/class-allowance";

interface Props {
  initialTiers: MembershipTierRow[];
  primaryColor: string;
  /** The club's IANA zone (Tenant.timezone): the editor's dates are the club's calendar. Null falls back to the browser's zone. */
  timeZone?: string | null;
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

/**
 * "Classes allowed" as typed (B1-a, 15 Oct 2026; widened by T7c to the
 * allowance's 1–60). Blank — including whitespace only — means Unlimited;
 * otherwise a whole number in the range both membership routes accept.
 * Anything else is refused here, before a request, so a bad value can never be
 * sent or quietly read as blank.
 */
export type ClassLimitInput = { kind: "blank" } | { kind: "value"; value: number } | { kind: "invalid" };
export const CLASS_LIMIT_ERROR = `Classes allowed must be a whole number from ${CLASS_LIMIT_MIN} to ${CLASS_LIMIT_MAX}, or left blank for Unlimited.`;
export function parseClassLimit(raw: string): ClassLimitInput {
  const s = raw.trim();
  if (s === "") return { kind: "blank" };
  if (!/^[0-9]{1,2}$/.test(s)) return { kind: "invalid" };
  const n = Number(s);
  return n >= CLASS_LIMIT_MIN && n <= CLASS_LIMIT_MAX ? { kind: "value", value: n } : { kind: "invalid" };
}

const sameAllowance = (a: ClassAllowance | null, b: ClassAllowance | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.limit === b.limit &&
    a.basis === b.basis &&
    (a.basis !== "weeks" || b.basis !== "weeks" || (a.weeks === b.weeks && a.anchor === b.anchor)));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The zone the editor's dates are read in: the club's when the page passes it, else the browser's. */
export function editorZone(timeZone?: string | null): string {
  return timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}
/** Today, and the Monday of this week, on the club's calendar (review gap 5, 21 Oct 2026). */
export function todayIso(now = new Date(), timeZone?: string | null): string {
  return minuteToLocal(nowMinute(now, editorZone(timeZone))).date;
}
export function mondayOf(iso: string): string {
  return minuteToLocal(periodContaining({ limit: 1, basis: "week" }, dateMinute(iso)).start).date;
}

export const BASIS_LABELS: Record<AllowanceBasis, string> = {
  week: "Each week (Monday to Sunday)",
  month: "Each calendar month",
  weeks: "Every N weeks from a start date",
};

export const PERIOD_START_ERROR = "Every N weeks needs the date the periods count from (a real calendar date).";

/**
 * The allowance the form describes: null for Unlimited, or the reason it
 * cannot be saved. Every value is checked here, before a request, so a bad
 * value is never sent and never quietly read as blank.
 */
export type FormAllowance = { kind: "ok"; allowance: ClassAllowance | null } | { kind: "error"; message: string };
export function formAllowance(form: { classLimit: string; classLimitBasis: string; classLimitWeeks: string; classLimitAnchor: string }): FormAllowance {
  const limit = parseClassLimit(form.classLimit);
  if (limit.kind === "invalid") return { kind: "error", message: CLASS_LIMIT_ERROR };
  if (limit.kind === "blank") return { kind: "ok", allowance: null };
  const basis = form.classLimitBasis as AllowanceBasis;
  if (basis === "week" || basis === "month") return { kind: "ok", allowance: { limit: limit.value, basis } };
  const weeks = Number(form.classLimitWeeks);
  const anchor = form.classLimitAnchor.trim();
  if (!(CLASS_LIMIT_WEEK_OPTIONS as readonly number[]).includes(weeks)) return { kind: "error", message: "Every N weeks must be a whole number from 2 to 8." };
  // A regex-valid but impossible date ("2026-13-01") makes an Invalid Date,
  // whose toISOString throws — and this runs during render.
  const anchorDate = new Date(`${anchor}T00:00:00Z`);
  if (!ISO_DATE.test(anchor) || Number.isNaN(anchorDate.getTime()) || anchorDate.toISOString().slice(0, 10) !== anchor) {
    return { kind: "error", message: PERIOD_START_ERROR };
  }
  return { kind: "ok", allowance: { limit: limit.value, basis: "weeks", weeks, anchor } };
}

/**
 * The editor's note under the allowance fields: the plain summary with the
 * actual dates (allowanceSummary), then what enforcement means.
 */
export function allowanceNote(fa: FormAllowance, now = new Date(), timeZone?: string | null): { summary: string; period: string | null; enforcement: string } {
  if (fa.kind === "error") return { summary: fa.message, period: null, enforcement: "" };
  const s = allowanceSummary(fa.allowance, nowMinute(now, editorZone(timeZone)));
  if (!fa.allowance) return { summary: s.sentence, period: null, enforcement: "" };
  return {
    summary: s.sentence,
    period: s.period,
    enforcement:
      "Attending a class uses one; booking does not. It is enforced as soon as you save: the member app and the kiosk refuse once it is used up, a booking still goes through with a warning (a booking never guarantees a place), and the desk and the card scanner ask before admitting. " +
      "A lower allowance applies from the next check-in; nothing already recorded changes. " +
      "Class-pack check-ins do not count: once the allowance is used up, a member with a class pack can still check in with a pack credit.",
  };
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
  // T7c: "Classes allowed" (blank = Unlimited) on an explicit reset basis.
  classLimit: "",
  classLimitBasis: "week" as AllowanceBasis,
  classLimitWeeks: "4",
  classLimitAnchor: "",
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

export default function MembershipsManager({ initialTiers, primaryColor, timeZone = null }: Props) {
  const { toast } = useToast();
  const [tiers, setTiers] = useState<MembershipTierRow[]>(initialTiers);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  // The class allowance this edit form was opened with (null = Unlimited). A
  // save sends the allowance only when the owner changed it from this value,
  // so an unrelated edit cannot overwrite one another session has since set.
  const [loadedAllowance, setLoadedAllowance] = useState<ClassAllowance | null>(null);
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
    setForm({ ...emptyForm, classLimitAnchor: mondayOf(todayIso(new Date(), timeZone)) });
    setShowModal(true);
  }

  function openEdit(tier: MembershipTierRow) {
    setEditingId(tier.id);
    const allowance = tierAllowance(tier);
    setLoadedAllowance(allowance);
    setForm({
      name: tier.name,
      description: tier.description ?? "",
      pricePence: String(tier.pricePence / 100),
      currency: tier.currency,
      billingCycle: isBillingCycle(tier.billingCycle) ? tier.billingCycle : "monthly",
      classLimit: allowance ? String(allowance.limit) : "",
      classLimitBasis: allowance?.basis ?? "week",
      classLimitWeeks: String(allowance?.basis === "weeks" ? allowance.weeks : 4),
      classLimitAnchor: allowance?.basis === "weeks" ? allowance.anchor : mondayOf(todayIso(new Date(), timeZone)),
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
    const fa = formAllowance(form);
    if (fa.kind === "error") {
      toast(fa.message, "error");
      return;
    }
    const next = fa.allowance;
    // Edit: send the allowance only when it differs from the one this form
    // loaded — the whole set, or explicit nulls to clear it (an `undefined`
    // key is dropped by JSON, which is how a clear used to be lost).
    // Unchanged, or changed and put back, the keys are left out so the server
    // keeps whatever it holds now. This is not general conflict protection:
    // two people deliberately editing the allowance still overwrite each
    // other. Create: blank omits the keys (Unlimited).
    const send = editingId ? !sameAllowance(next, loadedAllowance) : next !== null;
    const allowanceBody = send
      ? {
          classLimit: next?.limit ?? null,
          classLimitBasis: next?.basis ?? null,
          classLimitWeeks: next?.basis === "weeks" ? next.weeks : null,
          classLimitAnchor: next?.basis === "weeks" ? next.anchor : null,
        }
      : {};

    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        pricePence,
        currency: form.currency,
        billingCycle: form.billingCycle,
        ...allowanceBody,
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
      header: "Classes allowed",
      width: "9rem",
      align: "right",
      // Unlimited is the LARGEST allowance, not a blank: left raw it sorts as
      // an empty value and sinks to the bottom in both directions. Allowances
      // over different spans sort by their average per week.
      sortValue: (t) => classLimitSortValue(tierAllowance(t)),
      cell: (t) => (
        <span className="whitespace-nowrap text-tx-2" data-testid="tier-class-limit">
          {classLimitText(tierAllowance(t))}
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
                  {` · ${t.activeMembers} active ${t.activeMembers === 1 ? "member" : "members"}`}
                </p>
                {/* T7c: the allowance on its own line, so a phone card never
                    truncates it away; Unlimited is shown too, as in the table. */}
                <p className="text-xs text-tx-3" data-testid="tier-card-allowance">
                  Classes: {classLimitText(tierAllowance(t))}
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

          {/* T7c (Sean note 5): "N classes" on an explicit reset basis — never
              a rolling window. The summary below states the period dates
              before anything is saved. Billing frequency is a separate field. */}
          <div className="sm:col-span-2" role="group" aria-labelledby="tier-allowance-label">
            <p id="tier-allowance-label" className="mb-1 text-xs text-tx-2">Class allowance</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-32">
                <label htmlFor="tier-class-limit" className="mb-1 block text-[11px] text-tx-3">Classes allowed</label>
                {/* Text, not type="number": a number field reports an
                    unparseable entry as "", which would save as Unlimited.
                    parseClassLimit decides instead, and refuses what it
                    cannot read. */}
                <input
                  id="tier-class-limit"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={form.classLimit}
                  onChange={(e) => setForm((f) => ({ ...f, classLimit: e.target.value }))}
                  className="w-full rounded-[var(--r-md)] border border-bd-default bg-sf-1 px-3 py-2 text-sm text-tx-1 outline-none transition-colors placeholder:text-tx-3 focus:border-bd-active"
                  placeholder="Unlimited"
                />
              </div>
              <div>
                <label htmlFor="tier-class-limit-basis" className="mb-1 block text-[11px] text-tx-3">resets</label>
                {/* Disabled while "Classes allowed" is blank: a basis on its
                    own saves as Unlimited, so it must not look chosen. */}
                <Select
                  id="tier-class-limit-basis"
                  aria-label="resets"
                  value={form.classLimitBasis}
                  onChange={(e) => setForm((f) => ({ ...f, classLimitBasis: e.target.value as AllowanceBasis }))}
                  disabled={form.classLimit.trim() === ""}
                  title={form.classLimit.trim() === "" ? "Enter how many classes first; blank is Unlimited." : undefined}
                  className="w-64"
                >
                  {ALLOWANCE_BASES.map((b) => (
                    <option key={b} value={b}>{BASIS_LABELS[b]}</option>
                  ))}
                </Select>
              </div>
              {form.classLimitBasis === "weeks" && form.classLimit.trim() !== "" && (
                <>
                  <div>
                    <label htmlFor="tier-class-limit-weeks" className="mb-1 block text-[11px] text-tx-3">every</label>
                    <Select
                      id="tier-class-limit-weeks"
                      aria-label="every (weeks)"
                      value={form.classLimitWeeks}
                      onChange={(e) => setForm((f) => ({ ...f, classLimitWeeks: e.target.value }))}
                      className="w-28"
                    >
                      {CLASS_LIMIT_WEEK_OPTIONS.map((w) => (
                        <option key={w} value={String(w)}>{w} weeks</option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <label htmlFor="tier-class-limit-anchor" className="mb-1 block text-[11px] text-tx-3">periods count from</label>
                    <input
                      id="tier-class-limit-anchor"
                      type="date"
                      value={form.classLimitAnchor}
                      onChange={(e) => setForm((f) => ({ ...f, classLimitAnchor: e.target.value }))}
                      className="rounded-[var(--r-md)] border border-bd-default bg-sf-1 px-3 py-2 text-sm text-tx-1 outline-none transition-colors focus:border-bd-active"
                    />
                  </div>
                </>
              )}
            </div>
            {(() => {
              const note = allowanceNote(formAllowance(form), new Date(), timeZone);
              return (
                <div className="mt-1.5 space-y-1 text-[11px]" data-testid="tier-allowance-note">
                  <p className="text-tx-2" data-testid="tier-allowance-summary">{note.summary}</p>
                  {note.period && <p className="text-tx-3" data-testid="tier-allowance-period">{note.period}</p>}
                  {note.enforcement && <p className="text-tx-4">{note.enforcement}</p>}
                </div>
              );
            })()}
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
