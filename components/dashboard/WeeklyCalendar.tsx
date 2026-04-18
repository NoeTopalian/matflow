"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronLeft, ChevronRight, Users, Clock, MapPin, Plus, QrCode } from "lucide-react";
import Link from "next/link";

export interface DayClass {
  id: string;
  name: string;
  time: string;       // "09:00"
  endTime?: string;   // "10:00"
  coach: string;
  capacity: number | null;
  enrolled: number;
  location?: string;
  date: string;       // "2026-03-07"
}

interface Props {
  classes: DayClass[];
  tenantName: string;
  userName: string;
  primaryColor: string;
}

function getWeekDays(anchor: Date): Date[] {
  const day = anchor.getDay(); // 0 = Sun
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() - ((day + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function fmt(d: Date) {
  return d.toISOString().split("T")[0];
}

function hexToRgba(hex: string, alpha: number) {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export default function WeeklyCalendar({ classes, tenantName, userName, primaryColor }: Props) {
  const today = new Date();
  const [anchor, setAnchor] = useState(today);
  const [selectedDate, setSelectedDate] = useState(fmt(today));
  const weekDays = getWeekDays(anchor);
  const dayScrollRef = useRef<HTMLDivElement>(null);

  // Scroll selected day pill into view on mobile
  useEffect(() => {
    const idx = weekDays.findIndex((d) => fmt(d) === selectedDate);
    if (idx >= 0 && dayScrollRef.current) {
      const pill = dayScrollRef.current.children[idx] as HTMLElement;
      pill?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }, [selectedDate]);

  function prevWeek() {
    const d = new Date(anchor);
    d.setDate(d.getDate() - 7);
    setAnchor(d);
    setSelectedDate(fmt(d));
  }
  function nextWeek() {
    const d = new Date(anchor);
    d.setDate(d.getDate() + 7);
    setAnchor(d);
    setSelectedDate(fmt(d));
  }
  function goToday() {
    setAnchor(today);
    setSelectedDate(fmt(today));
  }

  const isToday = (d: Date) => fmt(d) === fmt(today);
  const isSelected = (d: Date) => fmt(d) === selectedDate;

  const classesForDate = (date: string) => classes.filter((c) => c.date === date);
  const selectedClasses = classesForDate(selectedDate);

  const weekStart = weekDays[0];
  const weekEnd = weekDays[6];
  const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
  const weekLabel = sameMonth
    ? `${weekStart.toLocaleDateString("en-GB", { day: "numeric" })}–${weekEnd.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`
    : `${weekStart.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${weekEnd.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;

  return (
    <div className="max-w-6xl mx-auto">

      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-white text-xl font-bold tracking-tight">
            {getGreeting()}, {userName.split(" ")[0]}
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">{tenantName}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard/checkin"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-gray-400 border border-white/8 hover:border-white/20 hover:text-white transition-all bg-white/3"
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

      {/* Week navigation */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-1">
          <button
            onClick={prevWeek}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/8 transition-all"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={nextWeek}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/8 transition-all"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <span className="text-white text-sm font-medium ml-1">{weekLabel}</span>
        </div>
        <button
          onClick={goToday}
          className="text-xs font-medium px-3 py-1.5 rounded-lg border border-white/10 text-gray-400 hover:text-white hover:border-white/25 transition-all"
        >
          Today
        </button>
      </div>

      {/* ── DESKTOP: full week grid ── */}
      <div className="hidden md:grid grid-cols-7 gap-2 mb-6">
        {weekDays.map((day, i) => {
          const dateStr = fmt(day);
          const dayClasses = classesForDate(dateStr);
          const isTod = isToday(day);
          const isSel = isSelected(day);

          return (
            <div
              key={dateStr}
              onClick={() => setSelectedDate(dateStr)}
              className="rounded-xl border cursor-pointer transition-all min-h-[140px]"
              style={{
                background: isSel ? hexToRgba(primaryColor, 0.06) : "rgba(255,255,255,0.02)",
                borderColor: isSel ? hexToRgba(primaryColor, 0.35) : "rgba(255,255,255,0.06)",
              }}
            >
              {/* Day header */}
              <div className="p-2.5 pb-2 border-b border-white/5">
                <p className="text-gray-500 text-[10px] font-semibold uppercase tracking-widest">
                  {DAY_LABELS[i]}
                </p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span
                    className="text-lg font-bold leading-none"
                    style={{ color: isTod ? primaryColor : "white" }}
                  >
                    {day.getDate()}
                  </span>
                  {isTod && (
                    <span
                      className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                      style={{ background: hexToRgba(primaryColor, 0.15), color: primaryColor }}
                    >
                      TODAY
                    </span>
                  )}
                </div>
              </div>

              {/* Classes */}
              <div className="p-1.5 space-y-1">
                {dayClasses.length === 0 ? (
                  <p className="text-gray-700 text-[10px] text-center py-3">—</p>
                ) : (
                  dayClasses.map((cls) => (
                    <ClassPill key={cls.id} cls={cls} primaryColor={primaryColor} compact />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── MOBILE: day pill selector + list ── */}
      <div className="md:hidden mb-5">
        {/* Day pills */}
        <div
          ref={dayScrollRef}
          className="flex gap-2 overflow-x-auto pb-3 scrollbar-hide snap-x snap-mandatory"
          style={{ scrollbarWidth: "none" }}
        >
          {weekDays.map((day, i) => {
            const dateStr = fmt(day);
            const isTod = isToday(day);
            const isSel = isSelected(day);
            const count = classesForDate(dateStr).length;

            return (
              <button
                key={dateStr}
                onClick={() => setSelectedDate(dateStr)}
                className="flex flex-col items-center gap-1 px-3.5 py-2.5 rounded-2xl flex-shrink-0 snap-center transition-all"
                style={{
                  background: isSel ? primaryColor : isTod ? hexToRgba(primaryColor, 0.1) : "rgba(255,255,255,0.04)",
                  border: `1.5px solid ${isSel ? primaryColor : isTod ? hexToRgba(primaryColor, 0.3) : "rgba(255,255,255,0.07)"}`,
                  minWidth: 52,
                }}
              >
                <span
                  className="text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: isSel ? "white" : "rgba(255,255,255,0.4)" }}
                >
                  {DAY_LABELS[i]}
                </span>
                <span
                  className="text-lg font-bold leading-none"
                  style={{ color: isSel ? "white" : isTod ? primaryColor : "white" }}
                >
                  {day.getDate()}
                </span>
                {count > 0 && (
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: isSel ? "rgba(255,255,255,0.6)" : primaryColor }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected day detail — shown on mobile always, on desktop as bottom panel */}
      <div className="md:hidden">
        <SelectedDayPanel
          day={weekDays.find((d) => fmt(d) === selectedDate) ?? weekDays[0]}
          dayIdx={weekDays.findIndex((d) => fmt(d) === selectedDate)}
          classes={selectedClasses}
          primaryColor={primaryColor}
        />
      </div>

      {/* Desktop: selected day detail below grid */}
      <div className="hidden md:block">
        <SelectedDayPanel
          day={weekDays.find((d) => fmt(d) === selectedDate) ?? weekDays[0]}
          dayIdx={weekDays.findIndex((d) => fmt(d) === selectedDate)}
          classes={selectedClasses}
          primaryColor={primaryColor}
        />
      </div>
    </div>
  );
}

function SelectedDayPanel({
  day,
  dayIdx,
  classes,
  primaryColor,
}: {
  day: Date;
  dayIdx: number;
  classes: DayClass[];
  primaryColor: string;
}) {
  const dateLabel = day.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-white font-semibold text-sm">{dateLabel}</h3>
        <span className="text-gray-600 text-xs">{classes.length} class{classes.length !== 1 ? "es" : ""}</span>
      </div>

      {classes.length === 0 ? (
        <div className="rounded-xl border border-white/5 bg-white/2 py-10 text-center">
          <p className="text-gray-600 text-sm">No classes scheduled</p>
          <Link
            href="/dashboard/timetable"
            className="text-xs mt-2 inline-block transition-opacity hover:opacity-70"
            style={{ color: primaryColor }}
          >
            + Add a class
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {classes.map((cls) => (
            <ClassPill key={cls.id} cls={cls} primaryColor={primaryColor} />
          ))}
        </div>
      )}
    </div>
  );
}

function ClassPill({
  cls,
  primaryColor,
  compact = false,
}: {
  cls: DayClass;
  primaryColor: string;
  compact?: boolean;
}) {
  const spotsLeft = cls.capacity != null ? cls.capacity - cls.enrolled : null;
  const almostFull = spotsLeft != null && spotsLeft <= 3;
  const full = spotsLeft != null && spotsLeft <= 0;

  if (compact) {
    return (
      <div
        className="rounded-lg p-1.5 text-[10px] leading-tight"
        style={{ background: hexToRgba(primaryColor, 0.08) }}
      >
        <p className="font-semibold text-white truncate">{cls.time} {cls.name}</p>
        <p className="text-gray-500 truncate">{cls.coach}</p>
        {spotsLeft != null && (
          <p style={{ color: full ? "#ef4444" : almostFull ? "#f59e0b" : "rgba(255,255,255,0.3)" }}>
            {full ? "Full" : `${spotsLeft} left`}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border p-4 flex items-center justify-between gap-4 group hover:border-opacity-60 transition-all cursor-pointer"
      style={{
        background: hexToRgba(primaryColor, 0.04),
        borderColor: hexToRgba(primaryColor, 0.15),
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className="w-1 self-stretch rounded-full flex-shrink-0"
          style={{ background: primaryColor }}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-white font-semibold text-sm">{cls.name}</span>
            {full && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400">
                FULL
              </span>
            )}
            {almostFull && !full && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400">
                ALMOST FULL
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <span className="flex items-center gap-1 text-gray-500 text-xs">
              <Clock className="w-3 h-3" />
              {cls.time}{cls.endTime ? ` – ${cls.endTime}` : ""}
            </span>
            <span className="flex items-center gap-1 text-gray-500 text-xs">
              <Users className="w-3 h-3" />
              {cls.coach}
            </span>
            {cls.location && (
              <span className="flex items-center gap-1 text-gray-500 text-xs">
                <MapPin className="w-3 h-3" />
                {cls.location}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-shrink-0">
        {spotsLeft != null && (
          <div className="text-right">
            <p
              className="text-xs font-semibold"
              style={{ color: full ? "#ef4444" : almostFull ? "#f59e0b" : "rgba(255,255,255,0.5)" }}
            >
              {full ? "Full" : `${spotsLeft} / ${cls.capacity}`}
            </p>
            <p className="text-gray-700 text-[10px]">spots</p>
          </div>
        )}
        <Link
          href={`/dashboard/checkin?class=${cls.id}`}
          className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-80"
          style={{ background: hexToRgba(primaryColor, 0.25) }}
          onClick={(e) => e.stopPropagation()}
        >
          <QrCode className="w-3 h-3" />
          Check in
        </Link>
      </div>
    </div>
  );
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}
