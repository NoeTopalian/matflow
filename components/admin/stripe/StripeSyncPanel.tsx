"use client";

// Stripe sync state for the operator console (payments lane PD, 11 Oct 2026;
// audit §19). Reads GET /api/admin/stripe/events. A failed load is an error
// with retry, never an empty page (UI-RULES §7). No secrets, no payloads, no
// personal data: event ids, types, statuses, attempts and the sanitised last
// error only. The one action is Replay (step-up + reason), for events that
// failed or were never processed.

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/ErrorState";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { useToast } from "@/components/ui/Toast";
import { formatDateTime } from "@/lib/date";
import ReplayDialog, { type ReplayTarget } from "./ReplayDialog";

type EventRow = {
  eventId: string;
  type: string;
  status: string;
  created: number;
  attempts: number;
  lastError: string | null;
  firstSeenAt: string;
  lastAttemptAt: string | null;
  reconcileFoundAt: string | null;
  tenantId: string | null;
  stripeAccountId?: string | null;
};

type Club = {
  tenantId: string;
  name: string;
  stripeAccountId: string | null;
  stripeConnected: boolean;
  account: {
    chargesEnabled: boolean | null;
    payoutsEnabled: boolean | null;
    requirementsPastDue: number | null;
    disabledReason: string | null;
    refreshedAt: string | null;
  } | null;
  counts: { last24h: Record<string, number>; last7d: Record<string, number> };
  lastEventAt: string | null;
  attention: EventRow[];
};

type Mismatch = {
  tenantId: string;
  kind: "subscription" | "payment";
  objectId: string;
  recordId: string;
  field: string;
  stored: string | number | null;
  stripe: string | number | null;
};

type Run = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  trigger: string;
  tenantsChecked: number;
  tenantsSkipped: number;
  eventsScanned: number;
  eventsMissing: number;
  stateMismatches: Mismatch[] | null;
  skipped: { tenants?: Array<{ tenantId: string; stripeAccountId: string; unprocessedInStore: number }> } | null;
  errors: Array<{ tenantId: string | null; code: string }> | null;
};

type Overview = { generatedAt: string; clubs: Club[]; unattributed: EventRow[]; lastRun: Run | null };

type LoadState = { kind: "loading" } | { kind: "error"; reference: string | null } | { kind: "ready"; data: Overview };

const STATUS_LABEL: Record<string, string> = {
  received: "Received, not processed",
  processed: "Processed",
  failed: "Failed",
  ignored_foreign: "Not MatFlow's",
  ignored_stale: "Out of date",
  ignored_mode: "Wrong mode (test/live)",
  replayed: "Replayed",
};

const STATUS_TONE: Record<string, string> = {
  failed: "text-[var(--hue-danger-ink)]",
  received: "text-[var(--hue-warning-ink)]",
  processed: "text-[var(--hue-success-ink)]",
  replayed: "text-[var(--hue-success-ink)]",
};

// Codes only reach this page (lib/stripe/reconcile.ts reconcileErrorCode); Stripe's own text stays in the server log.
const ERROR_LABEL: Record<string, string> = {
  account_invalid: "Stripe says the account id is not valid for this platform",
  permission_error: "MatFlow has no permission on this account",
  authentication_error: "Stripe refused the platform key",
  rate_limited: "Stripe rate limit reached",
  timeout: "Stripe did not answer in time",
  connection_error: "Stripe could not be reached",
  stripe_api_error: "Stripe returned an error",
  invalid_request: "Stripe refused the request",
  internal_error: "MatFlow error while checking",
  stripe_not_configured: "Stripe is not configured",
};

const RUN_LABEL: Record<string, string> = {
  running: "Running",
  ok: "No drift found",
  mismatches: "Drift found",
  errors: "Some clubs could not be checked",
  skipped: "Skipped (Stripe not configured)",
};

function statusText(status: string) {
  return <span className={`font-medium ${STATUS_TONE[status] ?? "text-tx-2"}`}>{STATUS_LABEL[status] ?? status}</span>;
}

function yesNo(v: boolean | null) {
  return v === null ? "Unknown" : v ? "Yes" : "No";
}

function CountLine({ label, counts }: { label: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]">
      <span className="text-tx-3">{label}</span>
      {entries.length === 0 ? (
        <span className="text-tx-3">No events</span>
      ) : (
        entries.map(([status, n]) => (
          <span key={status} className="text-tx-2">
            {STATUS_LABEL[status] ?? status}: <span className="font-medium text-tx-1">{n}</span>
          </span>
        ))
      )}
    </div>
  );
}

function eventColumns(onReplay: ((e: EventRow) => void) | null): DataTableColumn<EventRow>[] {
  const cols: DataTableColumn<EventRow>[] = [
    { key: "type", header: "Type", cell: (e) => <span className="font-mono text-[12px]">{e.type}</span> },
    { key: "status", header: "Status", cell: (e) => statusText(e.status) },
    { key: "created", header: "Created at Stripe", cell: (e) => (e.created ? formatDateTime(new Date(e.created * 1000)) : "Unknown") },
    {
      key: "attempts",
      header: "Attempts",
      align: "right",
      cell: (e) => (e.reconcileFoundAt && e.attempts === 0 ? "0 (found by reconcile)" : String(e.attempts)),
    },
    {
      key: "lastError",
      header: "Last error",
      wrap: true,
      cell: (e) => <span className="line-clamp-1 text-tx-3" title={e.lastError ?? undefined}>{e.lastError ?? "None recorded"}</span>,
    },
    { key: "eventId", header: "Event", cell: (e) => <span className="font-mono text-[12px] text-tx-3">{e.eventId}</span> },
  ];
  if (onReplay) {
    cols.push({
      key: "action",
      header: "",
      align: "right",
      cell: (e) => (
        <Button type="button" size="compact" variant="secondary" onClick={() => onReplay(e)}>
          Replay
        </Button>
      ),
    });
  }
  return cols;
}

function ClubCard({ club, onReplay }: { club: Club; onReplay: (e: EventRow) => void }) {
  return (
    <Card padding="tight" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-[15px] font-semibold text-tx-1">{club.name}</h3>
          <p className="font-mono text-[12px] text-tx-3">{club.stripeAccountId ?? "No connected account"}</p>
        </div>
        <span className={`text-[13px] font-medium ${club.stripeConnected ? "text-[var(--hue-success-ink)]" : "text-[var(--hue-danger-ink)]"}`}>
          {club.stripeConnected ? "Connected" : club.stripeAccountId ? "Access withdrawn" : "Not connected"}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-4">
        <div>
          <dt className="text-tx-3">Charges enabled</dt>
          <dd className="text-tx-1">{yesNo(club.account?.chargesEnabled ?? null)}</dd>
        </div>
        <div>
          <dt className="text-tx-3">Payouts enabled</dt>
          <dd className="text-tx-1">{yesNo(club.account?.payoutsEnabled ?? null)}</dd>
        </div>
        <div>
          <dt className="text-tx-3">Status refreshed</dt>
          <dd className="text-tx-1">{club.account?.refreshedAt ? formatDateTime(club.account.refreshedAt) : "Never"}</dd>
        </div>
        <div>
          <dt className="text-tx-3">Last event</dt>
          <dd className="text-tx-1">{club.lastEventAt ? formatDateTime(club.lastEventAt) : "None recorded"}</dd>
        </div>
      </dl>
      {club.account?.disabledReason ? (
        <p className="text-[13px] text-[var(--hue-warning-ink)]">Stripe reports: {club.account.disabledReason}</p>
      ) : null}
      <CountLine label="Last 24 hours" counts={club.counts.last24h} />
      <CountLine label="Last 7 days" counts={club.counts.last7d} />
      {club.attention.length > 0 ? (
        <DataTable
          label={`Events needing attention at ${club.name}`}
          columns={eventColumns(club.stripeConnected ? onReplay : null)}
          rows={club.attention}
          rowKey={(e) => e.eventId}
        />
      ) : (
        <p className="text-[13px] text-tx-3">No failed or unprocessed events.</p>
      )}
    </Card>
  );
}

function RunCard({ run, clubName }: { run: Run | null; clubName: (id: string) => string }) {
  if (!run) {
    return (
      <Card padding="tight">
        <EmptyState title="No reconcile run on record" hint="The daily job is off until STRIPE_RECONCILE_ENABLED is set to true." />
      </Card>
    );
  }
  const mismatches = run.stateMismatches ?? [];
  const skipped = run.skipped?.tenants ?? [];
  const errors = run.errors ?? [];
  return (
    <Card padding="tight" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-tx-1">Last reconcile run</h2>
        <span className="text-[13px] text-tx-3">
          {formatDateTime(run.startedAt)} · {run.trigger === "cron" ? "scheduled" : "manual"}
        </span>
      </div>
      <p className={`text-[13px] font-medium ${run.status === "ok" ? "text-[var(--hue-success-ink)]" : run.status === "running" ? "text-tx-2" : "text-[var(--hue-danger-ink)]"}`}>
        {RUN_LABEL[run.status] ?? run.status}
      </p>
      <p className="text-[13px] text-tx-2">
        Clubs checked {run.tenantsChecked} · skipped {run.tenantsSkipped} · events scanned {run.eventsScanned} · missing events recorded {run.eventsMissing} · state mismatches {mismatches.length}
      </p>
      {mismatches.length > 0 ? (
        <DataTable
          label="State mismatches"
          columns={[
            { key: "club", header: "Club", cell: (m: Mismatch) => clubName(m.tenantId) },
            { key: "kind", header: "Kind", cell: (m: Mismatch) => m.kind },
            { key: "object", header: "Stripe object", cell: (m: Mismatch) => <span className="font-mono text-[12px]">{m.objectId}</span> },
            { key: "field", header: "Field", cell: (m: Mismatch) => m.field },
            { key: "stored", header: "MatFlow", cell: (m: Mismatch) => String(m.stored ?? "none") },
            { key: "stripe", header: "Stripe", cell: (m: Mismatch) => String(m.stripe ?? "none") },
          ]}
          rows={mismatches}
          rowKey={(m) => `${m.tenantId}:${m.objectId}:${m.field}:${m.recordId}`}
        />
      ) : null}
      {skipped.length > 0 ? (
        <div className="text-[13px] text-tx-2">
          <p className="font-medium text-tx-1">Not checked: Stripe access withdrawn</p>
          <ul className="list-disc pl-5">
            {skipped.map((s) => (
              <li key={s.tenantId}>
                {clubName(s.tenantId)} ({s.stripeAccountId}): {s.unprocessedInStore} unprocessed event{s.unprocessedInStore === 1 ? "" : "s"} on record
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {errors.length > 0 ? (
        <div className="text-[13px] text-[var(--hue-danger-ink)]">
          <p className="font-medium">Errors</p>
          <ul className="list-disc pl-5">
            {errors.map((e, i) => (
              <li key={`${e.tenantId}:${i}`}>
                {e.tenantId ? clubName(e.tenantId) : "Run"}: {ERROR_LABEL[e.code] ?? e.code}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

async function fetchOverview(): Promise<LoadState> {
  try {
    const res = await fetch("/api/admin/stripe/events", { cache: "no-store" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { reference?: string };
      return { kind: "error", reference: body.reference ?? null };
    }
    return { kind: "ready", data: (await res.json()) as Overview };
  } catch {
    return { kind: "error", reference: null };
  }
}

export default function StripeSyncPanel() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [target, setTarget] = useState<ReplayTarget | null>(null);
  const { toast } = useToast();

  // The effect only subscribes: the state is set when the fetch settles, never
  // synchronously in the effect body. A reload shows the skeleton first.
  useEffect(() => {
    let live = true;
    void fetchOverview().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);
  const load = useCallback(() => {
    setState({ kind: "loading" });
    void fetchOverview().then(setState);
  }, []);

  if (state.kind === "loading") {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (state.kind === "error") {
    return <ErrorState message="Couldn't load the Stripe sync state." reference={state.reference} onRetry={load} />;
  }

  const { clubs, unattributed, lastRun, generatedAt } = state.data;
  const names = new Map(clubs.map((c) => [c.tenantId, c.name]));
  const clubName = (id: string) => names.get(id) ?? id;
  const openReplay = (club: Club) => (e: EventRow) =>
    setTarget({ tenantId: club.tenantId, eventId: e.eventId, type: e.type, clubName: club.name });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-tx-3">
        <span>As of {formatDateTime(generatedAt)}</span>
        <Button type="button" variant="secondary" size="compact" onClick={load}>
          Refresh
        </Button>
      </div>
      <RunCard run={lastRun} clubName={clubName} />
      {clubs.length === 0 ? (
        <Card padding="tight">
          <EmptyState title="No club has a connected Stripe account" />
        </Card>
      ) : (
        clubs.map((club) => <ClubCard key={club.tenantId} club={club} onReplay={openReplay(club)} />)
      )}
      {unattributed.length > 0 ? (
        <Card padding="tight" className="flex flex-col gap-3">
          <h2 className="text-[15px] font-semibold text-tx-1">Events from accounts linked to no club</h2>
          <p className="text-[13px] text-tx-3">These cannot be replayed until the account is linked to a club.</p>
          <DataTable label="Events from unlinked accounts" columns={eventColumns(null)} rows={unattributed} rowKey={(e) => e.eventId} />
        </Card>
      ) : null}
      <ReplayDialog
        target={target}
        onClose={() => setTarget(null)}
        onDone={(message, ok) => {
          setTarget(null);
          toast(message, ok ? "success" : "error");
          load();
        }}
      />
    </div>
  );
}
