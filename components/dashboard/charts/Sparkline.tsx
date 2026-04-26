"use client";

import { useMemo } from "react";

export type SparklinePoint = { label: string; value: number };

interface SparklineProps {
  data: SparklinePoint[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  showAxisLabels?: boolean;
  highlightLast?: boolean;
}

export default function Sparkline({
  data,
  width = 480,
  height = 140,
  stroke = "#67BA90",
  fill = "rgba(103,186,144,0.20)",
  showAxisLabels = true,
  highlightLast = true,
}: SparklineProps) {
  const padding = { top: 12, right: 12, bottom: showAxisLabels ? 24 : 8, left: 12 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const { path, area, maxValue, minValue, points } = useMemo(() => {
    if (data.length === 0) {
      return { path: "", area: "", maxValue: 0, minValue: 0, points: [] as { x: number; y: number; v: number }[] };
    }
    const max = Math.max(...data.map((d) => d.value), 1);
    const min = Math.min(...data.map((d) => d.value), 0);
    const range = max - min || 1;
    const stepX = data.length > 1 ? innerW / (data.length - 1) : 0;

    const pts = data.map((d, i) => ({
      x: padding.left + i * stepX,
      y: padding.top + innerH - ((d.value - min) / range) * innerH,
      v: d.value,
    }));

    const linePath = pts
      .map((p, i) => {
        if (i === 0) return `M ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
        const prev = pts[i - 1];
        const cx1 = (prev.x + p.x) / 2;
        return `Q ${cx1.toFixed(2)} ${prev.y.toFixed(2)} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
      })
      .join(" ");

    const areaPath = `${linePath} L ${pts[pts.length - 1].x.toFixed(2)} ${(padding.top + innerH).toFixed(2)} L ${pts[0].x.toFixed(2)} ${(padding.top + innerH).toFixed(2)} Z`;

    return { path: linePath, area: areaPath, maxValue: max, minValue: min, points: pts };
  }, [data, innerW, innerH, padding.left, padding.top]);

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border"
        style={{
          width,
          height,
          borderColor: "var(--bd-default)",
          color: "var(--tx-3)",
          fontSize: 13,
        }}
      >
        No data
      </div>
    );
  }

  const lastPoint = points[points.length - 1];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img">
      <defs>
        <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#spark-fill)" />
      <path d={path} fill="none" stroke={stroke} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      {highlightLast && lastPoint && (
        <>
          <circle cx={lastPoint.x} cy={lastPoint.y} r={6} fill={fill} />
          <circle cx={lastPoint.x} cy={lastPoint.y} r={3.5} fill={stroke} />
        </>
      )}
      {showAxisLabels && data.length > 1 && (
        <>
          <text x={padding.left} y={height - 6} fontSize="10" fill="var(--tx-4)">
            {data[0].label}
          </text>
          <text x={width - padding.right} y={height - 6} fontSize="10" fill="var(--tx-4)" textAnchor="end">
            {data[data.length - 1].label}
          </text>
          <text x={width - padding.right} y={padding.top + 6} fontSize="10" fill="var(--tx-3)" textAnchor="end" fontWeight="600">
            {Math.round(maxValue)}
          </text>
          <text x={width - padding.right} y={padding.top + innerH - 2} fontSize="10" fill="var(--tx-4)" textAnchor="end">
            {Math.round(minValue)}
          </text>
        </>
      )}
    </svg>
  );
}
