"use client";

import { useState, useMemo } from "react";
import { Users, TrendingUp, Calendar, Award, Search, Filter } from "lucide-react";
import type { AttendanceRow, AttendanceSummary } from "@/app/dashboard/attendance/page";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

const METHOD_LABELS: Record<string, string> = {
  qr: "QR Scan",
  admin: "Admin",
  self: "Self",
  auto: "Auto",
};

const METHOD_COLORS: Record<string, string> = {
  qr: "#22c55e",
  admin: "#3b82f6",
  self: "#8b5cf6",
  auto: "#f59e0b",
};

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  primaryColor,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  primaryColor: string;
}) {
  return (
    <div
      className="rounded-2xl border p-4"
      style={{ background: "rgba(255,255,255,0.025)", borderColor: "rgba(255,255,255,0.08)" }}
    >
      <div
        className="w-9 h-9 rounded-xl flex items-center justify-center mb-3"
        style={{ background: hex(primaryColor, 0.1) }}
      >
        <Icon className="w-4.5 h-4.5" style={{ color: primaryColor }} />
      </div>
      <p className="text-white text-2xl font-bold tracking-tight">{value}</p>
      <p className="text-gray-400 text-xs font-medium mt-0.5">{label}</p>
      {sub && <p className="text-gray-700 text-[10px] mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  records: AttendanceRow[];
  summary: AttendanceSummary;
  primaryColor: string;
}

export default function AttendanceView({ records, summary, primaryColor }: Props) {
  const [query, setQuery] = useState("");
  const [methodFilter, setMethodFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    let list = records;
    if (methodFilter !== "all") list = list.filter((r) => r.checkInMethod === methodFilter);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (r) =>
          r.memberName.toLowerCase().includes(q) ||
          r.className.toLowerCase().includes(q)
      );
    }
    return list;
  }, [records, query, methodFilter]);

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Attendance</h1>
        <p className="text-gray-500 text-sm mt-0.5">Recent check-ins across all classes</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard
          label="This Month"
          value={summary.totalThisMonth}
          sub="check-ins"
          icon={Calendar}
          primaryColor={primaryColor}
        />
        <StatCard
          label="This Week"
          value={summary.totalThisWeek}
          sub="check-ins"
          icon={TrendingUp}
          primaryColor={primaryColor}
        />
        <StatCard
          label="Active Members"
          value={summary.uniqueMembersThisMonth}
          sub="this month"
          icon={Users}
          primaryColor={primaryColor}
        />
        <StatCard
          label="Top Class"
          value={summary.topClass ?? "—"}
          sub="this month"
          icon={Award}
          primaryColor={primaryColor}
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search member or class..."
            className="w-full bg-white/4 border border-black/10 rounded-xl pl-9 pr-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-white/20"
          />
        </div>
        <div className="flex items-center gap-1.5 p-1 rounded-xl border border-black/10 bg-black/3">
          <Filter className="w-3.5 h-3.5 text-gray-600 ml-2" />
          {["all", "qr", "admin", "self"].map((m) => (
            <button
              key={m}
              onClick={() => setMethodFilter(m)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={
                methodFilter === m
                  ? { background: primaryColor, color: "white" }
                  : { color: "rgba(255,255,255,0.5)" }
              }
            >
              {m === "all" ? "All" : METHOD_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-gray-600 text-sm">No attendance records found</p>
        </div>
      ) : (
        <div
          className="rounded-2xl border overflow-hidden"
          style={{ borderColor: "rgba(255,255,255,0.08)" }}
        >
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr style={{ background: "rgba(255,255,255,0.025)" }}>
                  {["Member", "Class", "Date", "Time", "Method"].map((h) => (
                    <th
                      key={h}
                      className="text-left px-4 py-3 text-gray-600 text-xs font-semibold uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr
                    key={r.id}
                    className="border-t border-black/8 hover:bg-black/2 transition-colors"
                    style={i % 2 === 0 ? {} : { background: "rgba(255,255,255,0.015)" }}
                  >
                    <td className="px-4 py-3">
                      <p className="text-white text-sm font-medium">{r.memberName}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-gray-300 text-sm">{r.className}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-gray-400 text-sm">{formatDate(r.date)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-gray-400 text-sm">{r.startTime}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
                        style={{
                          background: hex(METHOD_COLORS[r.checkInMethod] ?? "#6b7280", 0.12),
                          color: METHOD_COLORS[r.checkInMethod] ?? "#6b7280",
                        }}
                      >
                        {METHOD_LABELS[r.checkInMethod] ?? r.checkInMethod}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden divide-y divide-white/5">
            {filtered.map((r) => (
              <div key={r.id} className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-white text-sm font-medium truncate">{r.memberName}</p>
                  <p className="text-gray-500 text-xs truncate">{r.className} · {formatDate(r.date)} {r.startTime}</p>
                </div>
                <span
                  className="shrink-0 px-2 py-0.5 rounded-full text-xs font-medium"
                  style={{
                    background: hex(METHOD_COLORS[r.checkInMethod] ?? "#6b7280", 0.12),
                    color: METHOD_COLORS[r.checkInMethod] ?? "#6b7280",
                  }}
                >
                  {METHOD_LABELS[r.checkInMethod] ?? r.checkInMethod}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-gray-700 text-xs mt-3 text-center">
        Showing {filtered.length} of {records.length} records
      </p>
    </div>
  );
}
