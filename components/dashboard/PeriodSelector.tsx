"use client";

import { Select } from "@/components/ui/select";
import { REPORT_PERIOD_OPTIONS, customRun, type ReportPeriodKey } from "@/lib/report-period";

/** What the selector shows: the period key and its first and last months ("YYYY-MM"). */
export type PeriodShown = { period: string; from: string; to: string };
export type PeriodChoice = { period: ReportPeriodKey; from?: string; to?: string };

/**
 * The statistics period control, shared by Reports and Analysis (Noe, 26 Oct
 * 2026): a preset, or a custom run of whole months. From/To are always
 * shown, holding the period's months, so choosing never moves the row
 * (UI-RULES §5a fixed widths); editing either picks "Custom months", kept
 * from ≤ to, within 24 months and never past `latestMonth` (this month), so
 * the server is never asked for a period it would refuse.
 */
export default function PeriodSelector({ shown, latestMonth, onSelect }: { shown: PeriodShown; latestMonth: string; onSelect: (next: PeriodChoice) => void }) {
  function setMonth(end: "from" | "to", value: string) {
    if (!/^\d{4}-\d{2}$/.test(value)) return;
    onSelect({ period: "custom", ...customRun(end === "from" ? value : shown.from, end === "to" ? value : shown.to, end, latestMonth) });
  }
  const label = "flex items-center gap-2 text-xs font-medium";
  const monthInput = "h-9 w-[150px] rounded-[var(--r-md)] border border-bd-default bg-[var(--sf-1)] px-2 text-sm text-tx-1";
  return (
    <>
      <label className={label} style={{ color: "var(--tx-3)" }}>
        Period
        <Select
          aria-label="Reporting period"
          className="w-[170px]"
          value={shown.period}
          onChange={(e) => {
            const key = e.target.value as ReportPeriodKey;
            onSelect(key === "custom" ? { period: "custom", from: shown.from, to: shown.to } : { period: key });
          }}
        >
          {REPORT_PERIOD_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </Select>
      </label>
      <label className={label} style={{ color: "var(--tx-3)" }}>
        From
        <input type="month" aria-label="Period from month" className={monthInput} value={shown.from} max={latestMonth} onChange={(e) => setMonth("from", e.target.value)} />
      </label>
      <label className={label} style={{ color: "var(--tx-3)" }}>
        To
        <input type="month" aria-label="Period to month" className={monthInput} value={shown.to} max={latestMonth} onChange={(e) => setMonth("to", e.target.value)} />
      </label>
    </>
  );
}

/** The URL parameters for a choice, on top of `current` (the page's other filters); an old `weeks` is dropped. */
export function periodSearchParams(current: URLSearchParams, next: PeriodChoice): URLSearchParams {
  const params = new URLSearchParams(current.toString());
  params.delete("weeks");
  params.set("period", next.period);
  if (next.period === "custom" && next.from && next.to) {
    params.set("from", next.from);
    params.set("to", next.to);
  } else {
    params.delete("from");
    params.delete("to");
  }
  return params;
}
