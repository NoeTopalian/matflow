"use client";

import { useMemo } from "react";

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

  let cumulative = 0;
  const slices = data.map((d, i) => {
    const fraction = total > 0 ? d.value / total : 0;
    const length = fraction * circumference;
    const offset = -cumulative;
    cumulative += length;
    return { ...d, length, offset, fraction, key: `${d.label}-${i}` };
  });

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

export function DonutLegend({ data }: { data: DonutSlice[] }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <ul className="space-y-2">
      {data.map((d) => {
        const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
        return (
          <li key={d.label} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2 min-w-0">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.color }} />
              <span className="truncate" style={{ color: "var(--tx-2)" }}>{d.label}</span>
            </span>
            <span className="shrink-0 tabular-nums" style={{ color: "var(--tx-3)" }}>
              {d.value} <span className="ml-1 text-xs">({pct}%)</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
