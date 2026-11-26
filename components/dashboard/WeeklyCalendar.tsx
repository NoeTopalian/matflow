"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronLeft, ChevronRight, Users, Clock, MapPin, QrCode } from "lucide-react";
import Link from "next/link";
import { capacityLabel } from "@/lib/capacity-label";

export interface DayClass {
  id: string;
  name: string;
  time: string;       // "09:00"
  endTime?: string;   // "10:00"
  /** The class's coach (the linked staff coach, else the typed name); null when it has none. */
  coach: string | null;
  capacity: number | null;
  enrolled: number;
  location?: string;
  date: string;       // "2026-03-07"
}

/** What a class with no coach shows on the staff dashboard: a fact, said quietly, never a warning. */
export const NO_COACH = "No coach assigned";
export const coachLabel = (coach: string | null) => coach ?? NO_COACH;

interface Props {
  classes: DayClass[];
  primaryColor: string;
  /** Staff role — gates the per-class check-in shortcut (audit R6). */
  role?: string;
  /**
   * Today in the club's zone ("YYYY-MM-DD"), from the server (Round 3, 10 Nov
   * 2026). The sessions are the club's week, so "today" must be the club's
   * day too, not the browser's or UTC's. Days are held as UTC noon of their
   * key and read with UTC getters, so no browser zone can shift them.
   */
  todayKey?: string;
}

function getWeekDays(anchor: Date): Date[] {
  const day = anchor.getUTCDay(); // 0 = Sun
  const monday = new Date(anchor);
  monday.setUTCDate(anchor.getUTCDate() - ((day + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
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

export default function WeeklyCalendar({ classes, primaryColor, role, todayKey }: Props) {
  const today = new Date(`${todayKey ?? new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  const [anchor, setAnchor] = useState(today);
  const [selectedDate, setSelectedDate] = useState(fmt(today));
  const weekDays = getWeekDays(anchor);
  const dayScrollRef = useRef<HTMLDivElement>(null);

  // Centre the selected day pill within the strip on mobile. Only the strip scrolls: scrollIntoView also scrolled the
  // page down to the strip, so on a phone the dashboard opened at the bottom, past its to-do tiles (audit F1).
  useEffect(() => {
    const idx = weekDays.findIndex((d) => fmt(d) === selectedDate);
    const strip = dayScrollRef.current;
    const pill = idx >= 0 ? (strip?.children[idx] as HTMLElement | undefined) : undefined;
    if (!strip || !pill) return;
    const left = strip.scrollLeft + pill.getBoundingClientRect().left - strip.getBoundingClientRect().left - (strip.clientWidth - pill.offsetWidth) / 2;
    strip.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [selectedDate]);

  function prevWeek() {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() - 7);
    setAnchor(d);
    setSelectedDate(fmt(d));
  }
  function nextWeek() {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() + 7);
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
  const sameMonth = weekStart.getUTCMonth() === weekEnd.getUTCMonth();
  const weekLabel = sameMonth
    ? `${weekStart.toLocaleDateString("en-GB", { day: "numeric", timeZone: "UTC" })}–${weekEnd.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`
    : `${weekStart.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} – ${weekEnd.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`;

  return (
    <>

      {/* Week navigation */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-1">
          <button
            onClick={prevWeek}
            aria-label="Previous week"
            className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-sf-2 transition-all"
            style={{ color: "var(--tx-3)" }}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={nextWeek}
            aria-label="Next week"
            className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-sf-2 transition-all"
            style={{ color: "var(--tx-3)" }}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <span className="text-sm font-medium ml-1" style={{ color: "var(--tx-1)" }}>{weekLabel}</span>
        </div>
        <button
          onClick={goToday}
          className="text-xs font-medium px-3 py-1.5 rounded-lg border hover:border-bd-hover transition-all"
          style={{ borderColor: "var(--bd-default)", color: "var(--tx-3)" }}
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
                background: isSel ? hexToRgba(primaryColor, 0.06) : "var(--sf-1)",
                borderColor: isSel ? hexToRgba(primaryColor, 0.35) : "var(--bd-default)",
              }}
            >
              {/* Day header */}
              <div className="p-2.5 pb-2 border-b" style={{ borderColor: "var(--bd-default)" }}>
                <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--tx-3)" }}>
                  {DAY_LABELS[i]}
                </p>
                <div className="mt-0.5">
                  <span
                    className="text-lg font-bold leading-none block"
                    style={{ color: isTod ? primaryColor : "var(--tx-1)" }}
                  >
                    {day.getUTCDate()}
                  </span>
                  {isTod && (
                    <span
                      className="text-[9px] font-bold px-1.5 py-0.5 rounded-full mt-1 inline-block"
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
                  <p className="text-[10px] text-center py-3" style={{ color: "var(--tx-4)" }}>—</p>
                ) : (
                  dayClasses.map((cls) => (
                    <ClassPill key={cls.id} cls={cls} primaryColor={primaryColor} role={role} compact />
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
                  background: isSel ? primaryColor : isTod ? hexToRgba(primaryColor, 0.1) : "var(--sf-1)",
                  border: `1.5px solid ${isSel ? primaryColor : isTod ? hexToRgba(primaryColor, 0.3) : "var(--bd-default)"}`,
                  minWidth: 52,
                }}
              >
                <span
                  className="text-[10px] font-semibold uppercase tracking-wider"
                  // §2a: selected day is filled with the tenant accent, so its
                  // label colour is derived, not assumed white.
                  style={{ color: isSel ? "var(--tx-on-accent)" : "var(--tx-3)" }}
                >
                  {DAY_LABELS[i]}
                </span>
                <span
                  className="text-lg font-bold leading-none"
                  style={{ color: isSel ? "var(--tx-on-accent)" : isTod ? primaryColor : "var(--tx-1)" }}
                >
                  {day.getUTCDate()}
                </span>
                {count > 0 && (
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: isSel ? "var(--tx-on-accent)" : primaryColor }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected day detail — shown on mobile always, on desktop as bottom panel */}
      <div className="md:hidden">
        <SelectedDayPanel role={role}
          day={weekDays.find((d) => fmt(d) === selectedDate) ?? weekDays[0]}
          dayIdx={weekDays.findIndex((d) => fmt(d) === selectedDate)}
          classes={selectedClasses}
          primaryColor={primaryColor}
        />
      </div>

      {/* Desktop: selected day detail below grid */}
      <div className="hidden md:block">
        <SelectedDayPanel role={role}
          day={weekDays.find((d) => fmt(d) === selectedDate) ?? weekDays[0]}
          dayIdx={weekDays.findIndex((d) => fmt(d) === selectedDate)}
          classes={selectedClasses}
          primaryColor={primaryColor}
        />
      </div>
    </>
  );
}

function SelectedDayPanel({
  day,
  dayIdx,
  classes,
  primaryColor,
  role,
}: {
  day: Date;
  dayIdx: number;
  classes: DayClass[];
  primaryColor: string;
  role?: string;
}) {
  const dateLabel = day.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>{dateLabel}</h3>
        <span className="text-xs" style={{ color: "var(--tx-3)" }}>{classes.length} class{classes.length !== 1 ? "es" : ""}</span>
      </div>

      {classes.length === 0 ? (
        <div
          className="rounded-xl border py-10 text-center"
          style={{ borderColor: "var(--bd-default)", background: "var(--sf-1)" }}
        >
          <p className="text-sm" style={{ color: "var(--tx-3)" }}>No classes scheduled</p>
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
            <ClassPill key={cls.id} cls={cls} primaryColor={primaryColor} role={role} />
          ))}
        </div>
      )}
    </div>
  );
}

function ClassPill({
  cls,
  primaryColor,
  role,
  compact = false,
}: {
  cls: DayClass;
  primaryColor: string;
  role?: string;
  compact?: boolean;
}) {
  // Follows places taken, not capacity alone (lib/capacity-label.ts).
  const cap = capacityLabel(cls.capacity, cls.enrolled);
  const capColor = (muted: string) =>
    cap?.tone === "danger" ? "#ef4444" : cap?.tone === "warning" ? "#f59e0b" : muted;

  if (compact) {
    return (
      <div
        className="rounded-lg p-1.5 text-[10px] leading-tight"
        style={{ background: hexToRgba(primaryColor, 0.08) }}
      >
        <p className="font-semibold truncate" style={{ color: "var(--tx-1)" }}>{cls.time} {cls.name}</p>
        <p className="truncate" style={{ color: "var(--tx-3)" }}>{coachLabel(cls.coach)}</p>
        {cap && (
          <p style={{ color: capColor("var(--tx-4)") }}>
            {cap.short}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border p-4 flex items-center justify-between gap-4 group hover:border-opacity-60 transition-all"
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
            <span className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>{cls.name}</span>
            {cap?.badge && (
              <span
                className={
                  cap.tone === "danger"
                    ? "text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/15 text-[var(--hue-danger-ink)]"
                    : "text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/10 text-[var(--hue-warning-ink)]"
                }
              >
                {cap.badge}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <span className="flex items-center gap-1 text-xs" style={{ color: "var(--tx-3)" }}>
              <Clock className="w-3 h-3" />
              {cls.time}{cls.endTime ? ` – ${cls.endTime}` : ""}
            </span>
            <span className="flex items-center gap-1 text-xs" style={{ color: "var(--tx-3)" }}>
              <Users className="w-3 h-3" />
              {coachLabel(cls.coach)}
            </span>
            {cls.location && (
              <span className="flex items-center gap-1 text-xs" style={{ color: "var(--tx-3)" }}>
                <MapPin className="w-3 h-3" />
                {cls.location}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-shrink-0">
        {cap && (
          <div className="text-right">
            <p
              className="text-xs font-semibold"
              style={{ color: capColor("var(--tx-3)") }}
            >
              {cap.primary}
            </p>
            <p className="text-[10px]" style={{ color: "var(--tx-4)" }}>{cap.secondary}</p>
          </div>
        )}
        {["owner", "manager", "admin"].includes(role ?? "") && (
        <Link
          href={`/dashboard/checkin?class=${cls.id}`}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-80"
          style={{ background: hexToRgba(primaryColor, 0.25) }}
          onClick={(e) => e.stopPropagation()}
        >
          <QrCode className="w-3 h-3" />
          Check in
        </Link>
        )}
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
