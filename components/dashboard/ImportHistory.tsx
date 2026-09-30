"use client";

// The owner's import history, under the upload form in the Import panel.
//
// Until this existed the panel held the job it had just run in page state
// only: a reload lost it, so a past import could not be seen or rolled back,
// and the route's own "see import history for details" pointed at nothing
// (verifier, 30 Sep 2026, D1). Every job — member and attendance — is listed
// here from GET /api/admin/import, and a finished, not-yet-rolled-back one can
// be rolled back from its row.

import { useCallback, useEffect, useState } from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { describeApiError } from "@/lib/api-field-errors";
import { formatDate, formatDateTime } from "@/lib/date";
import type { ImportHistoryItem } from "@/app/api/admin/import/route";

/** "1 member" / "2 members". */
export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}

export const HISTORY_ERROR = "Couldn't load your import history — try again";

function statusInWords(job: ImportHistoryItem): string {
  if (job.rolledBackAt) return "Rolled back";
  switch (job.status) {
    case "pending": return "Uploaded, not previewed";
    case "preview": return "Previewed, not imported";
    case "running": return "Importing";
    case "complete": return "Imported";
    case "failed": return "Failed";
    default: return job.status;
  }
}

function countsInWords(job: ImportHistoryItem): string | null {
  if (job.status !== "complete" && job.status !== "failed") return null;
  const noun = job.kind === "attendance" ? ["record", "records"] : ["member", "members"];
  const parts = [`${plural(job.importedRows, noun[0], noun[1])} imported`];
  if (job.skippedRows > 0) parts.push(`${job.skippedRows.toLocaleString("en-GB")} skipped`);
  if (job.errorRows > 0) {
    parts.push(job.kind === "attendance" ? `${job.errorRows.toLocaleString("en-GB")} held back` : plural(job.errorRows, "error", "errors"));
  }
  return parts.join(" · ");
}

export function RollbackOutcome({ job }: { job: ImportHistoryItem }) {
  const rb = job.rollback;
  if (!rb) return null;
  if (rb.kind === "attendance") {
    return (
      <div className="mt-2 text-xs text-tx-2" data-testid="history-rollback-outcome">
        <p className="font-semibold text-tx-1">
          Rolled back — {plural(rb.recordsRemoved, "attendance record", "attendance records")} removed
        </p>
        {(rb.instancesRemoved > 0 || rb.instancesKept > 0) && (
          <p className="mt-0.5">
            {plural(rb.instancesRemoved, "past class session", "past class sessions")} it created removed
            {rb.instancesKept > 0 ? `; ${rb.instancesKept.toLocaleString("en-GB")} kept because they are now in use` : ""}.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="mt-2 text-xs text-tx-2" data-testid="history-rollback-outcome">
      <p className="font-semibold text-tx-1">
        Rolled back — {plural(rb.removed, "member", "members")} removed
      </p>
      {rb.kept.length > 0 && (
        <details className="mt-1" open>
          <summary className="cursor-pointer">
            {rb.kept.length.toLocaleString("en-GB")} kept because someone had already used them
          </summary>
          <ul className="mt-1 space-y-0.5">
            {rb.kept.map((k) => (
              <li key={k.memberId}><strong>{k.name}</strong> — {k.reasons.join(", ")}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; jobs: ImportHistoryItem[] };

export default function ImportHistory({
  refreshKey = 0,
  onChanged,
}: {
  /** Bump to reload the list (the panel does after every import). */
  refreshKey?: number;
  /** Called after a rollback from this list, so the panel can react. */
  onChanged?: (jobId: string) => void;
}) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [rowNote, setRowNote] = useState<{ id: string; message: string } | null>(null);
  const { ask, dialogProps } = useConfirmDialog();

  const load = useCallback(async () => {
    setState((s) => (s.phase === "ready" ? s : { phase: "loading" }));
    try {
      const res = await fetch("/api/admin/import", { cache: "no-store" });
      if (!res.ok) { setState({ phase: "error" }); return; }
      const data = (await res.json()) as { jobs?: ImportHistoryItem[] };
      if (!Array.isArray(data.jobs)) { setState({ phase: "error" }); return; }
      setState({ phase: "ready", jobs: data.jobs });
    } catch {
      setState({ phase: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function rollback(job: ImportHistoryItem) {
    const attendance = job.kind === "attendance";
    const ok = await ask({
      title: attendance ? "Roll back this attendance import?" : "Roll back this import?",
      body: attendance
        ? "Removes the attendance records this import wrote, and the past class sessions it created that nothing else uses. Check-ins made in MatFlow are never touched. This cannot be undone."
        : "Removes the members this import created, as long as nobody has touched them since — anyone who has signed in, checked in, paid, signed a waiver or been edited is kept, and you will see who and why. This cannot be undone.",
      confirmLabel: "Roll back",
      destructive: true,
    });
    if (!ok) return;
    setBusyId(job.id);
    setRowError(null);
    setRowNote(null);
    try {
      const res = attendance
        ? await fetch(`/api/admin/import/attendance?jobId=${encodeURIComponent(job.id)}`, { method: "DELETE" })
        : await fetch(`/api/admin/import/${encodeURIComponent(job.id)}/rollback`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hasSentence = typeof (data as { error?: unknown }).error === "string";
        setRowError({ id: job.id, message: hasSentence ? describeApiError(data) : "Rollback failed — nothing was removed." });
        return;
      }
      if (typeof (data as { message?: unknown }).message === "string") {
        setRowNote({ id: job.id, message: (data as { message: string }).message });
      }
      await load();
      onChanged?.(job.id);
    } catch {
      setRowError({ id: job.id, message: "Couldn't reach MatFlow, so we don't know whether the rollback ran. Refresh and check the import before trying again." });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section id="import-history" aria-labelledby="import-history-heading" className="mt-6 border-t border-bd-default pt-4">
      <h3 id="import-history-heading" className="mb-3 flex items-center gap-2 text-sm font-semibold text-tx-1">
        <History className="size-4" aria-hidden="true" />
        Import history
      </h3>

      {state.phase === "loading" && (
        <div className="space-y-2" aria-busy="true" aria-label="Loading import history">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      )}

      {state.phase === "error" && <ErrorState message={HISTORY_ERROR} onRetry={() => void load()} />}

      {state.phase === "ready" && state.jobs.length === 0 && (
        <EmptyState title="No imports yet" hint="Every file you import is listed here, and can be rolled back from here." />
      )}

      {state.phase === "ready" && state.jobs.length > 0 && (
        <ul className="space-y-2">
          {state.jobs.map((job) => {
            const counts = countsInWords(job);
            // A member rollback that kept people can be run again for the rest.
            const keptSome = job.rollback?.kind === "members" && job.rollback.kept.length > 0;
            const canRollBack = job.status === "complete" && (!job.rolledBackAt || keptSome);
            return (
              <li
                key={job.id}
                data-testid="import-history-row"
                className="rounded-[var(--r-md)] border border-bd-default bg-sf-2 px-3 py-2.5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-tx-1">{job.fileName}</p>
                    <p className="text-xs text-tx-3">
                      {job.kind === "attendance" ? "Attendance history" : "Members"}
                      {" · "}{formatDateTime(job.createdAt)}
                      {" · "}<span className="text-tx-2">{statusInWords(job)}</span>
                    </p>
                    {counts && <p className="mt-0.5 text-xs text-tx-2">{counts}</p>}
                    <p className="mt-0.5 text-xs text-tx-3">
                      {job.sourceExportedAt ? `Source exported ${formatDate(job.sourceExportedAt)}` : "Export date not given"}
                      {job.reconciles === true && " · every row accounted for"}
                      {job.reconciles === false && " · counts do not add up — check the errors"}
                    </p>
                  </div>
                  {canRollBack && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="compact"
                      loading={busyId === job.id}
                      disabled={busyId !== null}
                      onClick={() => void rollback(job)}
                    >
                      {busyId === job.id ? "Rolling back…" : job.rolledBackAt ? "Roll back the rest" : "Roll back"}
                    </Button>
                  )}
                </div>

                {job.status === "failed" && (
                  <p className="mt-1 text-xs text-[var(--hue-danger-ink)]">
                    This import stopped before it finished.
                    {job.rowErrors.length === 0 ? "" : " The first problems it recorded:"}
                  </p>
                )}
                {job.rowErrors.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-tx-2">
                    {job.rowErrors.map((e, i) => (
                      <li key={`${e.row}-${i}`}>Row {e.row}: {e.reason}</li>
                    ))}
                  </ul>
                )}

                <RollbackOutcome job={job} />

                {rowNote?.id === job.id && <p className="mt-1 text-xs text-tx-2">{rowNote.message}</p>}
                {rowError?.id === job.id && (
                  <p role="alert" className="mt-1 text-xs text-[var(--hue-danger-ink)]">{rowError.message}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog {...dialogProps} />
    </section>
  );
}
