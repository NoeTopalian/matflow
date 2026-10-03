"use client";

/**
 * Settings → Import: an independent, read-only check of a finished import
 * (3 Oct 2026, Total BJJ handover). It re-counts the club's own rows and
 * compares them with what the importer recorded — see
 * lib/import-reconciliation.ts. Counts and source row numbers only.
 *
 * Runs on click, not on view: each run reads every member of the import and is
 * rate-limited, so opening the tab spends nothing (the ExportCsvButton lesson).
 */
import { useState } from "react";
import { Check, Minus, RefreshCcw, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/ErrorState";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/Skeleton";
import { describeApiError } from "@/lib/api-field-errors";
import { formatDate } from "@/lib/date";
import type { ReconCheck, ReconciliationResult } from "@/lib/import-reconciliation";

type JobLine = { id: string; source: string; status: string; createdAt: string; rolledBack: boolean };
type Payload = { jobs: JobLine[]; result: ReconciliationResult | null };
type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string; reference: string | null }
  | { kind: "ready"; data: Payload };

function CheckIcon({ c }: { c: ReconCheck }) {
  if (c.ok === null) return <Minus className="size-4 text-tx-4" aria-label="Count only" />;
  if (c.ok) return <Check className="size-4 text-[var(--hue-success-ink)]" aria-label="Matches" />;
  if (c.kind === "baseline") return <TriangleAlert className="size-4 text-[var(--hue-warning-ink)]" aria-label="Changed since import" />;
  return <X className="size-4 text-[var(--hue-danger-ink)]" aria-label="Does not match" />;
}

function verdict(c: ReconCheck): string {
  if (c.ok === null) return "Count";
  if (c.ok) return "Matches";
  return c.kind === "baseline" ? "Changed since import" : "Does not match";
}

export default function ImportReconciliation() {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function run(jobId?: string) {
    setState({ kind: "loading" });
    try {
      const res = await fetch(`/api/settings/import-reconciliation${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ""}`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setState({
          kind: "error",
          message: res.status === 429 ? "You've run this check several times in the last hour. Try again shortly." : describeApiError(body),
          reference: (body as { reference?: string } | null)?.reference ?? null,
        });
        return;
      }
      setState({ kind: "ready", data: body as Payload });
    } catch {
      setState({ kind: "error", message: "Couldn't reach MatFlow. Check your connection and try again.", reference: null });
    }
  }

  const result = state.kind === "ready" ? state.data.result : null;
  const groups = result
    ? result.checks.reduce<Map<string, ReconCheck[]>>((m, c) => m.set(c.group, [...(m.get(c.group) ?? []), c]), new Map())
    : null;

  return (
    <Card className="mt-6 space-y-4" data-testid="import-reconciliation">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-tx-1">
            <ShieldCheck className="size-4 text-tx-3" aria-hidden="true" /> Check an import
          </h3>
          <p className="mt-1 max-w-prose text-xs text-tx-3">
            Re-counts the members, plans and family links an import created, straight from your club&apos;s records, and compares them with what the import reported. Read-only: it changes nothing.
          </p>
        </div>
        <Button variant="secondary" size="compact" onClick={() => void run(result?.job.id)} loading={state.kind === "loading"}>
          {state.kind === "idle" ? null : <RefreshCcw className="size-3.5" aria-hidden="true" />}
          {state.kind === "idle" ? "Check the latest import" : "Run again"}
        </Button>
      </div>

      {state.kind === "loading" && (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {state.kind === "error" && <ErrorState message={state.message} reference={state.reference} onRetry={() => void run(result?.job.id)} />}

      {state.kind === "ready" && !result && (
        <p className="text-sm text-tx-2">There is no member import to check yet.</p>
      )}

      {state.kind === "ready" && result && groups && (
        <div className="space-y-4">
          {state.data.jobs.length > 1 && (
            <Select aria-label="Import to check" value={result.job.id} onChange={(e) => void run(e.target.value)} className="w-full sm:w-auto">
              {state.data.jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {`${j.source === "teamup" ? "TeamUp" : j.source} · ${formatDate(j.createdAt)} · ${j.rolledBack ? "rolled back" : j.status}`}
                </option>
              ))}
            </Select>
          )}

          <p role="status" className="text-sm text-tx-1">
            {result.summary.invariantsFailed === 0 ? "Every fixed check matches." : `${result.summary.invariantsFailed} check${result.summary.invariantsFailed === 1 ? "" : "s"} do not match.`}
            {result.summary.baselinesMoved > 0 ? ` ${result.summary.baselinesMoved} changed since the import.` : ""}
            <span className="text-tx-3">{` ${result.summary.passed} matched · import of ${formatDate(result.job.createdAt)}`}</span>
          </p>

          {[...groups.entries()].map(([group, checks]) => (
            <section key={group}>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-tx-3">{group}</h4>
              <ul className="divide-y divide-[var(--bd-default)] rounded-[var(--r-md)] border border-bd-default">
                {checks.map((c) => (
                  <li key={`${c.group}:${c.check}`} className="flex items-start gap-3 px-3 py-2 text-[13px]">
                    <span className="mt-0.5"><CheckIcon c={c} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="text-tx-1">{c.check}</span>
                        <span className="tabular-nums text-tx-2">
                          {c.expected === null || c.ok === null ? String(c.actual) : `expected ${c.expected} · found ${c.actual}`}
                          <span className="sr-only">{` — ${verdict(c)}`}</span>
                        </span>
                      </div>
                      {c.ok === false && c.note && <p className="mt-0.5 text-xs text-tx-3">{c.note}</p>}
                      {c.ok === false && c.sourceRows && (
                        <p className="mt-0.5 text-xs text-tx-3">Source rows: {c.sourceRows.join(", ")}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {result.planLabels.length > 0 && (
            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-tx-3">Plan labels in the file</h4>
              <ul className="divide-y divide-[var(--bd-default)] rounded-[var(--r-md)] border border-bd-default">
                {result.planLabels.map((l) => (
                  <li key={l.label} className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-2 text-[13px]">
                    <span className="text-tx-1">{l.label}</span>
                    <span className="tabular-nums text-tx-2">
                      {`${l.liveRows} live · ${l.rows} rows · `}
                      <span className={l.tierMatched || l.liveRows === 0 ? "text-tx-2" : "text-[var(--hue-warning-ink)]"}>
                        {l.tierMatched ? "tier found" : "no tier of this name"}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Card>
  );
}
