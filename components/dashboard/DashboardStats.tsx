"use client";

import Link from "next/link";
import {
  AlertTriangle,
  CalendarCheck,
  ClipboardList,
  CreditCard,
  QrCode,
  ShieldAlert,
  UserRoundX,
  Plus,
} from "lucide-react";
import type { DayClass } from "@/components/dashboard/WeeklyCalendar";

interface Props {
  stats: {
    totalActive: number;
    newThisMonth: number;
    attendanceThisWeek: number;
    attendanceThisMonth: number;
    waiverMissing: number;
    missingPhone: number;
    paymentsDue: number;
    atRiskMembers: number;
  };
  classes: DayClass[];
  tenantName: string;
  primaryColor: string;
}

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function todayKey() {
  return new Date().toISOString().split("T")[0];
}

function formatDate() {
  return new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function classStatus(cls: DayClass) {
  if (!cls.coach || cls.coach === "TBC") return { label: "Needs coach", color: "#f59e0b", bg: "rgba(245,158,11,0.12)" };
  if (cls.capacity && cls.enrolled >= cls.capacity) return { label: "Full", color: "#ef4444", bg: "rgba(239,68,68,0.12)" };
  return { label: "Ready", color: "#22c55e", bg: "rgba(34,197,94,0.12)" };
}

function MetricCard({
  label,
  value,
  detail,
  color,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  detail: string;
  color: string;
  icon: React.ElementType;
}) {
  return (
    <div className="rounded-2xl border p-4" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] font-semibold" style={{ color: "var(--tx-4)" }}>
            {label}
          </p>
          <p className="text-2xl font-bold mt-2 leading-none" style={{ color: "var(--tx-1)" }}>
            {value}
          </p>
          <p className="text-xs mt-2" style={{ color: "var(--tx-3)" }}>
            {detail}
          </p>
        </div>
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: hex(color, 0.14), color }}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </div>
  );
}

export default function DashboardStats({ stats, classes, tenantName, primaryColor }: Props) {
  const today = todayKey();
  const todayClasses = classes.filter((cls) => cls.date === today);
  const bookedToday = todayClasses.reduce((sum, cls) => sum + cls.enrolled, 0);
  const spacesLeft = todayClasses.reduce((sum, cls) => {
    if (!cls.capacity) return sum;
    return sum + Math.max(cls.capacity - cls.enrolled, 0);
  }, 0);
  const ownerTodoCount = stats.waiverMissing + stats.paymentsDue + stats.missingPhone + stats.atRiskMembers;

  const todoItems = [
    { label: "Missing waivers", count: stats.waiverMissing, Icon: ShieldAlert, color: "#f59e0b" },
    { label: "Overdue payments", count: stats.paymentsDue, Icon: CreditCard, color: "#ef4444" },
    { label: "Missing phone numbers", count: stats.missingPhone, Icon: UserRoundX, color: "#f59e0b" },
    { label: "Members not seen in 14 days", count: stats.atRiskMembers, Icon: AlertTriangle, color: "#a78bfa" },
  ];

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--tx-1)" }}>
            Today at {tenantName}
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--tx-3)" }}>
            {formatDate()}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/dashboard/checkin"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border transition-all hover:border-white/20 hover:text-white"
            style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
          >
            <QrCode className="w-3.5 h-3.5" />
            Check-In
          </Link>
          <Link
            href="/dashboard/timetable"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-white transition-all hover:opacity-90"
            style={{ background: primaryColor }}
          >
            <Plus className="w-3.5 h-3.5" />
            Add Class
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <MetricCard label="Owner To-Do" value={ownerTodoCount} detail="Tasks needing attention" color="#f59e0b" icon={ClipboardList} />
        <MetricCard label="Payments Due" value={stats.paymentsDue} detail="Members to chase" color="#ef4444" icon={CreditCard} />
        <MetricCard
          label="Today's Classes"
          value={todayClasses.length}
          detail={`${bookedToday} booked${spacesLeft > 0 ? ` · ${spacesLeft} spaces left` : ""}`}
          color={primaryColor}
          icon={CalendarCheck}
        />
        <MetricCard label="At-Risk Members" value={stats.atRiskMembers} detail="Not seen in 14 days" color="#a78bfa" icon={AlertTriangle} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[0.9fr_1.1fr] gap-4">
        <div className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold" style={{ color: "var(--tx-1)" }}>Owner To-Do</h2>
              <p className="text-xs mt-1" style={{ color: "var(--tx-3)" }}>Items worth checking today</p>
            </div>
            <span className="text-xs font-semibold px-2 py-1 rounded-lg" style={{ background: "rgba(245,158,11,0.12)", color: "#f59e0b" }}>
              {ownerTodoCount} open
            </span>
          </div>
          <div className="space-y-2">
            {todoItems.map(({ label, count, Icon, color }) => (
              <div key={label} className="flex items-center justify-between gap-3 rounded-xl border px-3 py-3" style={{ background: "rgba(255,255,255,0.018)", borderColor: "var(--bd-default)" }}>
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: hex(color, 0.12), color }}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <span className="text-sm truncate" style={{ color: "var(--tx-2)" }}>{label}</span>
                </div>
                <span className="text-sm font-semibold tabular-nums" style={{ color: count > 0 ? color : "var(--tx-3)" }}>
                  {count}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold" style={{ color: "var(--tx-1)" }}>Today&apos;s Classes</h2>
              <p className="text-xs mt-1" style={{ color: "var(--tx-3)" }}>Schedule and register readiness</p>
            </div>
            <Link href="/dashboard/coach" className="text-xs font-semibold hover:opacity-80" style={{ color: primaryColor }}>
              Open register
            </Link>
          </div>

          <div className="space-y-2">
            {todayClasses.length === 0 ? (
              <div className="rounded-xl border px-3 py-6 text-center" style={{ borderColor: "var(--bd-default)", color: "var(--tx-3)" }}>
                No classes scheduled today
              </div>
            ) : (
              todayClasses.slice(0, 5).map((cls) => {
                const status = classStatus(cls);
                return (
                  <div key={cls.id} className="flex items-center justify-between gap-3 rounded-xl border px-3 py-3" style={{ background: "rgba(255,255,255,0.018)", borderColor: "var(--bd-default)" }}>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate" style={{ color: "var(--tx-1)" }}>
                        {cls.time} · {cls.name}
                      </p>
                      <p className="text-xs mt-0.5 truncate" style={{ color: "var(--tx-3)" }}>
                        {cls.coach}{cls.location ? ` · ${cls.location}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs tabular-nums" style={{ color: "var(--tx-2)" }}>
                        {cls.enrolled}{cls.capacity ? ` / ${cls.capacity}` : ""}
                      </span>
                      <span className="text-[11px] font-semibold px-2 py-1 rounded-lg" style={{ background: status.bg, color: status.color }}>
                        {status.label}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
