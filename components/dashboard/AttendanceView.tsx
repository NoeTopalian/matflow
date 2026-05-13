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

const METHOD_LABELS: Record<string, string> = {
  qr: "QR Scan",
  admin: "Admin",
  self: "Self",
  auto: "Auto",
};

// Method colours: kept as raw hex pending Phase 4 semantic-colour token consolidation.
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
      style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
    >
      <div
        className="w-9 h-9 rounded-xl flex items-center justify-center mb-3"
        style={{ background: hex(primaryColor, 0.1) }}
      >
        <Icon className="w-4.5 h-4.5" style={{ color: primaryColor }} />
      </div>
      <p className="text-2xl font-bold tracking-tight" style={{ color: "var(--tx-1)" }}>{value}</p>
      <p className="text-xs font-medium mt-0.5" style={{ color: "var(--tx-2)" }}>{label}</p>
      {sub && <p className="text-[10px] mt-0.5" style={{ color: "var(--tx-4)" }}>{sub}</p>}
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
        <h1 className="text-2xl font-bold" style={{ color: "var(--tx-1)" }}>Attendance</h1>
        <p className="text-sm mt-0.5" style={{ color: "var(--tx-3)" }}>Recent check-ins across all classes</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label="This Month" value={summary.totalThisMonth} sub="check-ins" icon={Calendar} primaryColor={primaryColor} />
        <StatCard label="This Week" value={summary.totalThisWeek} sub="check-ins" icon={TrendingUp} primaryColor={primaryColor} />
        <StatCard label="Active Members" value={summary.uniqueMembersThisMonth} sub="this month" icon={Users} primaryColor={primaryColor} />
        <StatCard label="Top Class" value={summary.topClass ?? "—"} sub="this month" icon={Award} primaryColor={primaryColor} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: "var(--tx-3)" }} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search member or class..."
            className="w-full border rounded-xl pl-9 pr-3 py-2.5 text-sm focus:outline-none placeholder:text-[var(--tx-3)]"
            style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--bd-active)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-default)"; }}
          />
        </div>
        <div className="flex items-center gap-1.5 p-1 rounded-xl border" style={{ borderColor: "var(--bd-default)", background: "var(--sf-1)" }}>
          <Filter className="w-3.5 h-3.5 ml-2" style={{ color: "var(--tx-3)" }} />
          {["all", "qr", "admin", "self"].map((m) => (
            <button
              key={m}
              onClick={() => setMethodFilter(m)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={
                methodFilter === m
                  ? { background: primaryColor, color: "white" }
                  : { color: "var(--tx-3)" }
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
          <p className="text-sm" style={{ color: "var(--tx-3)" }}>No attendance records found</p>
        </div>
      ) : (
        <div
          className="rounded-2xl border overflow-hidden"
          style={{ borderColor: "var(--bd-default)" }}
        >
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr style={{ background: "var(--sf-2)" }}>
                  {["Member", "Class", "Date", "Time", "Method"].map((h) => (
                    <th
                      key={h}
                      className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider"
                      style={{ color: "var(--tx-3)" }}
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
                    className="border-t transition-colors hover:bg-white/5"
                    style={{
                      borderColor: "var(--bd-default)",
                      ...(i % 2 === 0 ? {} : { background: "rgba(255,255,255,0.015)" }),
                    }}
                  >
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium" style={{ color: "var(--tx-1)" }}>{r.memberName}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm" style={{ color: "var(--tx-2)" }}>{r.className}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm" style={{ color: "var(--tx-2)" }}>{formatDate(r.date)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm" style={{ color: "var(--tx-2)" }}>{r.startTime}</p>
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
                      {r.checkedInByName && (
                        <span className="ml-2 text-xs" style={{ color: "var(--tx-3)" }}>· by {r.checkedInByName}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden divide-y" style={{ borderColor: "var(--bd-default)" }}>
            {filtered.map((r) => (
              <div key={r.id} className="px-4 py-3 flex items-center justify-between gap-3" style={{ borderColor: "var(--bd-default)" }}>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate" style={{ color: "var(--tx-1)" }}>{r.memberName}</p>
                  <p className="text-xs truncate" style={{ color: "var(--tx-3)" }}>
                    {r.className} · {formatDate(r.date)} {r.startTime}
                    {r.checkedInByName && <span style={{ color: "var(--tx-3)" }}> · by {r.checkedInByName}</span>}
                  </p>
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

      <p className="text-xs mt-3 text-center" style={{ color: "var(--tx-4)" }}>
        Showing {filtered.length} of {records.length} records
      </p>
    </div>
  );
}
