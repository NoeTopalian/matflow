"use client";

import { Select } from "@/components/ui/select";
import { REPORT_PERIOD_OPTIONS, customRun, monthOptions, resolveReportPeriod, type ReportPeriodKey } from "@/lib/report-period";

/** What the selector shows: the period key and its first and last months ("YYYY-MM"). */
export type PeriodShown = { period: string; from: string; to: string };
/** A choice, always with its months, so a page can show them before the server answers. */
export type PeriodChoice = { period: ReportPeriodKey; from: string; to: string };

/** How many club months the From/To lists offer, ending with this month. */
const MONTHS_OFFERED = 36;

/**
 * The statistics period control, shared by Reports and Analysis (Noe, 26 Oct
 * 2026): a preset, or a custom run of whole months. From and To are month
 * lists (native month inputs are plain text boxes in Firefox and desktop
 * Safari), always shown and holding the period's months, so choosing never
 * moves the row (UI-RULES §5a fixed widths); picking either selects "Custom
 * months", kept from ≤ to, within 24 months and never past `latestMonth`, so
 * the server is never asked for a period it would refuse.
 */
export default function PeriodSelector({ shown, latestMonth, timeZone, onSelect }: { shown: PeriodShown; latestMonth: string; timeZone: string; onSelect: (next: PeriodChoice) => void }) {
  const months = monthOptions(latestMonth, MONTHS_OFFERED);
  function setMonth(end: "from" | "to", value: string) {
    if (!/^\d{4}-\d{2}$/.test(value)) return;
    onSelect({ period: "custom", ...customRun(end === "from" ? value : shown.from, end === "to" ? value : shown.to, end, latestMonth) });
  }
  function setPreset(key: ReportPeriodKey) {
    if (key === "custom") return onSelect({ period: "custom", from: shown.from, to: shown.to });
    // The preset's months, worked out here too, so From/To change with the select at once.
    const r = resolveReportPeriod({ period: key }, new Date(), timeZone);
    onSelect({ period: key, from: r.fromMonth, to: r.toMonth });
  }
  const label = "flex items-center gap-2 text-xs font-medium";
  const monthList = (end: "from" | "to") => (
    <Select
      aria-label={end === "from" ? "Period from month" : "Period to month"}
      className="w-[130px]"
      value={end === "from" ? shown.from : shown.to}
      onChange={(e) => setMonth(end, e.target.value)}
    >
      {/* A run older than the list (a hand-typed link) still shows its month. */}
      {!months.some((m) => m.key === (end === "from" ? shown.from : shown.to)) && (
        <option value={end === "from" ? shown.from : shown.to}>{end === "from" ? shown.from : shown.to}</option>
      )}
      {months.map((m) => (
        <option key={m.key} value={m.key}>{m.label}</option>
      ))}
    </Select>
  );
  return (
    <>
      <label className={label} style={{ color: "var(--tx-3)" }}>
        Period
        <Select aria-label="Reporting period" className="w-[170px]" value={shown.period} onChange={(e) => setPreset(e.target.value as ReportPeriodKey)}>
          {REPORT_PERIOD_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </Select>
      </label>
      <label className={label} style={{ color: "var(--tx-3)" }}>
        From
        {monthList("from")}
      </label>
      <label className={label} style={{ color: "var(--tx-3)" }}>
        To
        {monthList("to")}
      </label>
    </>
  );
}

/** The URL parameters for a choice, on top of `current` (the page's other filters); an old `weeks` is dropped. */
export function periodSearchParams(current: URLSearchParams, next: PeriodChoice): URLSearchParams {
  const params = new URLSearchParams(current.toString());
  params.delete("weeks");
  params.set("period", next.period);
  if (next.period === "custom") {
    params.set("from", next.from);
    params.set("to", next.to);
  } else {
    params.delete("from");
    params.delete("to");
  }
  return params;
}
