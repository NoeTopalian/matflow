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
import type { ConflictView, WithoutPlanView } from "@/app/api/admin/import/[id]/conflicts/route";

/** "1 member" / "2 members". */
export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}

/**
 * Said after an export time the owner gave as an estimate ("This is an
 * estimate" on the upload form), so nobody later reads it as the real time.
 * An owner-stated time, or no time, adds nothing.
 */
export const PROVISIONAL_NOTE = " · export time provisional";

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

/** People a job did not write: they differ from MatFlow or could not be matched with certainty (25 Oct 2026). */
function toReviewCount(job: ImportHistoryItem): number {
  return (job.toReview ? job.toReview.conflicts + job.toReview.ambiguous : 0) + (job.withoutPlan ?? 0);
}

function countsInWords(job: ImportHistoryItem): string | null {
  if (job.status !== "complete" && job.status !== "failed") return null;
  if (job.mode === "refresh") {
    if (!job.refresh) return null;
    // A refresh from 25 Oct 2026 on writes nothing to existing members: it lists differences.
    if (job.toReview) {
      return [
        `${plural(toReviewCount(job), "person", "people")} to review`,
        `${job.refresh.unchanged.toLocaleString("en-GB")} the same as MatFlow`,
        ...(job.refresh.exceptions > 0 ? [plural(job.refresh.exceptions, "exception", "exceptions")] : []),
        "nothing changed",
      ].join(" · ");
    }
    return [
      `${plural(job.refresh.changed, "member", "members")} changed`,
      `${job.refresh.unchanged.toLocaleString("en-GB")} unchanged`,
      ...(job.refresh.exceptions > 0 ? [plural(job.refresh.exceptions, "exception", "exceptions")] : []),
    ].join(" · ");
  }
  const noun = job.kind === "attendance" ? ["record", "records"] : ["member", "members"];
  // A member import that stopped part-way may have created people its counts
  // do not show (functional review F8, 30 Sep 2026): say so, never "0 imported".
  if (job.status === "failed" && job.kind !== "attendance" && !job.refresh) {
    return "Stopped part-way — people it created stay until you roll it back or run it again";
  }
  const parts = [`${plural(job.importedRows, noun[0], noun[1])} imported`];
  const review = toReviewCount(job);
  const sameAsMatFlow = job.skippedRows - review;
  if (review > 0) parts.push(`${plural(review, "person", "people")} to review`);
  if (sameAsMatFlow > 0) parts.push(`${sameAsMatFlow.toLocaleString("en-GB")} already in MatFlow`);
  if (job.errorRows > 0) {
    parts.push(job.kind === "attendance" ? `${job.errorRows.toLocaleString("en-GB")} held back` : plural(job.errorRows, "error", "errors"));
  }
  return parts.join(" · ");
}

export function RollbackOutcome({ job }: { job: ImportHistoryItem }) {
  const rb = job.rollback;
  if (!rb) return null;
  if (rb.kind === "refresh") {
    return (
      <div className="mt-2 text-xs text-tx-2" data-testid="history-rollback-outcome">
        <p className="font-semibold text-tx-1">
          Rolled back — {plural(rb.restored, "member", "members")} restored to their previous standing
        </p>
        {rb.kept.length > 0 && (
          <details className="mt-1" open>
            <summary className="cursor-pointer">
              {rb.kept.length.toLocaleString("en-GB")} kept because they changed after this refresh
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

type LastRefresh = {
  jobId: string;
  completedAt: string | null;
  sourceExportedAt: string | null;
  sourceExportedAtProvenance?: "owner_stated" | "provisional" | null;
} | null;

type ReviewState =
  | { phase: "closed" }
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; items: ConflictView[]; withoutPlan: WithoutPlanView[] };

export const REVIEW_ERROR = "Couldn't load the people to review — try again";

/**
 * The people an import or refresh did not write (owner decision 25 Oct 2026).
 * Read on demand from GET admin/import/[id]/conflicts, which re-reads each
 * member, so "MatFlow now" is current. Nothing here writes: each person links
 * to their own page, where the normal edit (and its permission check) applies.
 */
export function ReviewList({ jobId, count }: { jobId: string; count: number }) {
  const [state, setState] = useState<ReviewState>({ phase: "closed" });
  const open = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const res = await fetch(`/api/admin/import/${encodeURIComponent(jobId)}/conflicts`, { cache: "no-store" });
      if (!res.ok) { setState({ phase: "error" }); return; }
      const data = (await res.json()) as { conflicts?: ConflictView[]; withoutPlan?: WithoutPlanView[] };
      if (!Array.isArray(data.conflicts)) { setState({ phase: "error" }); return; }
      setState({ phase: "ready", items: data.conflicts, withoutPlan: Array.isArray(data.withoutPlan) ? data.withoutPlan : [] });
    } catch {
      setState({ phase: "error" });
    }
  }, [jobId]);

  const DATE_FIELDS = new Set(["dateOfBirth", "cancelledAt", "joinedAt"]);
  const WORDS: Record<string, string> = {
    active: "active", inactive: "inactive", cancelled: "cancelled", taster: "taster",
    paid: "paid", overdue: "overdue", paused: "on hold", pending: "no payment yet", free: "free",
    adult: "adult", junior: "junior", kids: "child", parent: "parent or guardian",
  };
  const show = (field: string, v: string | null) => {
    if (v === null || v === "") return "(none)";
    if (DATE_FIELDS.has(field)) return formatDate(v);
    if (field === "status" || field === "paymentStatus" || field === "accountType") return WORDS[v] ?? v;
    return v;
  };
  return (
    <div className="mt-2" data-testid="import-review">
      {state.phase === "closed" && (
        <Button type="button" variant="secondary" size="compact" onClick={() => void open()}>
          Review {plural(count, "person", "people")}
        </Button>
      )}
      {state.phase === "loading" && <Skeleton className="h-10 w-full" />}
      {state.phase === "error" && <ErrorState message={REVIEW_ERROR} onRetry={() => void open()} />}
      {state.phase === "ready" && (
        <div className="text-xs text-tx-2">
          <p className="mb-1">
            Nothing was changed for these people. MatFlow&rsquo;s values stand; open a person to change their record by hand if the file is right.
          </p>
          {state.items.length === 0 && state.withoutPlan.length === 0 && <p data-testid="import-review-empty">Nobody is left to review for this import.</p>}
          {state.withoutPlan.length > 0 && (
            <div className="mb-2" data-testid="import-review-without-plan">
              <p className="font-semibold text-tx-1">Imported without a plan ({state.withoutPlan.length.toLocaleString("en-GB")})</p>
              <p>Their plan name matched no single MatFlow plan, so none was set. Plan-restricted classes may refuse them until you set one on their page.</p>
              <ul className="mt-0.5 space-y-0.5">
                {state.withoutPlan.map((m) => (
                  <li key={m.id}>
                    <a className="underline" href={m.href}>{m.name}</a> — file says <strong>{m.planLabel}</strong>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ul className="space-y-2" data-testid="import-review-list">
            {state.items.map((c, i) =>
              c.kind === "ambiguous" ? (
                <li key={`a-${i}`} data-testid="import-review-ambiguous">
                  <strong className="text-tx-1">{c.name}</strong> — not matched: {c.reason}. Could be:{" "}
                  {c.members.map((m, j) => (
                    <span key={m.id}>
                      {j > 0 ? ", " : ""}
                      {m.href ? <a className="underline" href={m.href}>{m.name}</a> : "a member since deleted"}
                    </span>
                  ))}
                  . Nobody was created or changed.
                </li>
              ) : (
                <li key={`c-${i}`} data-testid="import-review-conflict">
                  {c.member.href ? (
                    <a className="font-semibold text-tx-1 underline" href={c.member.href}>{c.member.name}</a>
                  ) : (
                    <strong className="text-tx-1">{c.name}</strong>
                  )}
                  <ul className="mt-0.5 space-y-0.5">
                    {c.fields.map((f) => (
                      <li key={f.field}>
                        {f.label}: file says <strong>{show(f.field, f.upload)}</strong>; MatFlow now <strong>{show(f.field, f.now)}</strong>
                        {f.stillDiffers ? "" : " — matches now"}
                      </li>
                    ))}
                  </ul>
                </li>
              ),
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; jobs: ImportHistoryItem[]; lastRefresh: LastRefresh };

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
      const data = (await res.json()) as { jobs?: ImportHistoryItem[]; lastSuccessfulRefresh?: LastRefresh };
      if (!Array.isArray(data.jobs)) { setState({ phase: "error" }); return; }
      setState({ phase: "ready", jobs: data.jobs, lastRefresh: data.lastSuccessfulRefresh ?? null });
    } catch {
      setState({ phase: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function rollback(job: ImportHistoryItem) {
    const attendance = job.kind === "attendance";
    const refresh = job.mode === "refresh";
    const ok = await ask({
      title: attendance ? "Roll back this attendance import?" : refresh ? "Roll back this status refresh?" : "Roll back this import?",
      body: attendance
        ? "Removes the attendance records this import wrote, and the past class sessions it created that nothing else uses. Check-ins made in MatFlow are never touched. This cannot be undone."
        : refresh
        ? "Puts back the status, payment standing and plan each member had before this refresh. Anyone changed since — by staff or by a later refresh — is left as they are, and you will see who and why."
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

      {state.phase === "ready" && state.jobs.some((j) => j.mode === "refresh") && (
        <p className="mb-2 text-xs text-tx-2" data-testid="last-successful-refresh">
          {state.lastRefresh
            ? `Last successful status refresh: ${state.lastRefresh.sourceExportedAt ? `TeamUp export of ${formatDateTime(state.lastRefresh.sourceExportedAt)}${state.lastRefresh.sourceExportedAtProvenance === "provisional" ? PROVISIONAL_NOTE : ""}` : "export time not given"}${state.lastRefresh.completedAt ? `, run ${formatDateTime(state.lastRefresh.completedAt)}` : ""}.`
            : "No status refresh is currently standing."}
        </p>
      )}

      {state.phase === "ready" && state.jobs.length > 0 && (
        <ul className="space-y-2">
          {state.jobs.map((job) => {
            const counts = countsInWords(job);
            // A member rollback that kept people can be run again for the rest.
            const keptSome = (job.rollback?.kind === "members" || job.rollback?.kind === "refresh") && job.rollback.kept.length > 0;
            // A member import that failed part-way can be rolled back too (F8).
            const finished = job.status === "complete" || (job.status === "failed" && job.kind !== "attendance" && !job.refresh);
            // A refresh under the 25 Oct 2026 rule changed nobody, so there is nothing to roll back.
            const listedOnly = job.mode === "refresh" && job.toReview !== null && (job.refresh?.changed ?? 0) === 0;
            const canRollBack = finished && !listedOnly && (!job.rolledBackAt || keptSome);
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
                      {job.kind === "attendance" ? "Attendance history" : job.mode === "refresh" ? "Status refresh" : "Members"}
                      {" · "}{formatDateTime(job.createdAt)}
                      {" · "}<span className="text-tx-2">{statusInWords(job)}</span>
                    </p>
                    {counts && <p className="mt-0.5 text-xs text-tx-2">{counts}</p>}
                    <p className="mt-0.5 text-xs text-tx-3">
                      {job.sourceExportedAt
                        ? job.mode === "refresh"
                          ? `TeamUp export of ${formatDateTime(job.sourceExportedAt)}`
                          : `Source exported ${formatDate(job.sourceExportedAt)}`
                        : "Export date not given"}
                      {job.sourceExportedAt && job.sourceExportedAtProvenance === "provisional" && PROVISIONAL_NOTE}
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

                {toReviewCount(job) > 0 && <ReviewList jobId={job.id} count={toReviewCount(job)} />}

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
