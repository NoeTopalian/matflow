"use client";

/**
 * Owner Activity page (1 Oct 2026): every action every staff member took,
 * with per-row Undo where the audit row carries enough to put the entity
 * back, and "Undo everything since this" for one person. The server decides
 * reversibility (lib/undo-registry.ts) and says why when it refuses — this
 * component only shows those sentences, never invents its own.
 *
 * UI-RULES §7: an HTTP error is an ErrorState with retry, never an empty
 * list; the empty state is only for a genuinely empty filter.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/page-header";
import { useToast } from "@/components/ui/Toast";
import { formatDateTime } from "@/lib/date";
import { auditLabelWithUndo, isUndoAction } from "@/lib/audit-labels";

export type ActivityEntry = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  user: { id: string; name: string | null; email: string | null; role?: string | null } | null;
  undo: { ok: true } | { ok: false; reason: string };
};

export type StaffOption = { id: string; name: string; role: string };

type ApiPage = { entries: ActivityEntry[]; nextCursor: string | null; staff: StaffOption[] };

type PlanItem = { id: string; action: string; createdAt: string; reason?: string };
type Plan = { reversible: PlanItem[]; skipped: PlanItem[] };

const ACTION_GROUPS: { value: string; label: string }[] = [
  { value: "", label: "Everything" },
  { value: "member.", label: "Members" },
  { value: "attendance.", label: "Check-ins" },
  { value: "class.", label: "Classes" },
  { value: "membership.", label: "Plans" },
  { value: "payment", label: "Money" },
  { value: "staff.", label: "Staff" },
  { value: "tenant.", label: "Settings" },
  { value: "undo.", label: "Undos" },
];

function entityHref(e: ActivityEntry): string | null {
  switch (e.entityType) {
    case "Member":
      return `/dashboard/members/${e.entityId}`;
    case "Class":
      return "/dashboard/timetable";
    case "MembershipTier":
      return "/dashboard/memberships";
    case "Tenant":
      return "/dashboard/settings";
    case "User":
      return "/dashboard/settings?tab=staff";
    default:
      return null;
  }
}

function describeChanges(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const changes = meta.changes as Record<string, { from: unknown; to: unknown }> | undefined;
  if (changes && typeof changes === "object") {
    const parts = Object.entries(changes)
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${String(v.from ?? "—")} → ${String(v.to ?? "—")}`);
    return parts.join(" · ") + (Object.keys(changes).length > 3 ? " · …" : "");
  }
  const fields = meta.fields as string[] | undefined;
  if (Array.isArray(fields) && fields.length) return `Fields: ${fields.slice(0, 5).join(", ")}${fields.length > 5 ? "…" : ""}`;
  if (typeof meta.reason === "string") return `Reason: ${meta.reason}`;
  return null;
}

export default function ActivityLog({ initialStaff }: { initialStaff: StaffOption[] }) {
  const { toast } = useToast();
  const [staff, setStaff] = useState<StaffOption[]>(initialStaff);
  const [userId, setUserId] = useState("");
  const [group, setGroup] = useState("");
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; reference?: string | null } | null>(null);
  const [undoing, setUndoing] = useState<ActivityEntry | null>(null);
  const [undoTo, setUndoTo] = useState<{ entry: ActivityEntry; plan: Plan | null; planError: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const query = useCallback(
    (cursor?: string | null) => {
      const p = new URLSearchParams();
      p.set("take", "50");
      if (userId) p.set("userId", userId);
      if (group) p.set("action", group);
      if (cursor) p.set("cursor", cursor);
      return `/api/audit-log?${p.toString()}`;
    },
    [userId, group],
  );

  const load = useCallback(
    async (cursor?: string | null) => {
      if (!cursor) setLoading(true);
      setError(null);
      try {
        const res = await fetch(query(cursor));
        const data = (await res.json().catch(() => null)) as (ApiPage & { error?: string; reference?: string }) | null;
        if (!res.ok || !data) {
          setError({ message: data?.error ?? "Couldn't load the activity log.", reference: data?.reference ?? null });
          return;
        }
        setEntries((prev) => (cursor ? [...prev, ...data.entries] : data.entries));
        setNextCursor(data.nextCursor);
        if (data.staff?.length) setStaff(data.staff);
      } catch {
        setError({ message: "Couldn't reach MatFlow — nothing has changed." });
      } finally {
        setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function confirmUndo() {
    if (!undoing) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/audit-log/${encodeURIComponent(undoing.id)}/undo`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok) {
        toast(data.error ?? "Couldn't undo that.", "error");
        return;
      }
      toast(data.message ?? "Undone.", "success");
      setUndoing(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function openUndoTo(entry: ActivityEntry) {
    if (!entry.user) return;
    setUndoTo({ entry, plan: null, planError: null });
    try {
      const res = await fetch("/api/audit-log/undo-to", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: entry.user.id, auditId: entry.id, preview: true }),
      });
      const data = (await res.json().catch(() => ({}))) as Plan & { error?: string };
      if (!res.ok) {
        setUndoTo({ entry, plan: null, planError: data.error ?? "Couldn't work out what can be undone." });
        return;
      }
      setUndoTo({ entry, plan: { reversible: data.reversible ?? [], skipped: data.skipped ?? [] }, planError: null });
    } catch {
      setUndoTo({ entry, plan: null, planError: "Couldn't reach MatFlow — nothing has changed." });
    }
  }

  async function confirmUndoTo() {
    if (!undoTo?.entry.user) return;
    setBusy(true);
    try {
      const res = await fetch("/api/audit-log/undo-to", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: undoTo.entry.user.id, auditId: undoTo.entry.id, preview: false }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string; undone?: string[] };
      if (!res.ok) {
        toast(data.error ?? "Nothing was undone.", "error");
        return;
      }
      toast(data.message ?? `Undone ${data.undone?.length ?? 0} action(s).`, "success");
      setUndoTo(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<DataTableColumn<ActivityEntry>[]>(
    () => [
      {
        key: "when",
        header: "When",
        headerLabel: "When",
        width: "11rem",
        cell: (e) => <span className="tabular-nums" style={{ color: "var(--tx-2)" }}>{formatDateTime(e.createdAt)}</span>,
        sortValue: (e) => new Date(e.createdAt),
      },
      {
        key: "who",
        header: "Who",
        headerLabel: "Who",
        width: "12rem",
        cell: (e) => (
          <span className="truncate" style={{ color: "var(--tx-1)" }}>
            {e.user?.name ?? (e.user?.email ?? (e.action.startsWith("admin.") ? "MatFlow" : "System"))}
          </span>
        ),
      },
      {
        key: "what",
        header: "What",
        headerLabel: "What",
        wrap: true,
        cell: (e) => {
          const detail = describeChanges(e.metadata);
          const href = entityHref(e);
          return (
            <div className="min-w-0">
              <p className="truncate font-medium" style={{ color: "var(--tx-1)" }}>
                {href ? (
                  <a href={href} className="underline-offset-2 hover:underline">{auditLabelWithUndo(e.action)}</a>
                ) : (
                  auditLabelWithUndo(e.action)
                )}
              </p>
              {detail && <p className="truncate text-xs" style={{ color: "var(--tx-3)" }}>{detail}</p>}
            </div>
          );
        },
      },
      {
        key: "undo",
        header: "Undo",
        headerLabel: "Undo",
        width: "15rem",
        align: "right",
        cell: (e) =>
          isUndoAction(e.action) ? (
            <span className="text-xs" style={{ color: "var(--tx-3)" }}>Undo</span>
          ) : e.undo.ok ? (
            <div className="flex items-center justify-end gap-1.5">
              <Button variant="secondary" size="compact" onClick={() => setUndoing(e)} aria-label={`Undo: ${auditLabelWithUndo(e.action)}`}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Undo
              </Button>
              {e.user && (
                <Button variant="ghost" size="compact" onClick={() => void openUndoTo(e)} title="Undo everything this person did from here onwards">
                  Since here
                </Button>
              )}
            </div>
          ) : (
            <span className="text-xs" title={e.undo.reason} style={{ color: "var(--tx-3)" }}>
              Can&apos;t undo
            </span>
          ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Activity"
        description="Everything your staff have done in MatFlow, newest first. Undo puts a change back exactly as it was; where that isn't possible, the row says why. Kept for one year."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Staff member" className="w-[14rem]" value={userId} onChange={(ev) => setUserId(ev.target.value)}>
          <option value="">Everyone</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.role}
            </option>
          ))}
        </Select>
        <Select aria-label="Kind of action" className="w-[11rem]" value={group} onChange={(ev) => setGroup(ev.target.value)}>
          {ACTION_GROUPS.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </Select>
      </div>

      {error ? (
        <ErrorState message={error.message} reference={error.reference} onRetry={() => void load()} />
      ) : (
        <>
          <DataTable
            label="Activity log"
            columns={columns}
            rows={entries}
            rowKey={(e) => e.id}
            loading={loading}
            empty={<EmptyState title="Nothing recorded yet" hint="Actions by your staff will appear here as they happen." icon={<History className="h-5 w-5" aria-hidden="true" />} />}
            renderCard={(e) => (
              <div className="rounded-[var(--r-md)] border p-3" style={{ borderColor: "var(--bd-default)", background: "var(--sf-1)" }}>
                <p className="text-xs tabular-nums" style={{ color: "var(--tx-3)" }}>
                  {formatDateTime(e.createdAt)} · {e.user?.name ?? "System"}
                </p>
                <p className="mt-1 text-sm font-medium" style={{ color: "var(--tx-1)" }}>{auditLabelWithUndo(e.action)}</p>
                {describeChanges(e.metadata) && <p className="text-xs" style={{ color: "var(--tx-3)" }}>{describeChanges(e.metadata)}</p>}
                <div className="mt-2 flex items-center gap-2">
                  {!isUndoAction(e.action) && e.undo.ok ? (
                    <>
                      <Button variant="secondary" size="compact" onClick={() => setUndoing(e)}>Undo</Button>
                      {e.user && <Button variant="ghost" size="compact" onClick={() => void openUndoTo(e)}>Since here</Button>}
                    </>
                  ) : !isUndoAction(e.action) ? (
                    <span className="text-xs" style={{ color: "var(--tx-3)" }}>Can&apos;t undo — {e.undo.ok ? "" : e.undo.reason}</span>
                  ) : null}
                </div>
              </div>
            )}
          />
          {nextCursor && !loading && (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => void load(nextCursor)}>Show older</Button>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!undoing}
        onClose={() => { if (!busy) setUndoing(null); }}
        title={undoing ? `Undo: ${auditLabelWithUndo(undoing.action)}?` : "Undo?"}
        description="This puts the record back exactly as it was before that action. The undo itself is recorded and can't be undone."
        confirmLabel="Undo this"
        loading={busy}
        onConfirm={confirmUndo}
      />

      <ConfirmDialog
        open={!!undoTo}
        onClose={() => { if (!busy) setUndoTo(null); }}
        title={undoTo ? `Undo everything ${undoTo.entry.user?.name ?? "they"} did since here?` : "Undo?"}
        description={
          undoTo?.planError
            ? undoTo.planError
            : undoTo?.plan
              ? `${undoTo.plan.reversible.length} change(s) will be put back, newest first, in one step. ${undoTo.plan.skipped.length} can't be and will stay as they are. If any one of them has changed since, nothing is undone.`
              : "Working out what can be put back…"
        }
        confirmLabel={undoTo?.plan ? `Undo ${undoTo.plan.reversible.length} change(s)` : "Undo"}
        loading={busy || (!!undoTo && !undoTo.plan && !undoTo.planError)}
        destructive
        onConfirm={confirmUndoTo}
      >
        {undoTo?.plan && undoTo.plan.skipped.length > 0 && (
          <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-xs" style={{ color: "var(--tx-3)" }}>
            {undoTo.plan.skipped.map((s) => (
              <li key={s.id}>
                <span style={{ color: "var(--tx-2)" }}>{auditLabelWithUndo(s.action)}</span> — {s.reason}
              </li>
            ))}
          </ul>
        )}
      </ConfirmDialog>
    </div>
  );
}
