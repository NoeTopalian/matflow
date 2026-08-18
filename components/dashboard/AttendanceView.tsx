"use client";

import { useState, useMemo } from "react";
import { Users, TrendingUp, Calendar, Award, Search, Filter } from "lucide-react";
import type { AttendanceRow, AttendanceSummary } from "@/app/dashboard/attendance/page";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/StatusPill";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Token-safe tint. Replaces the local `hex()` copy (UI-RULES §2: delete one
 * whenever you touch a file that has one) — `color-mix` works with BOTH the
 * `--hue-*`/`--tx-*` CSS vars and the runtime tenant hex, which the byte-maths
 * version could not.
 */
function tint(color: string, percent: number) {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
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

/**
 * Categorical check-in-method hues. Three map straight onto the semantic
 * tokens; `self` keeps a violet literal because the token scale has no fifth
 * hue and the four methods must stay tellable apart at a glance.
 */
const METHOD_COLORS: Record<string, string> = {
  qr: "var(--hue-success)",
  admin: "var(--hue-info)",
  self: "#8b5cf6",
  auto: "var(--hue-warning)",
};

/** One lookup for the chip, so the fallback is written once rather than four times. */
function methodChip(method: string) {
  const color = METHOD_COLORS[method] ?? "var(--tx-3)";
  return { label: METHOD_LABELS[method] ?? method, color, bg: tint(color, 12) };
}

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
    <Card padding="tight">
      <div
        className="w-9 h-9 rounded-[var(--r-md)] flex items-center justify-center mb-3"
        style={{ background: tint(primaryColor, 10) }}
      >
        <Icon className="size-4" style={{ color: primaryColor }} />
      </div>
      <p className="text-2xl font-bold tracking-tight" style={{ color: "var(--tx-1)" }}>{value}</p>
      <p className="text-xs font-medium mt-0.5" style={{ color: "var(--tx-2)" }}>{label}</p>
      {sub && <p className="text-[10px] mt-0.5" style={{ color: "var(--tx-3)" }}>{sub}</p>}
    </Card>
  );
}

// ─── Table columns ────────────────────────────────────────────────────────────

/**
 * Rendered through the DataTable primitive (§1.5.4 dense spec, sticky thead,
 * zebra + hover from tokens, card-collapse below `sm:`). This replaces the
 * hand-maintained pair — a `hidden md:block` table whose zebra and hover were
 * both white-alpha, i.e. two states that painted nothing at all on the light
 * staff shell (§4a.5). Module scope keeps the array identity stable across
 * renders.
 */
const ATTENDANCE_COLUMNS: DataTableColumn<AttendanceRow>[] = [
  {
    key: "member",
    header: "Member",
    sortValue: (r) => r.memberName,
    cell: (r) => <span className="font-medium">{r.memberName}</span>,
  },
  {
    key: "class",
    header: "Class",
    sortValue: (r) => r.className,
    cell: (r) => <span className="text-tx-2">{r.className}</span>,
  },
  {
    key: "date",
    header: "Date",
    width: "9rem",
    sortValue: (r) => new Date(r.date),
    cell: (r) => <span className="text-tx-2">{formatDate(r.date)}</span>,
  },
  {
    key: "time",
    header: "Time",
    width: "6rem",
    sortValue: (r) => r.startTime,
    cell: (r) => <span className="text-tx-2 tabular-nums">{r.startTime}</span>,
  },
  {
    key: "method",
    header: "Method",
    width: "13rem",
    cell: (r) => {
      const chip = methodChip(r.checkInMethod);
      return (
        <span className="inline-flex items-center gap-2">
          <StatusPill label={chip.label} bg={chip.bg} color={chip.color} />
          {r.checkedInByName && (
            <span className="text-[11px] text-tx-3">· by {r.checkedInByName}</span>
          )}
        </span>
      );
    },
  },
];

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
    <>
      <PageHeader title="Attendance" description="Recent check-ins across all classes" />

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
            aria-label="Search attendance by member or class"
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
              aria-pressed={methodFilter === m}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={
                methodFilter === m
                  ? { background: primaryColor, color: "var(--tx-on-accent)" }
                  : { color: "var(--tx-3)" }
              }
            >
              {m === "all" ? "All" : METHOD_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {/* Records. The card chrome starts at `sm:` because below that the
          primitive renders its own per-row Cards — an outer card would nest
          white on white. No `overflow-hidden`: it would become the table's
          nearest scroll container and make the sticky <thead> inert. */}
      <div className="sm:rounded-[var(--r-md)] sm:border sm:border-bd-default sm:bg-sf-1">
        <DataTable
          label="Attendance records"
          rows={filtered}
          rowKey={(r) => r.id}
          columns={ATTENDANCE_COLUMNS}
          empty={
            <div className="py-16 text-center text-sm" style={{ color: "var(--tx-3)" }}>
              No attendance records found
            </div>
          }
          renderCard={(r) => {
            const chip = methodChip(r.checkInMethod);
            return (
              <Card padding="tight" className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate" style={{ color: "var(--tx-1)" }}>{r.memberName}</p>
                  <p className="text-xs truncate" style={{ color: "var(--tx-3)" }}>
                    {r.className} · {formatDate(r.date)} {r.startTime}
                    {r.checkedInByName && <span> · by {r.checkedInByName}</span>}
                  </p>
                </div>
                <StatusPill label={chip.label} bg={chip.bg} color={chip.color} />
              </Card>
            );
          }}
        />
      </div>

      <p className="text-xs mt-3 text-center" style={{ color: "var(--tx-3)" }}>
        Showing {filtered.length} of {records.length} records
      </p>
    </>
  );
}
