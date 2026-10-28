"use client";

import { useMemo } from "react";
import { formatRatio, wholePct } from "@/lib/percent";

export type DonutSlice = {
  label: string;
  value: number;
  color: string;
};

interface DonutChartProps {
  data: DonutSlice[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
}

export default function DonutChart({
  data,
  size = 220,
  thickness = 32,
  centerLabel,
  centerValue,
}: DonutChartProps) {
  const total = useMemo(() => data.reduce((s, d) => s + d.value, 0), [data]);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;

  // Audit iter-1-dashboard A4H-5: replace mutable `let cumulative` (forbidden
  // by react-hooks/purity) with a reduce that threads the running total
  // through the accumulator. No mutation; pure functional.
  const slices = data
    .reduce<{
      acc: Array<{ label: string; value: number; color?: string; length: number; offset: number; fraction: number; key: string }>;
      cum: number;
    }>(
      ({ acc, cum }, d, i) => {
        const fraction = total > 0 ? d.value / total : 0;
        const length = fraction * circumference;
        const offset = -cum;
        return {
          acc: [...acc, { ...d, length, offset, fraction, key: `${d.label}-${i}` }],
          cum: cum + length,
        };
      },
      { acc: [], cum: 0 },
    )
    .acc;

  if (total === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-full"
        style={{
          width: size,
          height: size,
          border: `${thickness}px solid var(--bd-default)`,
          color: "var(--tx-3)",
          fontSize: 13,
        }}
      >
        No data
      </div>
    );
  }

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--bd-default)"
          strokeWidth={thickness}
        />
        {slices.map((s) => (
          <circle
            key={s.key}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={s.color}
            strokeWidth={thickness}
            strokeDasharray={`${s.length} ${circumference - s.length}`}
            strokeDashoffset={s.offset}
            style={{ transition: "stroke-dasharray 600ms ease, stroke-dashoffset 600ms ease" }}
          />
        ))}
      </svg>
      {(centerLabel || centerValue) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          {centerValue && (
            <span className="text-2xl font-bold" style={{ color: "var(--tx-1)" }}>
              {centerValue}
            </span>
          )}
          {centerLabel && (
            <span className="text-[11px] uppercase tracking-wider mt-0.5" style={{ color: "var(--tx-3)" }}>
              {centerLabel}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Each share reads "x% (n of m)" over the slices shown, so the base of every
 * percentage is on screen (required by Sean's note relayed 14 Oct and the
 * owner instruction of 24 Oct 2026); an empty donut reads "—". The older
 * "count (x%)" form, which had no base, is gone with its `showCounts` switch,
 * so no caller can print a bare percentage.
 *
 * One slice is the whole by construction, so it reads its count alone
 * ("90"), never an artificial "100% (90 of 90)" (owner decision, 27 Oct
 * 2026, 23:30).
 */
export function DonutLegend({ data }: { data: DonutSlice[] }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const share = (d: DonutSlice) =>
    data.length === 1 ? d.value.toLocaleString("en-GB") : formatRatio(wholePct(d.value, total), d.value, total);
  return (
    <ul className="w-full min-w-0 space-y-2">
      {data.map((d) => (
        <li key={d.label} className="flex items-center justify-between gap-3 text-sm">
          <span className="flex items-center gap-2 min-w-0">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.color }} />
            <span className="truncate" style={{ color: "var(--tx-2)" }}>{d.label}</span>
          </span>
          <span className="shrink-0 tabular-nums" style={{ color: "var(--tx-3)" }}>
            <span data-testid="donut-legend-ratio">{share(d)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
