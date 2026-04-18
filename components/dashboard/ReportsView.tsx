"use client";

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
} from "recharts";
import { Users, Activity, Calendar, TrendingUp } from "lucide-react";

export interface ReportsData {
  summary: {
    totalMembers: number;
    totalCheckIns: number;
    totalActiveClasses: number;
  };
  weeklyAttendance: { week: string; count: number }[];
  monthlySignups: { month: string; count: number }[];
  membersByStatus: { status: string; count: number }[];
  checkInMethods: { method: string; count: number }[];
  topClasses: { name: string; count: number }[];
}

interface Props {
  data: ReportsData;
  primaryColor: string;
}

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border p-5 ${className}`}
      style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}
    >
      {children}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  primaryColor,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  primaryColor: string;
}) {
  return (
    <Card className="flex items-center gap-4">
      <div
        className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: hex(primaryColor, 0.12) }}
      >
        <Icon className="w-5 h-5" style={{ color: primaryColor }} />
      </div>
      <div>
        <p className="text-white text-2xl font-bold leading-none">{value.toLocaleString()}</p>
        <p className="text-gray-400 text-xs font-medium mt-1">{label}</p>
      </div>
    </Card>
  );
}

const STATUS_COLORS: Record<string, string> = {
  active: "#22c55e",
  inactive: "#eab308",
  cancelled: "#ef4444",
};

const METHOD_COLORS: Record<string, string> = {
  qr: "#6366f1",
  admin: "#f59e0b",
  self: "#10b981",
  auto: "#8b5cf6",
};

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-xl border px-3 py-2 text-sm"
      style={{ background: "#0e1016", borderColor: "rgba(255,255,255,0.12)" }}
    >
      <p className="text-gray-400 text-xs mb-1">{label}</p>
      <p className="text-white font-semibold">{payload[0].value} check-ins</p>
    </div>
  );
}

function SignupTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-xl border px-3 py-2 text-sm"
      style={{ background: "#0e1016", borderColor: "rgba(255,255,255,0.12)" }}
    >
      <p className="text-gray-400 text-xs mb-1">{label}</p>
      <p className="text-white font-semibold">{payload[0].value} new members</p>
    </div>
  );
}

export default function ReportsView({ data, primaryColor }: Props) {
  const { summary, weeklyAttendance, monthlySignups, membersByStatus, checkInMethods, topClasses } = data;
  const maxAttendance = Math.max(...weeklyAttendance.map((w) => w.count), 1);
  const totalMethodCount = checkInMethods.reduce((s, m) => s + m.count, 0);
  const totalStatusCount = membersByStatus.reduce((s, m) => s + m.count, 0);

  // Show only every 3rd label on mobile-ish widths to avoid crowding
  const tickFormatter = (_: string, index: number) => (index % 3 === 0 ? _ : "");

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Reports</h1>
        <p className="text-gray-500 text-sm mt-0.5">Analytics across your gym</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard icon={Users} label="Total Members" value={summary.totalMembers} primaryColor={primaryColor} />
        <StatCard icon={Activity} label="Total Check-Ins" value={summary.totalCheckIns} primaryColor={primaryColor} />
        <StatCard icon={Calendar} label="Active Classes" value={summary.totalActiveClasses} primaryColor={primaryColor} />
      </div>

      {/* Weekly attendance chart */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-white font-semibold">Weekly Attendance</h2>
            <p className="text-gray-500 text-xs mt-0.5">Last 12 weeks</p>
          </div>
          <TrendingUp className="w-5 h-5 text-gray-600" />
        </div>
        {weeklyAttendance.length === 0 || maxAttendance === 0 ? (
          <EmptyChart label="No attendance data yet" />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={weeklyAttendance} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <XAxis
                dataKey="week"
                tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={tickFormatter}
              />
              <YAxis
                tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
              <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={32}>
                {weeklyAttendance.map((_, i) => (
                  <Cell
                    key={i}
                    fill={i === weeklyAttendance.length - 1 ? primaryColor : hex(primaryColor, 0.45)}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Monthly signups */}
        <Card>
          <div className="mb-4">
            <h2 className="text-white font-semibold">New Members</h2>
            <p className="text-gray-500 text-xs mt-0.5">Last 6 months</p>
          </div>
          {monthlySignups.every((m) => m.count === 0) ? (
            <EmptyChart label="No signup data yet" />
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={monthlySignups} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <XAxis
                  dataKey="month"
                  tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip content={<SignupTooltip />} />
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

        {/* Top classes */}
        <Card>
          <div className="mb-4">
            <h2 className="text-white font-semibold">Top Classes</h2>
            <p className="text-gray-500 text-xs mt-0.5">By total check-ins</p>
          </div>
          {topClasses.length === 0 ? (
            <EmptyChart label="No class data yet" />
          ) : (
            <div className="space-y-3">
              {topClasses.map((cls, i) => {
                const pct = Math.round((cls.count / (topClasses[0]?.count || 1)) * 100);
                return (
                  <div key={cls.name}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-gray-300 text-sm truncate max-w-[70%]">{cls.name}</span>
                      <span className="text-gray-400 text-xs">{cls.count}</span>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${pct}%`,
                          background: i === 0 ? primaryColor : hex(primaryColor, 0.5 - i * 0.08),
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Member status pie */}
        <Card>
          <div className="mb-4">
            <h2 className="text-white font-semibold">Members by Status</h2>
          </div>
          {totalStatusCount === 0 ? (
            <EmptyChart label="No member data yet" />
          ) : (
            <div className="flex items-center gap-6">
              <ResponsiveContainer width={130} height={130}>
                <PieChart>
                  <Pie
                    data={membersByStatus}
                    dataKey="count"
                    nameKey="status"
                    cx="50%"
                    cy="50%"
                    innerRadius={38}
                    outerRadius={58}
                    strokeWidth={0}
                  >
                    {membersByStatus.map((entry, i) => (
                      <Cell key={i} fill={STATUS_COLORS[entry.status] ?? "#6b7280"} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-2 flex-1">
                {membersByStatus.map((entry) => (
                  <div key={entry.status} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ background: STATUS_COLORS[entry.status] ?? "#6b7280" }}
                      />
                      <span className="text-gray-400 text-sm capitalize">{entry.status}</span>
                    </div>
                    <span className="text-white text-sm font-medium">{entry.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        {/* Check-in method breakdown */}
        <Card>
          <div className="mb-4">
            <h2 className="text-white font-semibold">Check-In Methods</h2>
          </div>
          {totalMethodCount === 0 ? (
            <EmptyChart label="No check-in data yet" />
          ) : (
            <div className="space-y-3">
              {checkInMethods.map((m) => {
                const pct = Math.round((m.count / totalMethodCount) * 100);
                const color = METHOD_COLORS[m.method] ?? "#6b7280";
                return (
                  <div key={m.method}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full" style={{ background: color }} />
                        <span className="text-gray-300 text-sm capitalize">{m.method}</span>
                      </div>
                      <span className="text-gray-400 text-xs">{m.count} ({pct}%)</span>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct}%`, background: color }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="h-[130px] flex items-center justify-center">
      <p className="text-gray-600 text-sm">{label}</p>
    </div>
  );
}
