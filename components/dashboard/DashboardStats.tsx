"use client";

import { Users, TrendingUp, Calendar, UserPlus, QrCode, Plus } from "lucide-react";
import Link from "next/link";

interface Props {
  stats: {
    totalActive: number;
    newThisMonth: number;
    attendanceThisWeek: number;
    attendanceThisMonth: number;
  };
  userName: string;
  primaryColor: string;
}

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

interface CardProps {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  primaryColor: string;
  delay?: number;
}

function Card({ label, value, sub, icon: Icon, primaryColor, delay = 0 }: CardProps) {
  return (
    <div
      className="animate-fade-up rounded-2xl border p-5 flex flex-col gap-3 transition-all duration-250"
      style={{
        background: "var(--sf-1)",
        borderColor: "var(--bd-default)",
        animationDelay: `${delay}ms`,
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = "var(--sf-2)";
        el.style.borderColor = "var(--bd-hover)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = "var(--sf-1)";
        el.style.borderColor = "var(--bd-default)";
      }}
    >
      {/* Icon */}
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: hex(primaryColor, 0.12) }}
      >
        <Icon className="w-5 h-5" style={{ color: primaryColor }} />
      </div>

      {/* Value + label */}
      <div>
        <p
          className="text-2xl font-bold leading-none tracking-tight"
          style={{ color: "var(--tx-1)" }}
        >
          {value}
        </p>
        <p className="text-sm font-medium mt-1.5" style={{ color: "var(--tx-2)" }}>
          {label}
        </p>
        {sub && (
          <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
            {sub}
          </p>
        )}
      </div>
    </div>
  );
}

export default function DashboardStats({ stats, userName, primaryColor }: Props) {
  const firstName = userName.split(" ")[0];

  return (
    <div>
      <div className="animate-fade-up flex items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight" style={{ color: "var(--tx-1)" }}>
            Good {getTimeOfDay()}, {firstName}
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--tx-3)" }}>
            Here&apos;s your gym at a glance
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/dashboard/checkin"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-gray-400 border border-black/10 hover:border-white/20 hover:text-white transition-all"
            style={{ background: "rgba(0,0,0,0.02)" }}
          >
            <QrCode className="w-3.5 h-3.5" />
            Check-In
          </Link>
          <Link
            href="/dashboard/timetable"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-90"
            style={{ background: primaryColor }}
          >
            <Plus className="w-3.5 h-3.5" />
            Add Class
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card
          label="Active Members"
          value={stats.totalActive}
          icon={Users}
          primaryColor={primaryColor}
          delay={0}
        />
        <Card
          label="New This Month"
          value={stats.newThisMonth > 0 ? `+${stats.newThisMonth}` : stats.newThisMonth}
          sub="sign-ups"
          icon={UserPlus}
          primaryColor={primaryColor}
          delay={40}
        />
        <Card
          label="Check-ins This Week"
          value={stats.attendanceThisWeek}
          icon={Calendar}
          primaryColor={primaryColor}
          delay={80}
        />
        <Card
          label="Check-ins This Month"
          value={stats.attendanceThisMonth}
          icon={TrendingUp}
          primaryColor={primaryColor}
          delay={120}
        />
      </div>
    </div>
  );
}

function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}
