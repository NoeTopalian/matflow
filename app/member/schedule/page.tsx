"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronLeft, ChevronRight, Bell, BellOff, X } from "lucide-react";
import { useSwipeToDismiss } from "@/lib/useSwipeToDismiss";
import { useToast } from "@/components/ui/Toast";
import { ErrorState } from "@/components/ui/ErrorState";

const PRIMARY = "#3b82f6";

// ─── Types ────────────────────────────────────────────────────────────────────

type ScheduleClass = {
  /**
   * GRID-ROW id: `${classId}-${scheduleId}`. One Class produces one row per
   * ClassSchedule, so this is what selection and React keys must use — it is
   * NOT a Class id and must never be sent to an API expecting one.
   */
  id: string;
  /** The real Class id. Everything subscription-related keys off THIS. */
  classId: string;
  name: string;
  time: string;
  endTime: string;
  coach: string;
  location: string;
  capacity: number | null;
  color?: string | null;
  dow: number; // 1=Mon…7=Sun internal convention
  classInstanceId?: string | null;
  // Task 14: server-side eligibility flag (rank-based) + roster status.
  // "rank_below" / "rank_above" → shown with lock badge + disabled subscribe.
  // "roster_ok" → "Comp team" tag. "ok" → normal. Roster-only classes the
  // member is NOT on are filtered out at the API layer (api/member/schedule).
  eligibility?: "ok" | "rank_below" | "rank_above" | "roster_ok";
  requiredRankName?: string | null;
  maxRankName?: string | null;
};

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_FULL   = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const HOUR_H = 64;

// Active-hours clamp: instead of fixed 07:00–22:00 rails, the day grid spans
// min(class start)−1h → max(class end)+1h across the week's classes, clamped
// inside 06:00–23:00, never narrower than 8 hours. A week with no classes
// falls back to 09:00–21:00.
const CLAMP_START    = 6;
const CLAMP_END      = 23;
const MIN_WINDOW     = 8;
const FALLBACK_START = 9;
const FALLBACK_END   = 21;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeHex(value: string | null | undefined) {
  let hexValue = value?.trim() || PRIMARY;
  if (!hexValue.startsWith("#")) hexValue = `#${hexValue}`;
  if (/^#[0-9a-f]{3}$/i.test(hexValue)) {
    hexValue = `#${hexValue.slice(1).split("").map((char) => char + char).join("")}`;
  }
  return /^#[0-9a-f]{6}$/i.test(hexValue) ? hexValue : PRIMARY;
}

function hex(h: string, a: number) {
  const value = normalizeHex(h);
  const n = parseInt(value.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function readableText(color: string) {
  const value = normalizeHex(color);
  const n = parseInt(value.replace("#", ""), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const luma = (r * 299 + g * 587 + b * 114) / 1000;
  return luma > 155 ? "#0f172a" : "#ffffff";
}

function timeToMinutes(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function topPx(time: string, startHour: number) {
  return ((timeToMinutes(time) - startHour * 60) / 60) * HOUR_H;
}

function hourWindow(classes: ScheduleClass[]): { startHour: number; endHour: number } {
  if (classes.length === 0) return { startHour: FALLBACK_START, endHour: FALLBACK_END };
  const minStart = Math.min(...classes.map((c) => timeToMinutes(c.time)));
  const maxEnd   = Math.max(...classes.map((c) => timeToMinutes(c.endTime)));
  let start = Math.max(CLAMP_START, Math.floor(minStart / 60) - 1);
  let end   = Math.min(CLAMP_END,   Math.ceil(maxEnd / 60) + 1);
  // Widen to the minimum window without leaving the clamp.
  while (end - start < MIN_WINDOW) {
    if (end < CLAMP_END) end++;
    else if (start > CLAMP_START) start--;
    else break;
  }
  return { startHour: start, endHour: end };
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
  const { handleProps, sheetStyle } = useSwipeToDismiss(onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      style={{ paddingBottom: "var(--member-nav-clearance)" }}
    >
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <div
        className="relative rounded-t-3xl"
        style={{
          background: "var(--member-elevated)",
          borderTop: "1px solid var(--member-elevated-border)",
          maxHeight: "calc(100dvh - var(--member-nav-clearance))",
          ...sheetStyle,
        }}
      >
        <div className="flex justify-center pt-3 pb-2" {...handleProps}>
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
          {/* Task 14: eligibility chip — visible above the subscribe button when not "ok". */}
          {cls.eligibility === "rank_below" && (
            <div className="rounded-xl px-3 py-2 text-xs flex items-center gap-2"
              style={{ background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.25)", color: "#fbbf24" }}>
              🔒 {cls.requiredRankName ? `${cls.requiredRankName} and above` : "Higher rank required"} — ask your coach about promotion.
            </div>
          )}
          {cls.eligibility === "rank_above" && (
            <div className="rounded-xl px-3 py-2 text-xs flex items-center gap-2"
              style={{ background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.25)", color: "#fbbf24" }}>
              🔒 {cls.maxRankName ? `${cls.maxRankName} and below only` : "Lower rank required"}.
            </div>
          )}
          {cls.eligibility === "roster_ok" && (
            <div className="rounded-xl px-3 py-2 text-xs flex items-center gap-2"
              style={{ background: "rgba(168,85,247,0.10)", border: "1px solid rgba(168,85,247,0.25)", color: "#c084fc" }}>
              🏆 Comp team — invite-only class
            </div>
          )}

          <button
            onClick={onToggle}
            disabled={cls.eligibility === "rank_below" || cls.eligibility === "rank_above"}
            className="w-full py-3.5 rounded-2xl flex items-center justify-center gap-2 font-semibold text-sm transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
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
              Subscribed classes appear on your home screen
            </p>
          )}
        </div>
        <div className="h-6" />
      </div>
    </div>
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
  startHour,
  endHour,
}: {
  dow: number;
  primaryColor: string;
  subscribed: Set<string>;
  selected: string | null;
  onSelect: (id: string) => void;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  loading: boolean;
  allClasses: ScheduleClass[];
  startHour: number;
  endHour: number;
}) {
  const today = new Date();
  const todayDow = today.getDay() === 0 ? 7 : today.getDay();
  const showNow = dow === todayDow;
  const nowMinutes = today.getHours() * 60 + today.getMinutes();
  const nowTop = ((nowMinutes - startHour * 60) / 60) * HOUR_H;
  const dayClasses = allClasses.filter((c) => c.dow === dow);

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto"
      // pan-y tells the browser vertical scroll is allowed here;
      // our non-passive horizontal handler overrides when needed
      style={{ scrollbarWidth: "none", touchAction: "pan-y" }}
    >
      <div className="relative ml-12" style={{ height: (endHour - startHour) * HOUR_H }}>
        {/* Hour lines + labels */}
        {Array.from({ length: endHour - startHour + 1 }, (_, i) => {
          const hour = startHour + i;
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
        {showNow && nowTop > 0 && nowTop < (endHour - startHour) * HOUR_H && (
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
          const top    = topPx(cls.time, startHour);
          const height = heightPx(cls.time, cls.endTime);
          const isSub  = subscribed.has(cls.classId);
          const isSel  = selected === cls.id;
          const short  = height < 44;
          const color  = normalizeHex(cls.color ?? primaryColor);
          const text   = readableText(color);
          const muted  = text === "#ffffff" ? "rgba(255,255,255,0.74)" : "rgba(15,23,42,0.68)";

          return (
            <button
              key={cls.id}
              onClick={() => onSelect(cls.id)}
              className="absolute left-1 right-4 rounded-xl px-2 py-1.5 text-left transition-all active:scale-[0.98] overflow-hidden"
              style={{
                top,
                height,
                background: isSub
                  ? `linear-gradient(135deg, ${color}, ${hex(color, 0.82)})`
                  : `linear-gradient(135deg, ${hex(color, 0.32)}, ${hex(color, 0.2)})`,
                border: `1px solid ${isSub ? hex(color, 0.9) : hex(color, 0.58)}`,
                boxShadow: isSel ? `0 0 0 2px var(--member-elevated), 0 0 0 4px ${hex(color, 0.75)}` : undefined,
              }}
            >
              <p className="font-semibold leading-tight truncate" style={{ color: isSub ? text : "#0f172a", fontSize: short ? 10 : 12 }}>
                {cls.name}
              </p>
              {!short && (
                <p className="leading-tight truncate mt-0.5" style={{ color: isSub ? muted : "rgba(15,23,42,0.68)", fontSize: 10 }}>
                  {cls.time} · {cls.coach}
                </p>
              )}
              {isSub && !short && (
                <Bell className="absolute bottom-1.5 right-1.5 w-2.5 h-2.5" style={{ color: muted }} />
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
  const [subscribed, setSubscribed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [allClasses, setAllClasses] = useState<ScheduleClass[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  // UI-RULES §7: a failed load is an error, never "No classes today".
  const [loadError, setLoadError] = useState<string | null>(null);

  const outerRef    = useRef<HTMLDivElement>(null); // overflow-hidden viewport
  const stripRef    = useRef<HTMLDivElement>(null); // 3-panel strip
  const centerRef   = useRef<HTMLDivElement>(null); // center panel scroll container
  const dayScrollRef = useRef<HTMLDivElement>(null);

  // Stable refs so event handlers never go stale
  const selectedDayRef = useRef(selectedDay);
  const anchorRef      = useRef(anchor);

  const weekDays    = getWeekDays(anchor);
  // Audit iter-1-member-surface A5H-3: read tenant brand primaryColor from
  // localStorage (same pattern as app/member/shop/page.tsx:31-36). The
  // previous hardcoded `PRIMARY` ignored tenant branding entirely.
  const [primaryColor, setPrimaryColor] = useState(PRIMARY);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("gym-settings");
      if (raw) {
        const settings = JSON.parse(raw) as { primaryColor?: string };
        if (settings.primaryColor && /^#[0-9a-f]{6}$/i.test(settings.primaryColor)) {
          setPrimaryColor(settings.primaryColor);
        }
      }
    } catch { /* localStorage unavailable in SSR / private mode — fall back to default */ }
  }, []);

  // Active-hours window for the week (recomputed when the schedule loads)
  const { startHour, endHour } = hourWindow(allClasses);

  // Prev/curr/next DOW (1-indexed: 1=Mon…7=Sun)
  const currDow = selectedDay + 1;
  const prevDow = selectedDay === 0 ? 7 : selectedDay;
  const nextDow = selectedDay === 6 ? 1 : selectedDay + 2;

  // Navigation — always read from refs so touch handlers are never stale
  const navigateRef = useRef<(dir: "next" | "prev") => void>(() => {});
  useEffect(() => {
    selectedDayRef.current = selectedDay;
    anchorRef.current = anchor;
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
  }, [selectedDay, anchor]);

  // Scroll center panel to current time whenever the day (or the computed
  // hour window, once classes load) changes
  useEffect(() => {
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    const scrollTop = Math.max(0, ((nowMinutes - startHour * 60) / 60) * HOUR_H - 100);
    centerRef.current?.scrollTo({ top: scrollTop });
  }, [selectedDay, startHour]);

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
    // Depends on loadError: the error state unmounts the strip, so the
    // listeners must re-bind against the fresh node after a successful retry.
  }, [loadError]);

  // UI-RULES §7, the case the rule names by name. This page used to do
  // `r.ok ? r.json() : []` and `.catch(() => setAllClasses([]))`, so a 500, a
  // 401 and an offline phone all arrived at the grid's "No classes today".
  // The subscriptions fetch was worse: `r.ok ? r.json() : { classIds: [] }`
  // dropped the member's real subscriptions, every class rendered
  // un-subscribed, and tapping subscribe POSTed a duplicate.
  //
  // Both loads now throw on a non-ok response and share one error state, so a
  // failure of EITHER replaces the grid with ErrorState + retry. That is
  // deliberate: a schedule rendered without subscription state is not a
  // partial view, it is a wrong one — and you cannot double-subscribe on a
  // grid that is not there.
  function loadSchedule() {
    setLoadError(null);
    setScheduleLoading(true);

    const classes = fetch("/api/member/schedule")
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      // This hand-written shape is WHY the classId bug survived review: it
      // omitted classId, so dropping it in the mapping below was invisible to
      // the type checker. Keep it in step with app/api/member/schedule/route.ts.
      .then((data: Array<{
        id: string; classId: string; name: string; startTime: string; endTime: string;
        coach: string; location: string; capacity: number | null; color?: string | null;
        eligibility?: "ok" | "rank_below" | "rank_above" | "roster_ok";
        requiredRankName?: string | null; maxRankName?: string | null;
        dayOfWeek: number; classInstanceId?: string | null;
      }>) => {
        const mapped: ScheduleClass[] = (Array.isArray(data) ? data : []).map((c) => ({
          id: c.id,
          // The API returns BOTH a composite grid id and the real classId. This
          // mapping used to drop classId, so every subscribe POSTed the
          // composite "<classId>-<scheduleId>" to
          // /api/member/class-subscriptions/[classId], which resolved no Class
          // and 404'd — subscribing from this page could never succeed. DELETE
          // was worse: deleteMany matched nothing and still returned 200, so
          // unsubscribing appeared to work. And the subscribed set (real class
          // ids) was compared against composites, so even a subscription that
          // did exist always rendered as un-subscribed.
          classId: c.classId,
          name: c.name,
          time: c.startTime,
          endTime: c.endTime,
          coach: c.coach,
          location: c.location,
          capacity: c.capacity,
          color: c.color ?? null,
          // API: 0=Sun…6=Sat (JS getDay). Internal: 1=Mon…7=Sun.
          dow: c.dayOfWeek === 0 ? 7 : c.dayOfWeek,
          classInstanceId: c.classInstanceId ?? null,
          // Also dropped: without these the rank-lock badge and the disabled
          // state on the subscribe button were unreachable code.
          eligibility: c.eligibility,
          requiredRankName: c.requiredRankName ?? null,
          maxRankName: c.maxRankName ?? null,
        }));
        setAllClasses(mapped);
      });

    // Hydrate the subscribed set from the server so reload preserves state.
    const subs = fetch("/api/member/me/subscriptions")
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: { classIds?: string[] }) => {
        setSubscribed(new Set(data.classIds ?? []));
      });

    // Raw exception text never reaches the member (UI-RULES §7/§10).
    Promise.all([classes, subs])
      .catch(() => setLoadError("Couldn't load your timetable — tap to retry"))
      .finally(() => setScheduleLoading(false));
  }

  useEffect(() => {
    let cancelled = false;
    // Deferred off the synchronous effect body: loadSchedule resets loadError
    // and scheduleLoading, and setting state synchronously inside an effect
    // cascades a second render pass on every mount
    // (react-hooks/set-state-in-effect). Initial state is already
    // "loading, no error", so nothing is lost.
    queueMicrotask(() => { if (!cancelled) loadSchedule(); });
    return () => { cancelled = true; };
  }, []);

  const { toast } = useToast();

  // Optimistic toggle: flip the set immediately, fire the API call, roll back on failure.
  const toggle = async (classId: string) => {
    const id = classId; // the Class id — never the composite grid-row id
    const wasSubscribed = subscribed.has(id);
    setSubscribed((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
    try {
      const res = await fetch(`/api/member/class-subscriptions/${id}`, {
        method: wasSubscribed ? "DELETE" : "POST",
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch {
      // Audit D8: roll back AND tell the member — previously the button
      // flipped back with no feedback at all.
      setSubscribed((prev) => {
        const n = new Set(prev);
        if (wasSubscribed) n.add(id);
        else n.delete(id);
        return n;
      });
      toast(
        wasSubscribed
          ? "Couldn't unsubscribe — please try again."
          : "Couldn't subscribe to this class — it may be invite-only.",
        "error",
      );
    }
  };

  const weekStart = weekDays[0];
  const weekEnd   = weekDays[6];
  const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
  const weekLabel = sameMonth
    ? `${weekStart.toLocaleDateString("en-GB", { day: "numeric" })}–${weekEnd.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`
    : `${weekStart.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${weekEnd.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;

  const selectedCls = allClasses.find((c) => c.id === selected);

  return (
    // Audit U5: height derived from the real header + nav tokens — the old
    // h-[calc(100dvh-56px-64px)] guessed both constants and spilled the
    // grid ~18px under the fixed tab bar.
    <div className="flex flex-col" style={{ height: "calc(100dvh - var(--member-header-clearance) - var(--member-nav-clearance))" }}>

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
        {loadError ? (
          // UI-RULES §7: the grid is replaced, not annotated — leaving it
          // rendered would show "No classes today" behind the message and let
          // the member tap subscribe with unknown subscription state.
          <div className="px-4 py-10">
            <ErrorState message={loadError} onRetry={loadSchedule} />
          </div>
        ) : (
        /* Strip: 3 panels side by side, centered on the current day */
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
              startHour={startHour}
              endHour={endHour}
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
              startHour={startHour}
              endHour={endHour}
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
              startHour={startHour}
              endHour={endHour}
            />
          </div>
        </div>
        )}
      </div>

      {/* Event detail sheet */}
      {selectedCls && (
        <EventSheet
          cls={selectedCls}
          isSub={subscribed.has(selectedCls.classId)}
          onToggle={() => toggle(selectedCls.classId)}
          onClose={() => setSelected(null)}
          primaryColor={primaryColor}
        />
      )}
    </div>
  );
}
