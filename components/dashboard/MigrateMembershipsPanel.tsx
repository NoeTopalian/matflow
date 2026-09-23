"use client";

import { useMemo, useState } from "react";
import { ArrowRightLeft, CheckCircle2, MinusCircle, PlusCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { StatusPill } from "@/components/ui/StatusPill";
import { formatDate } from "@/lib/date";
import type { MigrationOutcome, MigrationPreview, MigrationReason, MigrationRow } from "@/lib/stripe/migrate-memberships";

/**
 * Settings → Revenue: move memberships from the club's previous platform
 * without anyone re-entering card details. Preview → tick → confirm. The
 * table is the whole product here: every row says what will happen, on which
 * plan, on which date, or exactly why nothing can happen yet.
 */

const REASON_COPY: Record<MigrationReason, string> = {
  already_linked: "Already on a MatFlow subscription",
  no_customer: "No Stripe customer with this email",
  needs_tier: "No tier matches this Stripe price — add one with the same amount and cycle",
  ambiguous_tier: "Two tiers match this price — set the Stripe price id on the right one",
  no_tier: "Member has no membership tier",
  tier_not_recurring: "Tier is one-off, nothing to bill",
  no_payment_method: "No saved card or Direct Debit — this member will need to re-enter details",
  bacs_not_enabled: "Saved Direct Debit, but Direct Debit is switched off above",
  no_due_date: "No next due date on the member",
  due_date_past: "Next due date has passed — set it to the next charge date",
};

const PILL = {
  adopt: { bg: "color-mix(in srgb, var(--hue-success) 12%, transparent)", color: "var(--hue-success-ink)" },
  create: { bg: "color-mix(in srgb, var(--hue-info) 12%, transparent)", color: "var(--hue-info-ink)" },
  skip: { bg: "color-mix(in srgb, var(--tx-3) 12%, transparent)", color: "var(--tx-2)" },
} as const;

function formatMoney(pence: number | null, currency: string | null): string {
  if (pence == null) return "—";
  const symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency === "USD" ? "$" : `${currency ?? ""} `;
  return `${symbol}${(pence / 100).toFixed(2)}`;
}

function actionLabel(row: MigrationRow): string {
  if (row.action === "adopt") return "Keep existing subscription";
  if (row.action === "create") return "Start on saved card";
  return "Nothing yet";
}

function outcomeLabel(o: MigrationOutcome): string {
  switch (o.outcome) {
    case "adopted": return "Linked — subscription unchanged";
    case "created": return "Subscription created";
    case "would_adopt": return "Would link";
    case "would_create": return "Would create";
    case "skipped": return REASON_COPY[o.reason];
    case "error": return o.message;
  }
}

export default function MigrateMembershipsPanel() {
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [outcomes, setOutcomes] = useState<Map<string, MigrationOutcome> | null>(null);

  const actionable = useMemo(
    () => (preview?.rows ?? []).filter((r) => r.action !== "skip"),
    [preview],
  );
  const chosen = useMemo(() => actionable.filter((r) => selected.has(r.memberId)), [actionable, selected]);
  const chosenAdopt = chosen.filter((r) => r.action === "adopt").length;
  const chosenCreate = chosen.filter((r) => r.action === "create").length;
  const chosenDates = useMemo(
    () => [...new Set(chosen.filter((r) => r.action === "create" && r.firstChargeAt).map((r) => r.firstChargeAt!.slice(0, 10)))].sort(),
    [chosen],
  );

  async function loadPreview() {
    setLoading(true);
    setError(null);
    setOutcomes(null);
    try {
      const res = await fetch("/api/stripe/migrate-memberships", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `Could not read your Stripe customers (${res.status})`);
        setPreview(null);
        return;
      }
      setPreview(data as MigrationPreview);
      setSelected(new Set((data as MigrationPreview).rows.filter((r) => r.action !== "skip").map((r) => r.memberId)));
    } catch {
      setError("Could not reach MatFlow — check your connection and try again");
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }

  async function apply() {
    setApplying(true);
    try {
      const res = await fetch("/api/stripe/migrate-memberships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberIds: chosen.map((r) => r.memberId) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `Migration failed (${res.status})`);
        return;
      }
      const map = new Map<string, MigrationOutcome>();
      for (const o of (data as { outcomes: MigrationOutcome[] }).outcomes) map.set(o.memberId, o);
      setOutcomes(map);
      setConfirmOpen(false);
    } catch {
      setError("Could not reach MatFlow — the migration may not have run. Preview again before retrying.");
    } finally {
      setApplying(false);
    }
  }

  function toggle(memberId: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(memberId); else next.delete(memberId);
      return next;
    });
  }

  const allChosen = actionable.length > 0 && actionable.every((r) => selected.has(r.memberId));

  const columns: DataTableColumn<MigrationRow>[] = [
    {
      key: "pick",
      header: (
        <Checkbox
          checked={allChosen}
          onCheckedChange={(on) => setSelected(on ? new Set(actionable.map((r) => r.memberId)) : new Set())}
          disabled={actionable.length === 0 || outcomes !== null}
          aria-label="Select every member that can be moved"
        />
      ),
      headerLabel: "Move",
      width: "3rem",
      cell: (r) =>
        r.action === "skip" ? (
          <span aria-hidden="true" className="text-tx-3">—</span>
        ) : (
          <Checkbox
            checked={selected.has(r.memberId)}
            onCheckedChange={(on) => toggle(r.memberId, on)}
            disabled={outcomes !== null}
            aria-label={`Move ${r.memberName}`}
          />
        ),
    },
    {
      key: "member",
      header: "Member",
      sortValue: (r) => r.memberName,
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-tx-1">{r.memberName}</p>
          <p className="truncate text-xs text-tx-3">{r.memberEmail}</p>
        </div>
      ),
    },
    {
      key: "action",
      header: "What happens",
      sortValue: (r) => r.action,
      wrap: true,
      cell: (r) => {
        const o = outcomes?.get(r.memberId);
        if (o) {
          const ok = o.outcome === "adopted" || o.outcome === "created";
          return (
            <div className="flex items-start gap-1.5">
              {ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" style={{ color: "var(--hue-success-ink)" }} /> : <MinusCircle className="mt-0.5 size-4 shrink-0" style={{ color: "var(--hue-warning-ink)" }} />}
              <span className="text-sm text-tx-1">{outcomeLabel(o)}</span>
            </div>
          );
        }
        return (
          <div className="min-w-0">
            <StatusPill
              icon={r.action === "adopt" ? ArrowRightLeft : r.action === "create" ? PlusCircle : MinusCircle}
              label={actionLabel(r)}
              bg={PILL[r.action].bg}
              color={PILL[r.action].color}
            />
            {r.reason && <p className="mt-1 text-xs text-tx-2">{REASON_COPY[r.reason]}</p>}
            {r.action === "create" && r.paymentMethod && <p className="mt-1 text-xs text-tx-2">{r.paymentMethod.label}</p>}
          </div>
        );
      },
    },
    {
      key: "plan",
      header: "Plan",
      sortValue: (r) => r.tierName ?? "",
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-tx-1">{r.tierName ?? "—"}</p>
          <p className="text-xs text-tx-3">
            {r.amountPence != null ? `${formatMoney(r.amountPence, r.currency)}${r.cycleLabel ? ` · ${r.cycleLabel}` : ""}` : ""}
          </p>
        </div>
      ),
    },
    {
      key: "first",
      header: "First MatFlow charge",
      sortValue: (r) => r.firstChargeAt,
      cell: (r) => <span className="text-sm text-tx-1">{r.firstChargeAt ? formatDate(r.firstChargeAt) : "—"}</span>,
    },
  ];

  return (
    <div className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-tx-1 font-semibold text-sm">Move memberships from your previous platform</p>
          <p className="text-tx-3 text-xs mt-1">
            Uses the cards and Direct Debits already saved in your Stripe account, so members do not re-enter anything.
            Existing Stripe subscriptions are kept as they are; members without one start on their next due date.
            Preview first — nothing changes until you confirm.
          </p>
        </div>
        <Button variant="secondary" onClick={loadPreview} loading={loading} disabled={loading} className="shrink-0 self-start">
          {preview ? "Preview again" : "Preview memberships"}
        </Button>
      </div>

      {error && (
        <ErrorState className="mt-4" message={error} onRetry={loadPreview} />
      )}

      {preview && !error && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-tx-2" data-testid="migrate-summary">
            {preview.summary.adopt} with an existing subscription to keep · {preview.summary.create} to start on a saved payment method · {preview.summary.skip} not ready
            {preview.summary.unmatchedCustomers > 0 && ` · ${preview.summary.unmatchedCustomers} Stripe customers with no member here`}
          </p>

          {preview.rows.length === 0 ? (
            <EmptyState title="No members to move" hint="Import your roster first, then preview again." />
          ) : (
            <DataTable
              label="Memberships to move"
              columns={columns}
              rows={preview.rows}
              rowKey={(r) => r.memberId}
              renderCard={(r) => (
                <div className="rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-tx-1">{r.memberName}</p>
                      <p className="truncate text-xs text-tx-3">{r.memberEmail}</p>
                    </div>
                    {r.action !== "skip" && (
                      <Checkbox checked={selected.has(r.memberId)} onCheckedChange={(on) => toggle(r.memberId, on)} disabled={outcomes !== null} aria-label={`Move ${r.memberName}`} />
                    )}
                  </div>
                  <div>{columns[2].cell(r)}</div>
                  <p className="text-xs text-tx-2">
                    {r.tierName ?? "No plan"}{r.amountPence != null ? ` · ${formatMoney(r.amountPence, r.currency)}${r.cycleLabel ? ` · ${r.cycleLabel}` : ""}` : ""}
                    {r.firstChargeAt ? ` · first charge ${formatDate(r.firstChargeAt)}` : ""}
                  </p>
                </div>
              )}
            />
          )}

          {outcomes === null && actionable.length > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-tx-3">
                {chosen.length} of {actionable.length} selected.
                {chosenDates.length > 0 && ` First charges from ${formatDate(chosenDates[0])} — end those memberships on your old platform before then.`}
              </p>
              <Button onClick={() => setConfirmOpen(true)} disabled={chosen.length === 0} className="self-start sm:self-auto">
                Move {chosen.length} {chosen.length === 1 ? "membership" : "memberships"}
              </Button>
            </div>
          )}

          {outcomes !== null && (
            <p className="text-sm text-tx-1" role="status">
              Done: {[...outcomes.values()].filter((o) => o.outcome === "adopted").length} linked, {[...outcomes.values()].filter((o) => o.outcome === "created").length} started,
              {" "}{[...outcomes.values()].filter((o) => o.outcome === "error" || o.outcome === "skipped").length} not moved. Each row above says why.
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => { if (!applying) setConfirmOpen(false); }}
        onConfirm={apply}
        loading={applying}
        title={`Move ${chosen.length} ${chosen.length === 1 ? "membership" : "memberships"}?`}
        confirmLabel="Move memberships"
        description={
          <span>
            {chosenAdopt > 0 && <>{chosenAdopt} will be linked to the subscription they already have in Stripe — nothing about it changes. </>}
            {chosenCreate > 0 && (
              <>
                {chosenCreate} will get a new subscription on their saved payment method, charged first on
                {chosenDates.length === 1 ? ` ${formatDate(chosenDates[0])}` : ` dates from ${formatDate(chosenDates[0])} to ${formatDate(chosenDates[chosenDates.length - 1])}`}
                {" "}and then every cycle. Nobody is charged today.
              </>
            )}
          </span>
        }
      >
        {chosenCreate > 0 && (
          <p className="text-xs" style={{ color: "var(--hue-warning-ink)" }}>
            End these memberships on your previous platform before their first MatFlow charge, or members will be charged by both.
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
