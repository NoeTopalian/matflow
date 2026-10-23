"use client";

/**
 * The small building blocks the Reports page and its extracted cards share.
 * They lived inside ReportsView.tsx; a card in its own file needs the same
 * title row, empty frame and number format, so they are defined once here.
 */
import type { ElementType } from "react";
import { wholePct } from "@/lib/percent";

export type TooltipPayload = {
  value?: number | string;
  payload?: Record<string, unknown>;
};

export function formatNumber(value: number) {
  return value.toLocaleString("en-GB");
}

/**
 * T2b (17 Oct 2026, owner decision Q6): every percentage on Reports and
 * Analysis shows its numerator and denominator — "10% (1 of 10)". One helper
 * so the screen and the CSV print the same text.
 *
 * - `pct` is the already-computed percentage (it may carry one decimal).
 * - A base of 0, or a null/non-finite pct, renders "—": an undefined rate is
 *   never "0%" (MATFLOW-SPECIFICATION-2026-10.md:144, divide-by-zero → null).
 * - Counts use en-GB grouping ("1,234").
 */
export function formatRatio(pct: number | null, n: number, base: number): string {
  const p = formatPct(pct, base);
  return p === "—" ? p : `${p} ${ratioCounts(n, base)}`;
}

/** The percentage half of `formatRatio` ("10%", "3.2%"), or "—" on an empty base. */
export function formatPct(pct: number | null, base: number): string {
  if (base <= 0 || pct === null || !Number.isFinite(pct)) return "—";
  return `${pct.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
}

/** The counts half of `formatRatio`: "(1 of 10)". */
export function ratioCounts(n: number, base: number): string {
  return `(${formatNumber(n)} of ${formatNumber(base)})`;
}

/** n ÷ base as a whole percentage, or null when the base is 0 (never NaN, never a fake 0). */
export { wholePct };

/** A signed count for a net movement: "+3", "−2" (true minus sign), "0". */
export function formatSigned(n: number): string {
  if (n > 0) return `+${formatNumber(n)}`;
  if (n < 0) return `−${formatNumber(Math.abs(n))}`;
  return "0";
}

/**
 * A ratio as a tile value: the percentage large, its counts smaller beside
 * it. Text content is exactly `formatRatio(...)`, so tests and screen
 * readers read "10% (1 of 10)"; an empty base reads "—".
 */
export function RatioValue({ pct, n, base }: { pct: number | null; n: number; base: number }) {
  const p = formatPct(pct, base);
  if (p === "—") return <>—</>;
  return (
    <>
      {p}{" "}
      <span className="text-sm font-medium tabular-nums text-tx-2">{ratioCounts(n, base)}</span>
    </>
  );
}

export function SectionTitle({
  title,
  subtitle,
  icon: Icon,
  actions,
  fixedSubtitleHeight = false,
}: {
  title: string;
  subtitle?: string;
  icon?: ElementType;
  /** Optional controls rendered on the right, before the icon (a view switch, a filter). */
  actions?: React.ReactNode;
  /** Reserve two lines for a subtitle that changes with a view, so a longer one never reflows what sits below the card. */
  fixedSubtitleHeight?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
      <div className="min-w-0">
        <h2 className="font-semibold text-sm text-tx-1">{title}</h2>
        {subtitle && <p className={`text-xs mt-0.5 text-tx-3 ${fixedSubtitleHeight ? "min-h-[2.4em]" : ""}`}>{subtitle}</p>}
      </div>
      <div className="flex items-center gap-3">
        {actions}
        {Icon && <Icon className="w-4 h-4 mt-0.5 text-tx-3" />}
      </div>
    </div>
  );
}

export function EmptyChart({ label }: { label: string }) {
  return (
    <div className="h-[180px] flex items-center justify-center rounded-xl border border-dashed border-bd-default">
      <p className="text-sm text-tx-3">{label}</p>
    </div>
  );
}
