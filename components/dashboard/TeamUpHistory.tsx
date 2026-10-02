"use client";

/**
 * "Membership history from TeamUp" (teamup-2, 2 Oct 2026): every source row the
 * import kept for this member, as TeamUp recorded it. These are imported facts,
 * never MatFlow purchases — nothing here was charged, signed up or paid through
 * MatFlow, and the copy says so. The standing line names a decision (two plans
 * active at TeamUp) or a scheduled start without choosing either.
 *
 * An HTTP failure is an error state with a retry, never "no history" (UI-RULES §7).
 */
import { useCallback, useEffect, useState } from "react";
import { History } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDate } from "@/lib/date";

type Row = {
  id: string;
  planLabel: string;
  type: string;
  status: string;
  processor: string | null;
  startDate: string | null;
  expiryDate: string | null;
  cancelledDate: string | null;
  completedAt: string | null;
  isFirst: boolean | null;
  entitlement: string;
};

type Payload = {
  billedBy: string | null;
  billingStatusAsOf: string | null;
  standing: { decisionRequired: string[] | null; scheduled: { planLabel: string; startDate: string | null }[] | null };
  rows: Row[];
};

const ENTITLEMENT: Record<string, { label: string; className: string }> = {
  current: { label: "Current", className: "text-[var(--hue-success-ink)] bg-[color-mix(in_srgb,var(--hue-success)_12%,transparent)]" },
  scheduled: { label: "Starts later", className: "text-[var(--hue-info-ink,var(--tx-2))] bg-sf-2" },
  held: { label: "On hold", className: "text-[var(--hue-warning-ink)] bg-[color-mix(in_srgb,var(--hue-warning)_12%,transparent)]" },
  history: { label: "Past", className: "text-tx-3 bg-sf-2" },
};

function ended(r: Row): string | null {
  if (r.cancelledDate) return `cancelled ${formatDate(r.cancelledDate)}`;
  if (r.completedAt) return `completed ${formatDate(r.completedAt)}`;
  if (r.expiryDate) return `until ${formatDate(r.expiryDate)}`;
  return null;
}

export default function TeamUpHistory({ memberId }: { memberId: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/members/${memberId}/imported-memberships`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((p: Partial<Payload>) => {
        if (cancelled) return;
        // Tolerate a partial payload (older server, test fixture): never crash the profile.
        setData({
          billedBy: p.billedBy ?? null,
          billingStatusAsOf: p.billingStatusAsOf ?? null,
          standing: { decisionRequired: p.standing?.decisionRequired ?? null, scheduled: p.standing?.scheduled ?? null },
          rows: Array.isArray(p.rows) ? p.rows : [],
        });
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [memberId, reloadKey]);

  const retry = useCallback(() => { setError(false); setData(null); setReloadKey((k) => k + 1); }, []);

  return (
    <Card data-testid="teamup-history">
      <h3 className="text-sm font-semibold mb-1 flex items-center gap-2 text-tx-1">
        <History className="w-4 h-4 text-tx-3" aria-hidden />
        Membership history from TeamUp
      </h3>
      <p className="text-[11px] mb-3 text-tx-4">
        As recorded at TeamUp{data?.billingStatusAsOf ? `, standing as of ${formatDate(data.billingStatusAsOf)}` : ""}. Imported, not purchased here — MatFlow has charged nothing for these.
      </p>
      {error ? (
        <ErrorState message="Couldn't load the TeamUp history" onRetry={retry} />
      ) : data === null ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-[70%]" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <>
          {data.standing.decisionRequired && (
            <p className="text-xs mb-2 font-medium text-[var(--hue-warning-ink)]" data-testid="teamup-decision">
              Two plans active at TeamUp — {data.standing.decisionRequired.join(" and ")}. MatFlow has not chosen one: set the plan on this profile once you know which applies.
            </p>
          )}
          {data.standing.scheduled?.map((s) => (
            <p key={`${s.planLabel}-${s.startDate}`} className="text-xs mb-2 text-tx-2" data-testid="teamup-scheduled">
              Starts later at TeamUp: <strong>{s.planLabel}</strong>{s.startDate ? ` from ${formatDate(s.startDate)}` : ""}. A status refresh after that date moves them onto it.
            </p>
          ))}
          {data.rows.length === 0 ? (
            <p className="text-xs text-tx-3">No TeamUp membership rows were kept for this member.</p>
          ) : (
            <ul className="space-y-1.5">
              {data.rows.map((r) => {
                const e = ENTITLEMENT[r.entitlement] ?? ENTITLEMENT.history;
                const end = ended(r);
                return (
                  <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${e.className}`}>{e.label}</span>
                    <span className="font-medium text-tx-1">{r.planLabel}</span>
                    <span className="text-tx-3">
                      {r.status}
                      {r.startDate ? ` · from ${formatDate(r.startDate)}` : ""}
                      {end ? ` · ${end}` : ""}
                      {r.type === "prepaid" ? " · prepaid" : ""}
                      {r.isFirst ? " · first membership" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
