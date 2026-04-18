"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronLeft, ChevronRight, Bell, BellOff, X } from "lucide-react";

const PRIMARY = "#3b82f6";

// ─── Types ────────────────────────────────────────────────────────────────────

type ScheduleClass = {
  id: string;
  name: string;
  time: string;
  endTime: string;
  coach: string;
  location: string;
  capacity: number | null;
  dow: number; // 1=Mon…7=Sun internal convention
  classInstanceId?: string | null;
};

const INITIAL_SUBS = new Set(["m2", "f2", "s1"]);
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_FULL   = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const START_HOUR = 7;
const END_HOUR   = 22;
const HOUR_H     = 64;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function timeToMinutes(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function topPx(time: string) {
  return ((timeToMinutes(time) - START_HOUR * 60) / 60) * HOUR_H;
}

function heightPx(start: string, end: string) {
  return Math.max(((timeToMinutes(end) - timeToMinutes(start)) / 60) * HOUR_H, 28);
}

function getWeekDays(anchor: Date): Date[] {
  const day = anchor.getDay();
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() - ((day + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function fmt(d: Date) { return d.toISOString().split("T")[0]; }

// ─── Event detail sheet ───────────────────────────────────────────────────────

function EventSheet({
  cls,
  isSub,
  onToggle,
  onClose,
  primaryColor,
}: {
  cls: ScheduleClass;
  isSub: boolean;
  onToggle: () => void;
  onClose: () => void;
  primaryColor: string;
}) {
  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />
      <div
        className="fixed bottom-0 left-0 right-0 z-50 rounded-t-3xl"
        style={{ background: "var(--member-elevated)", borderTop: "1px solid var(--member-elevated-border)" }}
      >
        <div className="flex justify-center pt-3 mb-1">
          <div className="w-10 h-1 rounded-full bg-white/15" />
        </div>
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 rounded-full" style={{ background: primaryColor }} />
            <h2 className="text-white font-semibold text-base">{cls.name}</h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400"
            style={{ background: "var(--member-surface)" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl p-3" style={{ background: "var(--member-surface)" }}>
              <p className="text-gray-500 text-xs mb-1">Time</p>
              <p className="text-white text-sm font-semibold">{cls.time} – {cls.endTime}</p>
            </div>
            <div className="rounded-xl p-3" style={{ background: "var(--member-surface)" }}>
              <p className="text-gray-500 text-xs mb-1">Location</p>
              <p className="text-white text-sm font-semibold">{cls.location}</p>
            </div>
            <div className="rounded-xl p-3" style={{ background: "var(--member-surface)" }}>
              <p className="text-gray-500 text-xs mb-1">Coach</p>
              <p className="text-white text-sm font-semibold">{cls.coach}</p>
            </div>
            {cls.capacity && (
              <div className="rounded-xl p-3" style={{ background: "var(--member-surface)" }}>
                <p className="text-gray-500 text-xs mb-1">Capacity</p>
                <p className="text-white text-sm font-semibold">{cls.capacity} students</p>
              </div>
            )}
          </div>
          <button
            onClick={onToggle}
            className="w-full py-3.5 rounded-2xl flex items-center justify-center gap-2 font-semibold text-sm transition-all active:scale-[0.98]"
            style={{
              background: isSub ? hex(primaryColor, 0.12) : primaryColor,
              color: isSub ? primaryColor : "white",
              border: isSub ? `1px solid ${hex(primaryColor, 0.3)}` : "none",
            }}
          >
            {isSub
              ? <><BellOff className="w-4 h-4" />Unsubscribe</>
              : <><Bell className="w-4 h-4" />Subscribe to class</>
            }
          </button>
          {isSub && (
            <p className="text-gray-600 text-xs text-center">
              You&apos;ll get a reminder 1 hour before this class
            </p>
          )}
        </div>
        <div className="h-6" />
      </div>
    </>
  );
}

// ─── Day grid panel ───────────────────────────────────────────────────────────

function DayGrid({
  dow,
  primaryColor,
  subscribed,
  selected,
  onSelect,
  scrollRef,
  loading,
  allClasses,
}: {
  dow: number;
  primaryColor: string;
  subscribed: Set<string>;
  selected: string | null;
  onSelect: (id: string) => void;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  loading: boolean;
  allClasses: ScheduleClass[];
}) {
  const today = new Date();
  const todayDow = today.getDay() === 0 ? 7 : today.getDay();
  const showNow = dow === todayDow;
  const nowMinutes = today.getHours() * 60 + today.getMinutes();
  const nowTop = ((nowMinutes - START_HOUR * 60) / 60) * HOUR_H;
  const dayClasses = allClasses.filter((c) => c.dow === dow);

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto"
      // pan-y tells the browser vertical scroll is allowed here;
      // our non-passive horizontal handler overrides when needed
      style={{ scrollbarWidth: "none", touchAction: "pan-y" }}
    >
      <div className="relative ml-12" style={{ height: (END_HOUR - START_HOUR) * HOUR_H }}>
        {/* Hour lines + labels */}
        {Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => {
          const hour = START_HOUR + i;
          return (
            <div
              key={hour}
              className="absolute left-0 right-4 flex items-start"
              style={{ top: i * HOUR_H }}
            >
              <span
                className="absolute text-[10px] font-medium leading-none"
                style={{ left: -44, top: -6, color: "var(--member-text-dim)", width: 36, textAlign: "right" }}
              >
                {hour === 12 ? "12 PM" : hour > 12 ? `${hour - 12} PM` : `${hour} AM`}
              </span>
              <div className="w-full" style={{ height: 1, background: "var(--member-hr)" }} />
            </div>
          );
        })}

        {/* Now indicator */}
        {showNow && nowTop > 0 && nowTop < (END_HOUR - START_HOUR) * HOUR_H && (
          <div
            className="absolute left-0 right-4 flex items-center z-10 pointer-events-none"
            style={{ top: nowTop }}
          >
            <div className="w-2.5 h-2.5 rounded-full bg-red-500 -ml-1.5 shrink-0" />
            <div className="flex-1 h-0.5 bg-red-500" />
          </div>
        )}

        {/* Empty state */}
        {!loading && dayClasses.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-gray-700 text-sm">No classes today</p>
          </div>
        )}

        {/* Events */}
        {dayClasses.map((cls) => {
          const top    = topPx(cls.time);
          const height = heightPx(cls.time, cls.endTime);
          const isSub  = subscribed.has(cls.id);
          const isSel  = selected === cls.id;
          const short  = height < 44;

          return (
            <button
              key={cls.id}
              onClick={() => onSelect(cls.id)}
              className="absolute left-1 right-4 rounded-xl px-2 py-1.5 text-left transition-all active:scale-[0.98] overflow-hidden"
              style={{
                top,
                height,
                background: isSub ? primaryColor : hex(primaryColor, 0.18),
                border: `1px solid ${isSub ? "transparent" : hex(primaryColor, 0.3)}`,
                boxShadow: isSel ? "0 0 0 2px white" : undefined,
              }}
            >
              <p className="text-white font-semibold leading-tight truncate" style={{ fontSize: short ? 10 : 12 }}>
                {cls.name}
              </p>
              {!short && (
                <p className="text-white/60 leading-tight truncate mt-0.5" style={{ fontSize: 10 }}>
                  {cls.time} · {cls.coach}
                </p>
              )}
              {isSub && !short && (
                <Bell className="absolute bottom-1.5 right-1.5 w-2.5 h-2.5 text-white/50" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MemberSchedulePage() {
  const today = new Date();
  const [anchor, setAnchor] = useState(today);
  const [selectedDay, setSelectedDay] = useState(today.getDay() === 0 ? 6 : today.getDay() - 1);
  const [subscribed, setSubscribed] = useState<Set<string>>(INITIAL_SUBS);
  const [selected, setSelected] = useState<string | null>(null);
  const [allClasses, setAllClasses] = useState<ScheduleClass[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(true);

  const outerRef    = useRef<HTMLDivElement>(null); // overflow-hidden viewport
  const stripRef    = useRef<HTMLDivElement>(null); // 3-panel strip
  const centerRef   = useRef<HTMLDivElement>(null); // center panel scroll container
  const dayScrollRef = useRef<HTMLDivElement>(null);

  // Stable refs so event handlers never go stale
  const selectedDayRef = useRef(selectedDay);
  const anchorRef      = useRef(anchor);
  selectedDayRef.current = selectedDay;
  anchorRef.current      = anchor;

  const weekDays    = getWeekDays(anchor);
  const primaryColor = PRIMARY;

  // Prev/curr/next DOW (1-indexed: 1=Mon…7=Sun)
  const currDow = selectedDay + 1;
  const prevDow = selectedDay === 0 ? 7 : selectedDay;
  const nextDow = selectedDay === 6 ? 1 : selectedDay + 2;

  // Navigation — always read from refs so touch handlers are never stale
  const navigateRef = useRef<(dir: "next" | "prev") => void>(() => {});
  navigateRef.current = (dir) => {
    const day = selectedDayRef.current;
    const anc = anchorRef.current;
    if (dir === "next") {
      if (day < 6) setSelectedDay(day + 1);
      else { const d = new Date(anc); d.setDate(d.getDate() + 7); setAnchor(d); setSelectedDay(0); }
    } else {
      if (day > 0) setSelectedDay(day - 1);
      else { const d = new Date(anc); d.setDate(d.getDate() - 7); setAnchor(d); setSelectedDay(6); }
    }
  };

  // Scroll center panel to current time whenever day changes
  useEffect(() => {
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    const scrollTop = Math.max(0, ((nowMinutes - START_HOUR * 60) / 60) * HOUR_H - 100);
    centerRef.current?.scrollTo({ top: scrollTop });
  }, [selectedDay]);

  // Scroll day pills to keep selected visible
  useEffect(() => {
    const el = dayScrollRef.current?.children[selectedDay] as HTMLElement;
    el?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [selectedDay]);

  // ── Swipe gesture ─────────────────────────────────────────────────────────
  useEffect(() => {
    const outer = outerRef.current;
    const strip = stripRef.current;
    if (!outer || !strip) return;

    let startX = 0, startY = 0, decided = false, isH = false;

    const W = () => outer.offsetWidth;

    const onStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      decided = false;
      isH = false;
      strip.style.transition = "none";
    };

    const onMove = (e: TouchEvent) => {
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;

      if (!decided && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        decided = true;
        isH = Math.abs(dx) > Math.abs(dy) * 0.8; // bias toward horizontal
      }

      if (isH) {
        e.preventDefault();
        // Content follows finger — calc(-33.333%) keeps strip centered,
        // dx offsets it in real-time with the finger position
        strip.style.transform = `translateX(calc(-33.333% + ${dx}px))`;
      }
    };

    const onEnd = (e: TouchEvent) => {
      if (!isH) return;
      const dx = e.changedTouches[0].clientX - startX;
      const threshold = W() * 0.12; // 12% of screen width to commit

      if (Math.abs(dx) > threshold) {
        // Commit — snap to adjacent panel
        strip.style.transition = "transform 280ms cubic-bezier(0.25, 0.46, 0.45, 0.94)";
        strip.style.transform = dx < 0 ? "translateX(-66.666%)" : "translateX(0%)";

        setTimeout(() => {
          navigateRef.current(dx < 0 ? "next" : "prev");
          // Reset strip silently — state change re-renders panels in new positions
          strip.style.transition = "none";
          strip.style.transform = "translateX(-33.333%)";
        }, 280);
      } else {
        // Not enough — spring back with overshoot feel
        strip.style.transition = "transform 420ms cubic-bezier(0.34, 1.56, 0.64, 1)";
        strip.style.transform = "translateX(-33.333%)";
      }
    };

    outer.addEventListener("touchstart", onStart, { passive: true });
    outer.addEventListener("touchmove",  onMove,  { passive: false });
    outer.addEventListener("touchend",   onEnd,   { passive: true });

    return () => {
      outer.removeEventListener("touchstart", onStart);
      outer.removeEventListener("touchmove",  onMove);
      outer.removeEventListener("touchend",   onEnd);
    };
  }, []);

  useEffect(() => {
    fetch("/api/member/schedule")
      .then((r) => r.ok ? r.json() : [])
      .then((data: Array<{
        id: string; name: string; startTime: string; endTime: string;
        coach: string; location: string; capacity: number | null;
        dayOfWeek: number; classInstanceId?: string | null;
      }>) => {
        const mapped: ScheduleClass[] = (Array.isArray(data) ? data : []).map((c) => ({
          id: c.id,
          name: c.name,
          time: c.startTime,
          endTime: c.endTime,
          coach: c.coach,
          location: c.location,
          capacity: c.capacity,
          // API: 0=Sun…6=Sat (JS getDay). Internal: 1=Mon…7=Sun.
          dow: c.dayOfWeek === 0 ? 7 : c.dayOfWeek,
          classInstanceId: c.classInstanceId ?? null,
        }));
        setAllClasses(mapped);
      })
      .catch(() => setAllClasses([]))
      .finally(() => setScheduleLoading(false));
  }, []);

  const toggle = (id: string) =>
    setSubscribed((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const weekStart = weekDays[0];
  const weekEnd   = weekDays[6];
  const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
  const weekLabel = sameMonth
    ? `${weekStart.toLocaleDateString("en-GB", { day: "numeric" })}–${weekEnd.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`
    : `${weekStart.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${weekEnd.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;

  const selectedCls = allClasses.find((c) => c.id === selected);

  return (
    <div className="flex flex-col h-[calc(100vh-56px-64px)]">

      {/* ── Top controls ── */}
      <div className="px-4 pt-4 pb-2 shrink-0">
        {/* Week nav */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1">
            <button
              onClick={() => { const d = new Date(anchor); d.setDate(d.getDate() - 7); setAnchor(d); }}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 hover:text-white transition-all"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => { const d = new Date(anchor); d.setDate(d.getDate() + 7); setAnchor(d); }}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 hover:text-white transition-all"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <span className="text-white text-sm font-medium ml-1">{weekLabel}</span>
          </div>
          <button
            onClick={() => { setAnchor(today); setSelectedDay(today.getDay() === 0 ? 6 : today.getDay() - 1); }}
            className="text-xs font-medium px-2.5 py-1.5 rounded-lg border border-white/10 text-gray-400 hover:text-white transition-all"
          >
            Today
          </button>
        </div>

        {/* Day pills */}
        <div ref={dayScrollRef} className="flex gap-1.5 overflow-x-auto pb-2 scrollbar-hide">
          {weekDays.map((day, i) => {
            const isToday = fmt(day) === fmt(today);
            const isSel   = selectedDay === i;
            const count   = allClasses.filter((c) => c.dow === i + 1).length;
            return (
              <button
                key={i}
                onClick={() => setSelectedDay(i)}
                className="flex flex-col items-center gap-0.5 py-2 px-2.5 rounded-2xl shrink-0 transition-all min-w-[46px]"
                style={{
                  background: isSel ? primaryColor : isToday ? hex(primaryColor, 0.1) : "var(--member-surface)",
                  border: `1.5px solid ${isSel ? primaryColor : isToday ? hex(primaryColor, 0.3) : "var(--member-border)"}`,
                }}
              >
                <span
                  className="text-[9px] font-bold uppercase tracking-wider"
                  style={{ color: isSel ? "rgba(255,255,255,0.7)" : "var(--member-inactive)" }}
                >
                  {DAY_LABELS[i]}
                </span>
                <span
                  className="text-base font-bold leading-none"
                  style={{ color: isSel ? "white" : isToday ? primaryColor : "var(--member-text)" }}
                >
                  {day.getDate()}
                </span>
                <span
                  className="w-1 h-1 rounded-full"
                  style={{ background: count > 0 ? (isSel ? "rgba(255,255,255,0.6)" : primaryColor) : "transparent" }}
                />
              </button>
            );
          })}
        </div>

        {/* Day label */}
        <p className="text-gray-400 text-xs font-medium mt-2 mb-1 px-1">{DAY_FULL[selectedDay]}</p>
      </div>

      {/* ── Swipeable pager ── */}
      {/* outerRef clips the strip; touchmove listener lives here */}
      <div ref={outerRef} className="flex-1 overflow-hidden relative">
        {/* Strip: 3 panels side by side, centered on the current day */}
        <div
          ref={stripRef}
          className="flex h-full"
          style={{ width: "300%", transform: "translateX(-33.333%)" }}
        >
          {/* Previous day */}
          <div className="overflow-hidden h-full shrink-0" style={{ width: "33.333%" }}>
            <DayGrid
              dow={prevDow}
              primaryColor={primaryColor}
              subscribed={subscribed}
              selected={selected}
              onSelect={setSelected}
              loading={scheduleLoading}
              allClasses={allClasses}
            />
          </div>

          {/* Current day */}
          <div className="overflow-hidden h-full shrink-0" style={{ width: "33.333%" }}>
            <DayGrid
              dow={currDow}
              primaryColor={primaryColor}
              subscribed={subscribed}
              selected={selected}
              onSelect={setSelected}
              scrollRef={centerRef}
              loading={scheduleLoading}
              allClasses={allClasses}
            />
          </div>

          {/* Next day */}
          <div className="overflow-hidden h-full shrink-0" style={{ width: "33.333%" }}>
            <DayGrid
              dow={nextDow}
              primaryColor={primaryColor}
              subscribed={subscribed}
              selected={selected}
              onSelect={setSelected}
              loading={scheduleLoading}
              allClasses={allClasses}
            />
          </div>
        </div>
      </div>

      {/* Event detail sheet */}
      {selectedCls && (
        <EventSheet
          cls={selectedCls}
          isSub={subscribed.has(selectedCls.id)}
          onToggle={() => toggle(selectedCls.id)}
          onClose={() => setSelected(null)}
          primaryColor={primaryColor}
        />
      )}
    </div>
  );
}
