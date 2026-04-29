"use client";

import { TrendingUp, Flame, Calendar, Clock } from "lucide-react";
import { useState, useEffect } from "react";

const PRIMARY = "#3b82f6";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AttendanceByClass { id: string; name: string; count: number; }

interface MemberData {
  name: string;
  belt: { name: string; color: string; stripes: number; promotedBy: string | null } | null;
  stats: {
    thisWeek: number;
    thisMonth: number;
    thisYear: number;
    streakWeeks: number;
    totalClasses: number;
    attendanceByClass?: AttendanceByClass[];
    avgClassesPerWeek?: number;
  };
}

// ─── Demo fallback data ────────────────────────────────────────────────────────

const DEMO_MEMBER: MemberData = {
  name: "Alex Johnson",
  belt: { name: "Blue Belt", color: "#3b82f6", stripes: 3, promotedBy: "Coach Mike" },
  stats: {
    thisWeek: 3,
    thisMonth: 9,
    thisYear: 47,
    streakWeeks: 8,
    totalClasses: 47,
    attendanceByClass: [
      { id: "demo-c1", name: "Beginner BJJ", count: 18 },
      { id: "demo-c2", name: "No-Gi", count: 12 },
      { id: "demo-c3", name: "Open Mat", count: 9 },
    ],
    avgClassesPerWeek: 3.2,
  },
};


// ─── Helpers ─────────────────────────────────────────────────────────────────

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ─── Belt card ────────────────────────────────────────────────────────────────

function BeltCard({ belt, totalClasses }: { belt: MemberData["belt"]; totalClasses: number }) {
  const beltName = belt?.name ?? "White Belt";
  const beltColor = belt?.color ?? "#e5e7eb";
  const stripes = belt?.stripes ?? 0;
  const promotedBy = belt?.promotedBy;
  const pct = Math.round((totalClasses / 150) * 100);

  return (
    <div
      className="rounded-3xl border p-5 mb-4"
      style={{ background: hex(beltColor, 0.06), borderColor: hex(beltColor, 0.2) }}
    >
      <div className="flex items-center gap-4">
        {/* Belt graphic */}
        <div className="shrink-0">
          <div
            className="w-16 h-6 rounded-md flex items-center justify-end pr-1.5 gap-0.5"
            style={{ background: beltColor }}
          >
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="w-2.5 h-4 rounded-sm"
                style={{ background: i < stripes ? "white" : "rgba(0,0,0,0.3)" }}
              />
            ))}
          </div>
          <p className="text-[10px] text-gray-500 text-center mt-1">{stripes}/4 stripes</p>
        </div>

        <div className="flex-1">
          <p className="text-white font-bold text-lg">{beltName}</p>
          {promotedBy && <p className="text-gray-500 text-xs mt-0.5">Promoted by {promotedBy}</p>}
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-4">
        <div className="flex justify-between text-xs mb-1.5">
          <span className="text-gray-500">Yearly class count</span>
          <span style={{ color: beltColor }}>{pct}%</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--member-border)" }}>
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${Math.min(pct, 100)}%`, background: beltColor }}
          />
        </div>
        <p className="text-gray-700 text-[10px] mt-1">{totalClasses} classes this year</p>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MemberProgressPage() {
  const [primaryColor, setPrimaryColor] = useState(PRIMARY);
  const [member, setMember] = useState<MemberData>(DEMO_MEMBER);
  const [subscribedClasses, setSubscribedClasses] = useState<Array<{ id: string; name: string; day: string; time: string; coach: string }>>([]);
  const [classesLoading, setClassesLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  function loadPageData() {
    setLoadError(null);
    setClassesLoading(true);

    fetch("/api/member/me")
      .then((r) => r.ok ? r.json() : null)
      .then((data: (MemberData & { primaryColor?: string }) | null) => {
        if (data?.stats) setMember(data);
        if (data?.primaryColor) setPrimaryColor(data.primaryColor);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Couldn't load — tap to retry"));

    fetch("/api/member/classes")
      .then((r) => r.ok ? r.json() : null)
      .then((data: Array<{ id: string; name: string; day: string; time: string; coach: string }> | null) => {
        if (!Array.isArray(data)) return;
        setSubscribedClasses(data);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Couldn't load — tap to retry"))
      .finally(() => setClassesLoading(false));
  }

  useEffect(() => {
    loadPageData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const belt = member.belt ?? DEMO_MEMBER.belt!;
  const stats = member.stats;

  return (
    <div className="px-4 pt-4 pb-8">
      <div className="mb-5">
        <h1 className="text-white text-xl font-bold tracking-tight">Progress</h1>
        <p className="text-gray-500 text-sm mt-0.5">{member.name}</p>
      </div>

      {/* Load error banner */}
      {loadError && (
        <div className="mb-4 px-4 py-3 rounded-2xl flex items-center justify-between gap-3" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
          <p className="text-red-400 text-sm flex-1">{loadError}</p>
          <button
            onClick={loadPageData}
            className="text-xs font-semibold px-3 py-1.5 rounded-xl shrink-0"
            style={{ background: "rgba(239,68,68,0.15)", color: "#f87171" }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Belt card */}
      <BeltCard belt={belt} totalClasses={stats.thisYear} />

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2.5 mb-6">
        {[
          { label: "This Week",      value: stats.thisWeek,          icon: Calendar,   sub: "classes attended" },
          { label: "This Month",     value: stats.thisMonth,         icon: TrendingUp, sub: "classes attended" },
          { label: "This Year",      value: stats.thisYear,          icon: Clock,      sub: "classes attended" },
          { label: "Current Streak", value: `${stats.streakWeeks}w`, icon: Flame,      sub: "weeks in a row" },
        ].map(({ label, value, icon: Icon, sub }) => (
          <div
            key={label}
            className="rounded-2xl border p-4"
            style={{ background: "var(--member-surface)", borderColor: "var(--member-surface)" }}
          >
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center mb-3"
              style={{ background: hex(primaryColor, 0.1) }}
            >
              <Icon className="w-4 h-4" style={{ color: primaryColor }} />
            </div>
            <p className="text-white text-2xl font-bold tracking-tight leading-none">{value}</p>
            <p className="text-gray-500 text-xs font-medium mt-1">{label}</p>
            <p className="text-gray-700 text-[10px] mt-0.5">{sub}</p>
          </div>
        ))}
      </div>

      {/* Sprint 4-A US-401: attendance breakdown + average per week */}
      {(stats.attendanceByClass?.length ?? 0) > 0 && (
        <div className="rounded-2xl border p-4 mb-6" style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-white font-semibold text-sm">Most attended (90 days)</p>
            {typeof stats.avgClassesPerWeek === "number" && (
              <span className="text-xs" style={{ color: primaryColor }}>
                avg {stats.avgClassesPerWeek}/wk · 8w
              </span>
            )}
          </div>
          <ul className="space-y-2">
            {stats.attendanceByClass!.map((c) => {
              const max = stats.attendanceByClass![0]?.count || 1;
              const pct = Math.round((c.count / max) * 100);
              return (
                <li key={c.id} className="flex items-center gap-3">
                  <span className="text-white text-sm font-medium w-32 truncate">{c.name}</span>
                  <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: "var(--member-border)" }}>
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pct}%`, background: primaryColor }}
                    />
                  </div>
                  <span className="text-gray-400 text-xs tabular-nums w-8 text-right">{c.count}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Subscribed classes */}
      <div>
        <h2 className="text-white font-semibold text-sm mb-3">Your Classes</h2>
        {!classesLoading && subscribedClasses.length === 0 ? (
          <div
            className="rounded-2xl border px-4 py-6 text-center"
            style={{ borderColor: "var(--member-surface)", background: "var(--member-surface)" }}
          >
            <p className="text-gray-500 text-sm">No subscribed classes yet</p>
            <p className="text-gray-700 text-xs mt-1">Go to Schedule to subscribe to classes</p>
          </div>
        ) : (
          <div className="space-y-2">
            {subscribedClasses.map((cls) => (
              <div
                key={cls.id}
                className="flex items-center gap-3 px-4 py-3.5 rounded-2xl border"
                style={{ background: "var(--member-surface)", borderColor: "var(--member-surface)" }}
              >
                <div
                  className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: hex(primaryColor, 0.1) }}
                >
                  <Calendar className="w-4 h-4" style={{ color: primaryColor }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-semibold truncate">{cls.name}</p>
                  <p className="text-gray-500 text-xs mt-0.5">{cls.day} · {cls.time} · {cls.coach}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
