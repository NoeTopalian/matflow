"use client";

import type { ElementType, ReactNode } from "react";
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
  Download,
  Minus,
  QrCode,
  ShieldCheck,
  Trophy,
  TrendingUp,
  UserPlus,
  Users,
} from "lucide-react";
import type { ReportsData } from "@/lib/reports";
import DonutChart, { DonutLegend, type DonutSlice } from "@/components/dashboard/charts/DonutChart";
import Sparkline from "@/components/dashboard/charts/Sparkline";

const HERO_PALETTE = ["#67BA90", "#EB3163", "#C9F990", "#8E1F57", "#224541", "#F59E0B", "#38BDF8"];

interface Props {
  data: ReportsData;
  primaryColor: string;
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

function trendText(current: number, previous: number) {
  const delta = current - previous;
  if (delta === 0) return "No change";
  if (previous === 0) return `${delta > 0 ? "+" : ""}${formatNumber(delta)}`;
  const pct = Math.round((delta / previous) * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

function trendTone(current: number, previous: number) {
  if (current > previous) return "up";
  if (current < previous) return "down";
  return "flat";
}

function csvCell(value: string | number | null) {
  const text = String(value ?? "");
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportCsv(data: ReportsData) {
  const rows: (string | number | null)[][] = [
    ["Section", "Metric", "Value", "Detail"],
    ["Summary", "Total members", data.summary.totalMembers, ""],
    ["Summary", "Active members", data.summary.activeMembers, ""],
    ["Summary", "Attendance this week", data.summary.attendanceThisWeek, `Last week: ${data.summary.attendanceLastWeek}`],
    ["Summary", "New members this month", data.summary.newMembersThisMonth, `Last month: ${data.summary.newMembersLastMonth}`],
    ["Summary", "Total check-ins", data.summary.totalCheckIns, ""],
    ["Summary", "Active classes", data.summary.totalActiveClasses, ""],
    ...data.weeklyAttendance.map((row) => ["Weekly attendance", row.week, row.count, row.isCurrentWeek ? "Current week" : ""]),
    ...data.monthlySignups.map((row) => ["Monthly signups", row.month, row.count, row.isCurrentMonth ? "Current month" : ""]),
    ...data.topClasses.map((row) => [
      "Top classes",
      row.name,
      row.count,
      `${row.averageAttendance}/session, fill rate ${formatPercent(row.fillRate)}`,
    ]),
    ...data.membersByStatus.map((row) => ["Members by status", row.label, row.count, `${row.percentage}%`]),
    ...data.checkInMethods.map((row) => ["Check-in methods", row.label, row.count, `${row.percentage}%`]),
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

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border p-5 ${className}`}
      style={{
        background: "rgba(255,255,255,0.025)",
        borderColor: "var(--bd-default)",
        boxShadow: "0 18px 45px rgba(0,0,0,0.16)",
      }}
    >
      {children}
    </div>
  );
}

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
  const tone = trendTone(current, previous);
  const Icon = tone === "up" ? ArrowUpRight : tone === "down" ? ArrowDownRight : Minus;
  const color = tone === "up" ? "#22c55e" : tone === "down" ? "#f59e0b" : "var(--tx-3)";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold"
      style={{ color, background: tone === "flat" ? "rgba(255,255,255,0.04)" : hex(color, 0.12) }}
    >
      <Icon className="w-3 h-3" />
      {trendText(current, previous)} {label}
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
}: {
  icon: ElementType;
  label: string;
  value: ReactNode;
  detail?: string;
  primaryColor: string;
  trend?: { current: number; previous: number; label: string };
  compactValue?: boolean;
}) {
  return (
    <Card className="min-h-[126px] flex flex-col justify-between">
      <div className="flex items-center justify-between gap-3">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: hex(primaryColor, 0.13) }}
        >
          <Icon className="w-5 h-5" style={{ color: primaryColor }} />
        </div>
        {trend && <TrendBadge current={trend.current} previous={trend.previous} label={trend.label} />}
      </div>
      <div className="mt-5 min-w-0">
        <p
          className={`${compactValue ? "text-lg truncate" : "text-2xl"} font-bold leading-tight`}
          style={{ color: "var(--tx-1)" }}
          title={typeof value === "string" ? value : undefined}
        >
          {value}
        </p>
        <p className="text-xs font-medium mt-1" style={{ color: "var(--tx-3)" }}>{label}</p>
        {detail && <p className="text-[11px] mt-2" style={{ color: "var(--tx-2)" }}>{detail}</p>}
      </div>
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
      <div className="h-2 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
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

export default function ReportsView({ data, primaryColor }: Props) {
  const { summary, weeklyAttendance, monthlySignups, membersByStatus, checkInMethods, topClasses } = data;
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
    <div className="max-w-7xl mx-auto space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--tx-1)" }}>Reports</h1>
          <p className="text-sm mt-0.5" style={{ color: "var(--tx-3)" }}>
            Current owner snapshot, attendance trends, and class performance.
          </p>
        </div>
        <button
          onClick={() => exportCsv(data)}
          className="inline-flex items-center justify-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-semibold transition-colors hover:bg-white/[0.04]"
          style={{ color: "var(--tx-1)", borderColor: "var(--bd-default)" }}
        >
          <Download className="w-4 h-4" />
          Export CSV
        </button>
      </div>

      {/* Hero chart row — donut (attendance composition) + sparkline (12-week trend) */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4">
        <Card>
          <SectionTitle title="Class composition" subtitle="Share of total check-ins by class" icon={Trophy} />
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
          <SectionTitle title="Check-in trend" subtitle="Weekly attendance, last 12 weeks" icon={Activity} />
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
              <Sparkline data={trendPoints} width={520} height={150} />
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-3">
        <MetricCard
          icon={Users}
          label="Active members"
          value={formatNumber(summary.activeMembers)}
          detail={`${formatNumber(summary.totalMembers)} total members`}
          primaryColor={primaryColor}
        />
        <MetricCard
          icon={Activity}
          label="Attendance this week"
          value={formatNumber(summary.attendanceThisWeek)}
          detail="Check-ins since Monday"
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
        />
        <MetricCard
          icon={BarChart3}
          label="Total check-ins"
          value={formatNumber(summary.totalCheckIns)}
          detail="All-time attendance"
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
          detail={bestClass ? `${formatNumber(bestClass.count)} check-ins` : "Waiting for attendance"}
          primaryColor={primaryColor}
          compactValue
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.55fr)_360px] gap-4">
        <Card>
          <SectionTitle title="Weekly Attendance" subtitle="Last 12 weeks, current week highlighted" icon={Activity} />
          {weeklyAttendance.length === 0 || maxAttendance === 0 ? (
            <EmptyChart label="No attendance data yet" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={weeklyAttendance} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="week"
                  tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={weeklyTickFormatter}
                />
                <YAxis
                  tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip content={<ChartTooltip suffix="check-ins" />} cursor={{ fill: "rgba(255,255,255,0.025)" }} />
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
                <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="month"
                  tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 11 }}
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
          <SectionTitle title="Top Classes" subtitle="Total check-ins, average attendance, and fill rate" icon={Trophy} />
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
          <SectionTitle title="Check-In Methods" subtitle="How members and staff are recording attendance" icon={QrCode} />
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
