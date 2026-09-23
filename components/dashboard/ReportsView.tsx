"use client";

import { useOptimistic, useTransition, type ElementType, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
// Shared cell escaper WITH the formula-injection guard — the local copy this
// file carried quoted delimiters but did not neutralise a leading =/+/-/@, so a
// member named "=cmd()" exported as a live formula. See lib/csv.ts.
import { csvCell } from "@/lib/csv";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  Cell,
  PieChart,
  Pie,
  CartesianGrid,
} from "recharts";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Calendar,
  ChevronRight,
  CreditCard,
  Download,
  Info,
  QrCode,
  RefreshCcw,
  ShieldCheck,
  Trophy,
  TrendingDown,
  TrendingUp,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import type { ReportsData, AttendanceRateMode } from "@/lib/reports";
import type { AttributionData } from "@/lib/attribution";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import ConversionFunnel from "@/components/dashboard/ConversionFunnel";
import DonutChart, { DonutLegend, type DonutSlice } from "@/components/dashboard/charts/DonutChart";
import Sparkline from "@/components/dashboard/charts/Sparkline";
import InitiativesPanel from "@/components/dashboard/InitiativesPanel";
import MonthlyReportView from "@/components/dashboard/MonthlyReportView";

const WEEK_OPTIONS = [4, 8, 12, 16, 24] as const;

const HERO_PALETTE = ["#67BA90", "#EB3163", "#C9F990", "#8E1F57", "#224541", "#F59E0B", "#38BDF8"];

interface Props {
  data: ReportsData;
  /** The conversion funnel's data — the same fetch /dashboard/attribution uses. */
  attribution: AttributionData;
  primaryColor: string;
}

/**
 * Which numbers the class/age filters scope. Shown as an (i) beside those two
 * controls — ALWAYS present, so it never appears/disappears and moves the row
 * (it used to be a conditional paragraph, and every click reflowed the bar).
 */
const SCOPE_NOTE =
  "Class and age filters scope attendance, check-ins, top classes, the rate above and the owner insights. Growth, churn, retention, payments and the conversion funnel stay club-wide.";

function ScopeInfo() {
  // Focusable (tabIndex) so a keyboard user reaches the note; the global
  // :focus-visible ring applies. Phones have no hover — the same note is also
  // rendered as a visible line under the controls below the sm breakpoint.
  return (
    <span
      className="inline-flex rounded-[var(--r-sm)]"
      title={SCOPE_NOTE}
      role="img"
      aria-label={SCOPE_NOTE}
      tabIndex={0}
    >
      <Info className="w-4 h-4 shrink-0" style={{ color: "var(--tx-3)" }} aria-hidden="true" />
    </span>
  );
}

type TooltipPayload = {
  value?: number | string;
  payload?: Record<string, unknown>;
};

function hex(h: string, a: number) {
  const clean = h.replace("#", "");
  const valid = /^[0-9a-fA-F]{6}$/.test(clean) ? clean : "3b82f6";
  const n = parseInt(valid, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function formatNumber(value: number) {
  return value.toLocaleString("en-GB");
}

function formatPercent(value: number | null) {
  if (value === null) return "No capacity";
  return `${value}%`;
}

/**
 * The customisable attendance-rate DEFINITION (Track G): "checkins-per-member"
 * is a raw average (e.g. "3.2"), the other two modes are percentages of a
 * denominator. `null` means the mode's denominator was honestly zero for
 * this tenant/window (no active members, or no class has capacity set) —
 * rendered as "—", never a fabricated 0 (UI-RULES §7).
 */
function formatAttendanceRateValue(mode: AttendanceRateMode, value: number | null) {
  if (value === null) return "—";
  return mode === "checkins-per-member" ? value.toLocaleString("en-GB") : `${value}%`;
}

/** Delta as display text, or null when nothing moved. */
function trendDelta(current: number, previous: number) {
  const delta = current - previous;
  if (delta === 0) return null;
  if (previous === 0) return `${delta > 0 ? "+" : ""}${formatNumber(delta)}`;
  const pct = Math.round((delta / previous) * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

function trendText(current: number, previous: number) {
  return trendDelta(current, previous) ?? "No change";
}

function trendTone(current: number, previous: number) {
  if (current > previous) return "up";
  if (current < previous) return "down";
  return "flat";
}

function exportCsv(data: ReportsData) {
  const windowLabel = `Last ${data.weeksBack} weeks`;
  // Same scoping as the on-screen labels (ReportsView.scopedWindowLabel): the
  // class/age filters only narrow attendance-derived rows below, never the
  // membership/payment ones, so a downloaded CSV can't be misread as a
  // filtered export of numbers that were never filtered.
  const filterSuffix = [
    data.filters.className,
    data.filters.ageGroup === "adult" ? "Adults" : data.filters.ageGroup === "kids" ? "Kids" : null,
  ].filter(Boolean).join(" · ");
  const scopedWindowLabel = filterSuffix ? `${windowLabel} · ${filterSuffix}` : windowLabel;
  const rows: (string | number | null)[][] = [
    ["Section", "Metric", "Value", "Detail"],
    ["Summary", "Total members", data.summary.totalMembers, ""],
    ["Summary", "Active members", data.summary.activeMembers, ""],
    ["Summary", "Attendance this week", data.summary.attendanceThisWeek, `Last week: ${data.summary.attendanceLastWeek}`],
    ["Summary", "New members this month", data.summary.newMembersThisMonth, `Last month: ${data.summary.newMembersLastMonth}`],
    ["Summary", "Check-ins", data.summary.totalCheckIns, scopedWindowLabel],
    ["Summary", "Active classes", data.summary.totalActiveClasses, ""],
    ["Summary", "6-month survival", data.retentionRate === null ? "—" : `${data.retentionRate}%`, "Members who joined 6+ months ago, still active — not the inverse of monthly churn"],
    ...data.weeklyAttendance.map((row) => ["Weekly attendance", row.week, row.count, row.isCurrentWeek ? "Current week" : ""]),
    ...data.monthlySignups.map((row) => ["Monthly signups", row.month, row.count, row.isCurrentMonth ? "Current month" : ""]),
    ...data.topClasses.map((row) => [
      "Top classes",
      row.name,
      row.count,
      `${scopedWindowLabel}, ${row.averageAttendance}/session, fill rate ${formatPercent(row.fillRate)}`,
    ]),
    ...data.membersByStatus.map((row) => ["Members by status", row.label, row.count, `${row.percentage}%`]),
    ...data.checkInMethods.map((row) => ["Check-in methods", row.label, row.count, `${row.percentage}% · ${scopedWindowLabel}`]),
  ];

  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `matflow-reports-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// Card: the components/ui primitive (UI-RULES §1.5 / §5 — ONE card treatment,
// --r-md radius, hairline border, no shadow). This file used to carry its own
// 18px-radius, 45px-glow copy; the funnel card beneath the tiles uses the
// primitive, and the two side by side were the tell.

function SectionTitle({
  title,
  subtitle,
  icon: Icon,
}: {
  title: string;
  subtitle?: string;
  icon?: ElementType;
}) {
  return (
    <div className="flex items-start justify-between gap-3 mb-4">
      <div>
        <h2 className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>{title}</h2>
        {subtitle && <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>{subtitle}</p>}
      </div>
      {Icon && <Icon className="w-4 h-4 mt-0.5" style={{ color: "var(--tx-3)" }} />}
    </div>
  );
}

function TrendBadge({
  current,
  previous,
  label,
}: {
  current: number;
  previous: number;
  label: string;
}) {
  const delta = trendDelta(current, previous);
  // Nothing moved: say nothing. A pill announcing "no change" costs more room than it earns.
  if (delta === null) return null;

  const up = trendTone(current, previous) === "up";
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  // Tokens, not literals (UI-RULES §2), and intent colour as TEXT uses the
  // `-ink` tokens, never the hue: the raw green measured 2.27:1 on its tint.
  // Both inks on an 8% tint measure ≥4.58:1 (assessment lane 3, 2026-09-23).
  const ink = up ? "var(--hue-success-ink)" : "var(--hue-warning-ink)";
  const tint = up ? "var(--hue-success)" : "var(--hue-warning)";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] whitespace-nowrap"
      style={{ color: ink, background: `color-mix(in srgb, ${tint} 8%, transparent)` }}
    >
      <Icon className="w-3 h-3 shrink-0" />
      <span className="font-semibold tabular-nums">{delta}</span>
      <span style={{ color: "var(--tx-3)" }}>{label}</span>
    </span>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  primaryColor,
  trend,
  compactValue = false,
  href,
  hrefLabel,
}: {
  icon: ElementType;
  label: string;
  value: ReactNode;
  detail?: string;
  primaryColor: string;
  trend?: { current: number; previous: number; label: string };
  compactValue?: boolean;
  /** Drill-through target — the member rows behind this tile (Track A). */
  href?: string;
  /** Accessible name for the drill-through link; defaults to `label`. */
  hrefLabel?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-3">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: hex(primaryColor, 0.13) }}
        >
          <Icon className="w-5 h-5" style={{ color: primaryColor }} />
        </div>
        {href && <ChevronRight className="w-4 h-4 shrink-0" style={{ color: "var(--tx-3)" }} aria-hidden="true" />}
      </div>
      <div className="mt-5 min-w-0">
        {/* A long name (the busiest class) wraps to two lines rather than being
            cut mid-word; the reserved height keeps one- and two-line tiles
            level across the row. */}
        <p
          className={`${compactValue ? "text-lg line-clamp-2 min-h-[2.5rem]" : "text-2xl"} font-bold leading-tight`}
          style={{ color: "var(--tx-1)" }}
          title={typeof value === "string" ? value : undefined}
        >
          {value}
        </p>
        <p className="text-xs font-medium mt-1" style={{ color: "var(--tx-3)" }}>{label}</p>
        {detail && <p className="text-[11px] mt-2" style={{ color: "var(--tx-2)" }}>{detail}</p>}
        {/* The trend pill gets its own line. It used to share the top row with
            the icon and chevron, where "−69% vs last week" had ~185px of
            content in a ~200px tile and was clipped at the edge. */}
        {trend && (
          <div className="mt-2 min-w-0">
            <TrendBadge current={trend.current} previous={trend.previous} label={trend.label} />
          </div>
        )}
      </div>
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        aria-label={`${hrefLabel ?? label} — see the members behind this number`}
        className="block rounded-2xl"
      >
        <Card data-testid="metric-card" className="h-full min-h-[126px] flex flex-col justify-between transition-colors hover:border-bd-hover">
          {body}
        </Card>
      </Link>
    );
  }

  return (
    <Card data-testid="metric-card" className="h-full min-h-[126px] flex flex-col justify-between">
      {body}
    </Card>
  );
}

function ChartTooltip({
  active,
  payload,
  label,
  suffix,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
  suffix: string;
}) {
  if (!active || !payload?.length) return null;
  const value = Number(payload[0].value ?? 0);
  return (
    <div
      className="rounded-xl border px-3 py-2 text-sm shadow-xl"
      style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)" }}
    >
      <p className="text-xs mb-1" style={{ color: "var(--tx-3)" }}>{label}</p>
      <p className="font-semibold" style={{ color: "var(--tx-1)" }}>
        {formatNumber(value)} {suffix}
      </p>
    </div>
  );
}

function NetNewTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-xl border px-3 py-2 text-sm shadow-xl space-y-1"
      style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)" }}
    >
      <p className="text-xs mb-1 font-semibold" style={{ color: "var(--tx-3)" }}>{label}</p>
      {payload.map((entry) => {
        const p = entry.payload as Record<string, unknown>;
        const joined = Number(p.joined ?? 0);
        const cancelled = Number(p.cancelled ?? 0);
        const net = Number(p.net ?? 0);
        return (
          <div key="rows" className="space-y-0.5">
            <p style={{ color: "#22c55e" }}>Joined: {formatNumber(joined)}</p>
            <p style={{ color: "#ef4444" }}>Cancelled: {formatNumber(cancelled)}</p>
            <p className="font-semibold" style={{ color: net >= 0 ? "#22c55e" : "#ef4444" }}>
              Net: {net >= 0 ? "+" : ""}{formatNumber(net)}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="h-[180px] flex items-center justify-center rounded-xl border border-dashed" style={{ borderColor: "var(--bd-default)" }}>
      <p className="text-sm" style={{ color: "var(--tx-3)" }}>{label}</p>
    </div>
  );
}

function ProgressRow({
  label,
  value,
  detail,
  pct,
  color,
}: {
  label: string;
  value: string;
  detail?: string;
  pct: number;
  color: string;
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate" style={{ color: "var(--tx-1)" }}>{label}</p>
          {detail && <p className="text-[11px] mt-0.5" style={{ color: "var(--tx-3)" }}>{detail}</p>}
        </div>
        <span className="text-xs font-semibold shrink-0" style={{ color: "var(--tx-2)" }}>{value}</span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--bd-default)" }}>
        <div className="h-full rounded-full" style={{ width: `${Math.max(3, Math.min(100, pct))}%`, background: color }} />
      </div>
    </div>
  );
}

function InsightRow({
  icon: Icon,
  label,
  value,
  detail,
  color,
}: {
  icon: ElementType;
  label: string;
  value: string;
  detail: string;
  color: string;
}) {
  return (
    <div className="flex gap-3 py-3 border-b last:border-b-0" style={{ borderColor: "var(--bd-default)" }}>
      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: hex(color, 0.12) }}>
        <Icon className="w-4 h-4" style={{ color }} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--tx-3)" }}>{label}</p>
        <p className="text-sm font-semibold truncate mt-0.5" style={{ color: "var(--tx-1)" }}>{value}</p>
        <p className="text-xs mt-0.5" style={{ color: "var(--tx-2)" }}>{detail}</p>
      </div>
    </div>
  );
}

export default function ReportsView({ data, attribution, primaryColor }: Props) {
  const {
    summary,
    weeklyAttendance,
    monthlySignups,
    membersByStatus,
    checkInMethods,
    topClasses,
    churnRate,
    retentionRate,
    netNewByMonth,
    paymentHealth,
    weeksBack,
    classOptions,
    filters,
    attendanceRate,
    attendanceRateModes,
  } = data;
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // Every weeks/class/age-group control below drives a URL searchParam so the
  // SERVER page re-queries via lib/reports.ts — no client refetch, no
  // stale-while-revalidate flash, and a bad/old value degrades honestly
  // (see app/dashboard/reports/page.tsx and lib/reports.ts) rather than
  // silently filtering client-side against data that was never fetched for
  // the new scope.
  //
  // `replace` inside a transition (Reports UX cycle, 2026-09-23): the old
  // `router.push` made every filter click a full navigation — a history entry
  // per click, and the segment's loading.tsx skeleton swapped in and out, so
  // the whole page visibly jumped. A transition keeps the current page on
  // screen (dimmed via `isPending`) until the new data is ready, and replace
  // keeps Back meaning "leave Reports", not "undo one filter".
  // While the transition is pending the server props still describe the OLD
  // scope, and a controlled native select snaps back to its prop the moment
  // onChange fires — so for the whole refetch the controls contradicted the
  // click ("All classes" shown after choosing a class). useOptimistic shows
  // the clicked value for exactly the life of the transition and reverts to
  // the server value the moment the new page lands — no effect, no cleanup.
  type ParamKey = "weeks" | "classId" | "ageGroup" | "rate";
  type Shown = { weeks: string; classId: string; ageGroup: string | null; rate: string };
  const serverShown: Shown = {
    weeks: String(weeksBack),
    classId: filters.classId ?? "",
    ageGroup: filters.ageGroup ?? null,
    rate: attendanceRate.mode,
  };
  const [shown, showOptimistically] = useOptimistic(
    serverShown,
    (state: Shown, update: Partial<Shown>) => ({ ...state, ...update }),
  );

  function setParam(key: ParamKey, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    const update: Partial<Shown> =
      key === "ageGroup" ? { ageGroup: value } :
      key === "classId" ? { classId: value ?? "" } :
      key === "weeks" ? { weeks: value ?? serverShown.weeks } :
      { rate: value ?? serverShown.rate };
    startTransition(() => {
      showOptimistically(update);
      router.replace(`/dashboard/reports?${params.toString()}`);
    });
  }

  // Every attendance-derived figure on this page covers `weeksBack` weeks,
  // not all time (audit memory-storage 2026-08-16 P1-12) — label them so.
  const windowLabel = `Last ${weeksBack} weeks`;
  // Class/age-group filters only narrow the attendance-derived sections
  // (lib/reports.ts documents the exact list on ReportsData.filters) — this
  // suffix is appended ONLY to those captions, never to growth/churn/
  // retention/payment ones, so a filtered view never reads as if it changed
  // numbers it didn't.
  const filterSuffix = [
    filters.className,
    filters.ageGroup === "adult" ? "Adults" : filters.ageGroup === "kids" ? "Kids" : null,
  ].filter(Boolean).join(" · ");
  const scopedWindowLabel = filterSuffix ? `${windowLabel} · ${filterSuffix}` : windowLabel;
  // Computed once, used in two places (icon + its background tint) below —
  // avoids doubling the hex-literal count for the same ternary (UI-RULES §2
  // ratchet counts literals, not concepts).
  const retentionColor = (retentionRate ?? 70) >= 80 ? "#22c55e" : (retentionRate ?? 70) >= 60 ? "#f59e0b" : "#ef4444";
  const bestClass = topClasses[0];
  const maxAttendance = Math.max(...weeklyAttendance.map((row) => row.count), 0);
  const maxTopClass = Math.max(...topClasses.map((row) => row.count), 1);
  const totalMethodCount = checkInMethods.reduce((sum, row) => sum + row.count, 0);
  const totalStatusCount = membersByStatus.reduce((sum, row) => sum + row.count, 0);
  const selfServiceCount = checkInMethods
    .filter((row) => row.method === "self" || row.method === "qr")
    .reduce((sum, row) => sum + row.count, 0);
  const selfServicePct = totalMethodCount > 0 ? Math.round((selfServiceCount / totalMethodCount) * 100) : 0;
  const attentionMembers = summary.inactiveMembers + summary.cancelledMembers;
  const topMethod = checkInMethods[0];
  const activeShare = summary.totalMembers > 0 ? Math.round((summary.activeMembers / summary.totalMembers) * 100) : 0;

  const weeklyTickFormatter = (value: string, index: number) =>
    weeklyAttendance.length > 8 && index % 2 !== 0 ? "" : value;

  const classCompositionSlices: DonutSlice[] = topClasses.slice(0, 6).map((cls, i) => ({
    label: cls.name,
    value: cls.count,
    color: HERO_PALETTE[i % HERO_PALETTE.length],
  }));
  const totalClassCheckins = classCompositionSlices.reduce((s, d) => s + d.value, 0);

  const trendPoints = weeklyAttendance.map((row) => ({ label: row.week, value: row.count }));

  return (
    // aria-busy on the whole page while a filter refetch is in flight — the
    // tiles and captions about to change are busy, not only the readout.
    <div className="space-y-5" aria-busy={isPending || undefined}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--tx-1)" }}>Reports</h1>
          <p className="text-sm mt-0.5" style={{ color: "var(--tx-3)" }}>
            Current owner snapshot, attendance trends, and class performance.
          </p>
        </div>
        <Button variant="secondary" className="self-start sm:self-auto" onClick={() => exportCsv(data)}>
          <Download className="w-4 h-4" aria-hidden="true" />
          Export CSV
        </Button>
      </div>

      {/* Report controls: weeks window, class filter, adult/kids toggle.
          Each one drives a URL searchParam (see setParam above) so the
          server page re-queries — see lib/reports.ts for exactly which
          sections the class/age filters scope. */}
      {/* ZERO LAYOUT SHIFT, BY CONSTRUCTION (Reports UX cycle, 2026-09-23).
          A two-column grid — controls | readout — where every control has a
          FIXED width (UI-RULES §5a: never resized by text length) and the
          readout sits in a fixed column, so picking a longer class, another age
          group or a different rate definition changes the numbers and nothing
          else. The old flex `justify-between` row moved on every click: the
          readout's text grew with the mode, the selects grew with the selected
          option (max-w, not w), and a conditional note came and went. */}
      <Card data-testid="reports-filters" padding="tight">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-center">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs font-medium" style={{ color: "var(--tx-3)" }}>
              Window
              <Select
                aria-label="Reporting window"
                className="w-[120px]"
                value={shown.weeks}
                onChange={(e) => setParam("weeks", e.target.value)}
              >
                {WEEK_OPTIONS.map((w) => (
                  <option key={w} value={w}>{w} weeks</option>
                ))}
              </Select>
            </label>

            <label className="flex items-center gap-2 text-xs font-medium" style={{ color: "var(--tx-3)" }}>
              <span className="inline-flex items-center gap-1">Class<ScopeInfo /></span>
              <Select
                aria-label="Filter by class"
                className="w-[180px]"
                value={shown.classId}
                onChange={(e) => setParam("classId", e.target.value || null)}
              >
                <option value="">All classes</option>
                {classOptions.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </label>

            <div className="flex items-center gap-2 text-xs font-medium" style={{ color: "var(--tx-3)" }}>
              <span className="inline-flex items-center gap-1">Age group<ScopeInfo /></span>
              {/* 36px tall to line up with the selects (32px compact buttons +
                  2px padding each side); inner radius = outer − padding. */}
              <div className="inline-flex h-9 items-center rounded-[var(--r-md)] border border-bd-default p-0.5">
                {([
                  { value: null, label: "All" },
                  { value: "adult" as const, label: "Adults" },
                  { value: "kids" as const, label: "Kids" },
                ]).map((opt) => (
                  <Button
                    key={opt.label}
                    type="button"
                    size="compact"
                    className="rounded-[calc(var(--r-md)-2px)]"
                    variant={shown.ageGroup === opt.value ? "primary" : "ghost"}
                    onClick={() => setParam("ageGroup", opt.value)}
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Attendance-rate DEFINITION (Track G): the owner picks which
                one metric "the attendance rate" means, rather than a fixed
                implicit average. `title` gives the active formula as a
                native one-line tooltip — honesty is the selling point. */}
            <label
              className="flex items-center gap-2 text-xs font-medium"
              style={{ color: "var(--tx-3)" }}
              title={attendanceRate.formula}
            >
              Rate
              {/* Sized to the longest definition ("Check-ins per active member",
                  192.5px at 14px/500) plus padding — a fixed width must fit its
                  known option set or it clips its own default on first paint. */}
              <Select
                aria-label="Attendance-rate definition"
                className="w-[250px]"
                value={shown.rate}
                onChange={(e) => setParam("rate", e.target.value)}
              >
                {attendanceRateModes.map((m) => (
                  <option key={m.mode} value={m.mode} title={m.formula}>{m.label}</option>
                ))}
              </Select>
            </label>
          </div>

          {/* The active definition's number — `title` carries the formula as a
              native tooltip so the honesty of the number is one hover away
              (Track G). Fixed column; the number sits in a fixed 4-character
              slot and the label truncates, so its width never depends on which
              definition is selected. It no longer restates the window/age
              filters — they are the controls beside it. */}
          <div
            data-testid="rate-readout"
            className="flex items-baseline gap-2 min-w-0 lg:justify-end"
            title={attendanceRate.formula}
            aria-busy={isPending || undefined}
            style={{ opacity: isPending ? 0.6 : 1, transition: "opacity var(--dur-fast) var(--ease-out)" }}
          >
            <span
              className="inline-block min-w-[4ch] text-right text-lg font-bold tabular-nums"
              style={{ color: "var(--tx-1)" }}
            >
              {formatAttendanceRateValue(attendanceRate.mode, attendanceRate.value)}
            </span>
            <span className="text-xs truncate" style={{ color: "var(--tx-3)" }} title={attendanceRate.label}>
              {attendanceRate.label}
            </span>
          </div>

          {/* On a phone there is no hover, so the (i) note is a visible line —
              always present below sm, never toggled, so the bar still never moves. */}
          <p className="sm:hidden text-[11px] leading-snug" style={{ color: "var(--tx-3)" }}>
            {SCOPE_NOTE}
          </p>
        </div>
      </Card>

      {/* Hero chart row — donut (attendance composition) + sparkline (12-week trend) */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4">
        <Card>
          <SectionTitle title="Class composition" subtitle={`Share of check-ins by class — ${scopedWindowLabel}`} icon={Trophy} />
          {totalClassCheckins === 0 ? (
            <EmptyChart label="No class attendance yet" />
          ) : (
            <div className="flex flex-col sm:flex-row items-center gap-5">
              <DonutChart
                data={classCompositionSlices}
                size={200}
                thickness={28}
                centerLabel="Check-ins"
                centerValue={formatNumber(totalClassCheckins)}
              />
              <div className="flex-1 min-w-0 w-full">
                <DonutLegend data={classCompositionSlices} />
              </div>
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle title="Check-in trend" subtitle={`Weekly attendance — ${scopedWindowLabel}`} icon={Activity} />
          {weeklyAttendance.length === 0 || maxAttendance === 0 ? (
            <EmptyChart label="No attendance data yet" />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-baseline gap-3">
                <span className="text-3xl font-bold tabular-nums" style={{ color: "var(--tx-1)" }}>
                  {formatNumber(summary.attendanceThisWeek)}
                </span>
                <TrendBadge
                  current={summary.attendanceThisWeek}
                  previous={summary.attendanceLastWeek}
                  label="vs last week"
                />
              </div>
              <div className="w-full overflow-hidden [&>svg]:w-full [&>svg]:h-auto">
                <Sparkline data={trendPoints} width={520} height={150} />
              </div>
            </div>
          )}
        </Card>
      </div>

      <MonthlyReportView primaryColor={primaryColor} />

      <InitiativesPanel primaryColor={primaryColor} />

      {/* Three tiles per row on lg/xl (two calm rows), six only on very wide
          screens. Six fixed-fraction columns at 1280-1440px gave each tile
          ~200px — too narrow for a value, a label and a trend pill. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-3 items-stretch">
        <MetricCard
          icon={Users}
          label="Active members"
          value={formatNumber(summary.activeMembers)}
          detail={`${formatNumber(summary.totalMembers)} total members`}
          primaryColor={primaryColor}
          href="/dashboard/members?filter=active"
        />
        <MetricCard
          icon={Activity}
          label="Attendance this week"
          value={formatNumber(summary.attendanceThisWeek)}
          detail={filterSuffix ? `Check-ins since Monday · ${filterSuffix}` : "Check-ins since Monday"}
          primaryColor={primaryColor}
          trend={{ current: summary.attendanceThisWeek, previous: summary.attendanceLastWeek, label: "vs last week" }}
        />
        <MetricCard
          icon={UserPlus}
          label="New this month"
          value={formatNumber(summary.newMembersThisMonth)}
          detail="Member signups"
          primaryColor={primaryColor}
          trend={{ current: summary.newMembersThisMonth, previous: summary.newMembersLastMonth, label: "vs last month" }}
          href="/dashboard/members?filter=new-this-month"
        />
        <MetricCard
          icon={BarChart3}
          label="Check-ins"
          value={formatNumber(summary.totalCheckIns)}
          detail={scopedWindowLabel}
          primaryColor={primaryColor}
        />
        <MetricCard
          icon={Calendar}
          label="Active classes"
          value={formatNumber(summary.totalActiveClasses)}
          detail="Live timetable classes"
          primaryColor={primaryColor}
        />
        <MetricCard
          icon={Trophy}
          label="Busiest class"
          value={bestClass?.name ?? "No class data"}
          detail={bestClass ? `${formatNumber(bestClass.count)} check-ins · ${scopedWindowLabel}` : "Waiting for attendance"}
          primaryColor={primaryColor}
          compactValue
        />
      </div>

      {/* Conversions, up here where Sean looks first: the club-wide funnel and
          each coach's, with the drop-off at every step. Club-wide by design —
          the filters above never scope it (ScopeInfo says so). */}
      <ConversionFunnel data={attribution} linkRows />

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.55fr)_360px] gap-4">
        <Card>
          <SectionTitle title="Weekly Attendance" subtitle={`${scopedWindowLabel}, current week highlighted`} icon={Activity} />
          {weeklyAttendance.length === 0 || maxAttendance === 0 ? (
            <EmptyChart label="No attendance data yet" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={weeklyAttendance} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--bd-default)" />
                <XAxis
                  dataKey="week"
                  tick={{ fill: "var(--tx-3)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={weeklyTickFormatter}
                />
                <YAxis
                  tick={{ fill: "var(--tx-3)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip content={<ChartTooltip suffix="check-ins" />} cursor={{ fill: "var(--sf-2)" }} />
                <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={34}>
                  {weeklyAttendance.map((row) => (
                    <Cell
                      key={row.week}
                      fill={row.isCurrentWeek ? primaryColor : hex(primaryColor, 0.42)}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card>
          <SectionTitle title="Owner Insights" subtitle="What changed and what deserves attention" icon={TrendingUp} />
          <div>
            <InsightRow
              icon={Activity}
              label="Attendance pulse"
              value={trendText(summary.attendanceThisWeek, summary.attendanceLastWeek)}
              detail={`${formatNumber(summary.attendanceThisWeek)} this week, ${formatNumber(summary.attendanceLastWeek)} last week`}
              color={trendTone(summary.attendanceThisWeek, summary.attendanceLastWeek) === "down" ? "#f59e0b" : "#22c55e"}
            />
            <InsightRow
              icon={Trophy}
              label="Class leader"
              value={bestClass?.name ?? "No leader yet"}
              detail={bestClass ? `${bestClass.averageAttendance} avg per attended session` : "Check-ins will reveal your leaders"}
              color={primaryColor}
            />
            <InsightRow
              icon={QrCode}
              label="Self-service check-in"
              value={`${selfServicePct}% self or QR`}
              detail={topMethod ? `${topMethod.label} is the top method` : "No method data yet"}
              color="#6366f1"
            />
            <InsightRow
              icon={attentionMembers > 0 ? AlertTriangle : ShieldCheck}
              label="Member attention"
              value={attentionMembers > 0 ? `${attentionMembers} need review` : "No inactive members"}
              detail={`${activeShare}% of members are active`}
              color={attentionMembers > 0 ? "#f59e0b" : "#22c55e"}
            />
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <SectionTitle title="New Members" subtitle="Last 6 months" icon={UserPlus} />
          {monthlySignups.every((row) => row.count === 0) ? (
            <EmptyChart label="No signup data yet" />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={monthlySignups} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--bd-default)" />
                <XAxis
                  dataKey="month"
                  tick={{ fill: "var(--tx-3)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "var(--tx-3)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip content={<ChartTooltip suffix="new members" />} />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke={primaryColor}
                  strokeWidth={2.5}
                  dot={{ fill: primaryColor, r: 4, strokeWidth: 0 }}
                  activeDot={{ r: 6, fill: primaryColor }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card>
          <SectionTitle title="Top Classes" subtitle={`Check-ins, average attendance, and fill rate — ${scopedWindowLabel}`} icon={Trophy} />
          {topClasses.length === 0 ? (
            <EmptyChart label="No class data yet" />
          ) : (
            <div className="space-y-4">
              {topClasses.map((cls, index) => (
                <ProgressRow
                  key={cls.name}
                  label={cls.name}
                  value={formatNumber(cls.count)}
                  detail={`${cls.averageAttendance}/session | ${formatPercent(cls.fillRate)} fill`}
                  pct={Math.round((cls.count / maxTopClass) * 100)}
                  color={index === 0 ? primaryColor : hex(primaryColor, 0.62 - index * 0.08)}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <SectionTitle title="Members by Status" subtitle="Counts and share of your member base" icon={Users} />
          {totalStatusCount === 0 ? (
            <EmptyChart label="No member data yet" />
          ) : (
            <div className={`grid gap-5 ${membersByStatus.length > 1 ? "sm:grid-cols-[130px_1fr]" : ""}`}>
              {membersByStatus.length > 1 && (
                <ResponsiveContainer width="100%" height={130}>
                  <PieChart>
                    <Pie
                      data={membersByStatus}
                      dataKey="count"
                      nameKey="label"
                      cx="50%"
                      cy="50%"
                      innerRadius={38}
                      outerRadius={58}
                      strokeWidth={0}
                    >
                      {membersByStatus.map((entry, index) => (
                        <Cell key={entry.status} fill={statusColor(entry.status, index)} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              )}
              <div className="space-y-3">
                {membersByStatus.length === 1 && (
                  <div className="flex items-center gap-2 rounded-xl px-3 py-2 border" style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}>
                    <ShieldCheck className="w-4 h-4" style={{ color: "#22c55e" }} />
                    <span className="text-sm">All tracked members are currently {membersByStatus[0].label.toLowerCase()}.</span>
                  </div>
                )}
                {membersByStatus.map((entry, index) => (
                  <ProgressRow
                    key={entry.status}
                    label={entry.label}
                    value={`${formatNumber(entry.count)} (${entry.percentage}%)`}
                    pct={entry.percentage}
                    color={statusColor(entry.status, index)}
                  />
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle title="Check-In Methods" subtitle={`How attendance was recorded — ${scopedWindowLabel}`} icon={QrCode} />
          {totalMethodCount === 0 ? (
            <EmptyChart label="No check-in data yet" />
          ) : (
            <div className="space-y-4">
              {checkInMethods.map((method) => (
                <ProgressRow
                  key={method.method}
                  label={method.label}
                  value={`${formatNumber(method.count)} (${method.percentage}%)`}
                  pct={method.percentage}
                  color={methodColor(method.method)}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Health Metrics ─────────────────────────────────────────────────────── */}
      <div>
        <div className="mb-3">
          <h2 className="font-semibold text-base" style={{ color: "var(--tx-1)" }}>Health Metrics</h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
            Member lifecycle and payment health at a glance.
          </p>
        </div>

        {/* KPI row — churn and payment recovery only. Retention used to sit
            here as a third tile and read as "1 - churn" at a glance, which it
            is not: different cohort (6mo+ joiners vs this month's active
            base) and a different window (a point-in-time survival check vs
            a monthly rate). It has its own card below instead of a headline
            neighbour (Track A churn-honesty fix). */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <MetricCard
            icon={UserMinus}
            label="Churn rate this month"
            value={`${churnRate}%`}
            detail="Cancellations as % of active base"
            primaryColor={churnRate > 5 ? "#ef4444" : churnRate > 2 ? "#f59e0b" : "#22c55e"}
            href="/dashboard/members?filter=churned-this-month"
          />
          <MetricCard
            icon={RefreshCcw}
            label="Payment recovery rate"
            value={paymentHealth.recoveryRate === null ? "—" : `${paymentHealth.recoveryRate}%`}
            detail="Of members with a failed payment in last 90 days now paid"
            primaryColor={(paymentHealth.recoveryRate ?? 50) >= 70 ? "#22c55e" : (paymentHealth.recoveryRate ?? 50) >= 40 ? "#f59e0b" : "#ef4444"}
          />
        </div>

        <Card className="!p-4 mb-4 flex items-start gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: hex(retentionColor, 0.13) }}
          >
            <TrendingDown className="w-4 h-4" style={{ color: retentionColor }} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>
              6-month survival: {retentionRate === null ? "—" : `${retentionRate}%`}
            </p>
            <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
              Of members who joined 6+ months ago, still active today. A different cohort and window to the monthly churn rate above — not its inverse, and the two numbers will not sum to 100%.
            </p>
          </div>
        </Card>

        {/* Payment health + net-new chart */}
        <div className="grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] gap-4">
          <Card>
            <SectionTitle title="Payment Health" subtitle="Current overdue and recent failures" icon={CreditCard} />
            <div className="space-y-4">
              <Link
                href="/dashboard/members?filter=overdue"
                aria-label="Overdue now — see the members behind this number"
                className="flex items-center justify-between gap-3 py-3 border-b -mx-1 px-1 rounded-lg transition-colors hover:bg-[var(--sf-2)]"
                style={{ borderColor: "var(--bd-default)" }}
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: hex("#ef4444", 0.12) }}>
                    <AlertTriangle className="w-4 h-4" style={{ color: "#ef4444" }} />
                  </div>
                  <p className="text-sm font-medium" style={{ color: "var(--tx-1)" }}>Overdue now</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className="text-xl font-bold tabular-nums"
                    style={{ color: paymentHealth.overdueCount > 0 ? "#ef4444" : "#22c55e" }}
                  >
                    {formatNumber(paymentHealth.overdueCount)}
                  </span>
                  <ChevronRight className="w-4 h-4 shrink-0" style={{ color: "var(--tx-3)" }} aria-hidden="true" />
                </div>
              </Link>
              <div className="flex items-center justify-between gap-3 py-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: hex("#f59e0b", 0.12) }}>
                    <CreditCard className="w-4 h-4" style={{ color: "#f59e0b" }} />
                  </div>
                  <p className="text-sm font-medium" style={{ color: "var(--tx-1)" }}>Failed last 30 days</p>
                </div>
                <span
                  className="text-xl font-bold tabular-nums"
                  style={{ color: paymentHealth.failedLast30Days > 0 ? "#f59e0b" : "#22c55e" }}
                >
                  {formatNumber(paymentHealth.failedLast30Days)}
                </span>
              </div>
              {paymentHealth.overdueCount === 0 && paymentHealth.failedLast30Days === 0 && (
                <div className="flex items-center gap-2 rounded-xl px-3 py-2 border" style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}>
                  <ShieldCheck className="w-4 h-4" style={{ color: "#22c55e" }} />
                  <span className="text-sm">All payments are in good standing.</span>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <SectionTitle title="Net New Members" subtitle="Joined vs cancelled per month, last 6 months" icon={TrendingUp} />
            {netNewByMonth.length === 0 || netNewByMonth.every((r) => r.joined === 0 && r.cancelled === 0) ? (
              <EmptyChart label="No membership movement data yet" />
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={netNewByMonth} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--bd-default)" />
                  <XAxis
                    dataKey="month"
                    tick={{ fill: "var(--tx-3)", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: "var(--tx-3)", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip content={<NetNewTooltip />} cursor={{ fill: "var(--sf-2)" }} />
                  <Bar dataKey="joined" stackId="a" fill="#22c55e" radius={[0, 0, 0, 0]} maxBarSize={34} name="Joined" />
                  <Bar dataKey="cancelled" stackId="b" fill="#ef4444" radius={[6, 6, 0, 0]} maxBarSize={34} name="Cancelled" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function statusColor(status: string, index: number) {
  const map: Record<string, string> = {
    active: "#22c55e",
    inactive: "#f59e0b",
    cancelled: "#ef4444",
    taster: "#38bdf8",
  };
  return map[status] ?? ["#8b5cf6", "#14b8a6", "#f97316"][index % 3];
}

function methodColor(method: string) {
  const map: Record<string, string> = {
    qr: "#6366f1",
    admin: "#f59e0b",
    self: "#10b981",
    auto: "#8b5cf6",
  };
  return map[method] ?? "#6b7280";
}
