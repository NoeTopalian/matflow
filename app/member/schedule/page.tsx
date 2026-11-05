"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronLeft, ChevronRight, Bell, BellOff, Lock, X } from "lucide-react";
import { TIER_LOCKED_LABEL } from "@/lib/class-tier-gate";
import { bookingFailureMessage } from "@/lib/checkin-outcome";
import { classCategoryTag } from "@/lib/class-category";
import { useSwipeToDismiss } from "@/lib/useSwipeToDismiss";
import { useToast } from "@/components/ui/Toast";
import { ErrorState } from "@/components/ui/ErrorState";
import { Button } from "@/components/ui/button";
import {
  minToTime,
  sessionProgress,
  sessionStateLabel,
  sessionStates,
  spanMinutes,
  type SessionState,
} from "@/lib/schedule-state";
import { buildTimetableGrid, type GridLayout } from "@/lib/timetable-grid";
import { PosterDay } from "@/components/schedule/PosterGrid";
import { MorePanel, useMoreToggle } from "@/components/schedule/MorePanel";

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
  /** The mat the class runs on (null = none): the day draws a column per mat when the club splits by mat. */
  matId: string | null;
  capacity: number | null;
  /** A kids class — tagged "Kids" on the timetable. */
  isKids?: boolean;
  /** A kids class and the viewer is an adult or parent: never badged "Next". */
  kidsClassForAdult?: boolean;
  /** T6c: the category key (lib/class-category.ts); null = uncategorised. */
  category?: string | null;
  color?: string | null;
  dow: number; // 1=Mon…7=Sun internal convention
  classInstanceId?: string | null;
  // Task 14: server-side eligibility flag (rank-based) + roster status.
  // "rank_below" / "rank_above" → shown with lock badge + disabled subscribe.
  // "roster_ok" → "Comp team" tag. "ok" → normal. Roster-only classes the
  // member is NOT on are filtered out at the API layer (api/member/schedule).
  // "tier_not_included" (T6a) → "Not included in your membership", not bookable.
  eligibility?: "ok" | "rank_below" | "rank_above" | "roster_ok" | "tier_not_included";
  requiredRankName?: string | null;
  maxRankName?: string | null;
  /** Today's session for this slot is cancelled (api/member/schedule). */
  cancelled?: boolean;
  /**
   * D2: the member is booked on this class but its rules now turn them away
   * (the booking is kept). `sentence` is the door's own refusal.
   */
  bookedIneligible?: { reason: string; sentence: string } | null;
};

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_FULL   = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * Secondary ink on the members' day: the shell's own text at 72 %. The shell's muted ink measures 4.4:1 on a light
 * club shell, under the 4.5:1 floor; this reads on dark and light shells and over a block's tint.
 */
const QUIET_INK = "color-mix(in srgb, var(--member-text) 72%, transparent)";

/** How the club splits same-time classes, and its mats in the club's order (GET /api/member/timetable). */
type ClubTimetable = { layout: GridLayout; mats: { id: string; name: string }[] };
const BY_TIME: ClubTimetable = { layout: "time", mats: [] };
const FELL_BACK = "Too much on at once to show by mat on this screen. Each class shows its mat.";

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
            {cls.isKids && (
              <span
                className="rounded-full px-2 text-[10px] font-bold uppercase tracking-wide leading-5"
                style={{ color: "var(--member-text-muted)", border: "1px solid var(--member-border)" }}
              >
                Kids
              </span>
            )}
            {classCategoryTag(cls) && (
              // T6c: what kind of class this is.
              <span
                data-testid="schedule-sheet-category"
                className="rounded-full px-2 text-[10px] font-semibold tracking-wide leading-5"
                style={{ color: "var(--member-text-muted)", border: "1px solid var(--member-border)" }}
              >
                {classCategoryTag(cls)}
              </span>
            )}
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
          {cls.eligibility === "tier_not_included" && (
            // T6a: the same sentence everywhere a member meets this class.
            <div
              className="rounded-xl px-3 py-2 text-xs flex items-center gap-2"
              data-testid="schedule-tier-locked"
              style={{
                background: "color-mix(in srgb, var(--hue-warning) 10%, transparent)",
                border: "1px solid color-mix(in srgb, var(--hue-warning) 25%, transparent)",
                color: "var(--hue-warning)",
              }}
            >
              <Lock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> {TIER_LOCKED_LABEL} — ask your gym about a membership that includes it.
            </div>
          )}
          {cls.eligibility === "roster_ok" && (
            <div className="rounded-xl px-3 py-2 text-xs flex items-center gap-2"
              style={{ background: "rgba(168,85,247,0.10)", border: "1px solid rgba(168,85,247,0.25)", color: "#c084fc" }}>
              🏆 Comp team — invite-only class
            </div>
          )}
          {isSub && cls.bookedIneligible && (
            // D2: the booking is kept, and the member is told what the door will say.
            <div
              className="rounded-xl px-3 py-2 text-xs"
              data-testid="schedule-booked-ineligible"
              role="status"
              style={{
                background: "color-mix(in srgb, var(--hue-warning) 10%, transparent)",
                border: "1px solid color-mix(in srgb, var(--hue-warning) 25%, transparent)",
                color: "var(--hue-warning)",
              }}
            >
              <p className="font-semibold">Not eligible: {cls.bookedIneligible.sentence}</p>
              <p className="mt-1">Your booking is kept, but check-in will turn you away until this changes.</p>
            </div>
          )}

          <button
            onClick={onToggle}
            // A booked member can always cancel their own booking, eligible or not (D2).
            disabled={!isSub && (cls.eligibility === "rank_below" || cls.eligibility === "rank_above" || cls.eligibility === "tier_not_included")}
            className="w-full py-3.5 rounded-2xl flex items-center justify-center gap-2 font-semibold text-sm transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: isSub ? hex(primaryColor, 0.12) : primaryColor,
              color: isSub ? primaryColor : "var(--tx-on-accent)",
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

// ─── Day pane ─────────────────────────────────────────────────────────────────

/**
 * One day of the members' timetable: the poster grid (components/schedule/
 * PosterGrid `PosterDay`), the same rows and columns as the staff timetable.
 * Two classes at the same time start on the same line and sit side by side;
 * a 20-minute class never sits over the class after it. By mat, one column per
 * mat with the names pinned at the top of the pane, while the day needs three
 * lanes or fewer; a busier day is drawn by time and says so. More than three
 * at once: two classes and "+N more", which lists them all over the grid.
 */
function DayPane({
  dow,
  primaryColor,
  subscribed,
  selected,
  onSelect,
  scrollRef,
  loading,
  allClasses,
  club,
}: {
  dow: number;
  primaryColor: string;
  subscribed: Set<string>;
  selected: string | null;
  onSelect: (id: string) => void;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  loading: boolean;
  allClasses: ScheduleClass[];
  club: ClubTimetable;
}) {
  // "Now" is the member's own device clock — their phone, in the club. Nothing
  // carries Tenant.timezone to this screen yet (lib/schedule-state.ts).
  const today = new Date();
  const todayDow = today.getDay() === 0 ? 7 : today.getDay();
  const showNow = dow === todayDow;
  const nowMinutes = today.getHours() * 60 + today.getMinutes();
  const dayClasses = allClasses.filter((c) => c.dow === dow);
  // The API keys today's instance by class + start time, so a class that meets
  // on several days carries today's flag on every day's entry; it only means
  // anything on today's grid.
  const spans = dayClasses.map((c) => ({ ...spanMinutes(c.time, c.endTime), cancelled: showNow && c.cancelled === true, neverNext: c.kidsClassForAdult === true || c.eligibility === "tier_not_included" || c.eligibility === "rank_below" || c.eligibility === "rank_above" }));
  // ^ the same classes Home's next class leaves out (pickNextClass in
  //   lib/member-stats.ts): ones the door would refuse this member.
  const states = sessionStates(spans, nowMinutes, showNow);
  const indexOf = new Map(dayClasses.map((c, i) => [c.id, i] as const));
  const matOrder = new Map(club.mats.map((m, i) => [m.id, i] as const));
  const matNames = new Map(club.mats.map((m) => [m.id, m.name] as const));
  const jsDay = dow === 7 ? 0 : dow;
  const grid = buildTimetableGrid(
    dayClasses.map((c) => {
      const position = c.matId ? matOrder.get(c.matId) : undefined;
      return {
        key: c.id, day: jsDay, startTime: c.time, endTime: c.endTime, matId: c.matId,
        tie: position !== undefined ? String(position).padStart(2, "0") : c.location,
      };
    }),
    { days: [jsDay], layout: club.layout, mats: club.mats.map((m) => ({ id: m.id })), maxTracks: 3 },
  );
  const day = grid.days[0];
  // Three lanes leave each block about a third of the screen: it keeps the smaller sizes.
  const size = day.lanes >= 3 ? "small" : "large";
  const root = useRef<HTMLDivElement>(null);
  // The open "+N more". It closes on a day change (plan §4.12): this pane shows another day after a swipe, and on
  // the way back the panel must not open again and take focus.
  const [more, setMore] = useState<{ dow: number; id: string } | null>(null);
  const [moreDay, setMoreDay] = useState(dow);
  if (moreDay !== dow) {
    setMoreDay(dow);
    setMore(null);
  }
  const openMore = more && more.dow === dow ? more.id : null;
  const matOf = (cls: ScheduleClass) => (cls.matId ? (matNames.get(cls.matId) ?? null) : null);
  // The last line names the place only where it is what tells classes apart:
  // side by side on a day by time, under "No mat", and on a day that fell back
  // to time. Under a pinned mat name, and for a class on its own, it names the coach.
  const placeShown = (item: { matId: string | null; lanes: number }) =>
    day.layout === "mat" ? item.matId === null : day.fellBack || item.lanes > 1;
  // A class folded into "+N more" has no block of its own: the button says whether it hides the live or next class,
  // so the scroll to it on opening the day lands on the button.
  const foldedState = (keys: string[]) => {
    const hidden = keys.map((key) => states[indexOf.get(key) ?? -1]);
    return hidden.includes("live") ? "live" : hidden.includes("next") ? "next" : undefined;
  };
  const blockFor = (cls: ScheduleClass, showPlace: boolean) => {
    const i = indexOf.get(cls.id) ?? 0;
    return (
      <SessionBlock
        cls={cls}
        state={states[i]}
        progress={sessionProgress(spans[i], nowMinutes)}
        isSub={subscribed.has(cls.classId)}
        isSel={selected === cls.id}
        primaryColor={primaryColor}
        onSelect={onSelect}
        size={size}
        showPlace={showPlace}
        matName={matOf(cls)}
      />
    );
  };

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto"
      // pan-y tells the browser vertical scroll is allowed here;
      // our non-passive horizontal handler overrides when needed
      style={{ scrollbarWidth: "none", touchAction: "pan-y" }}
    >
      <div ref={root} className="px-3 pb-6">
        {day.fellBack ? (
          <p className="mb-2 px-1 text-xs" style={{ color: QUIET_INK }} data-testid="schedule-fallback">
            {FELL_BACK}
          </p>
        ) : null}
        {!loading && dayClasses.length === 0 ? (
          <p className="py-16 text-center text-gray-700 text-sm">No classes today</p>
        ) : dayClasses.length > 0 ? (
          <PosterDay
            grid={grid}
            tone="member"
            pinMats
            label={`${DAY_FULL[dow - 1]}, ${dayClasses.length} ${dayClasses.length === 1 ? "class" : "classes"}`}
            matName={(matId) => (matId === null ? "No mat" : (matNames.get(matId) ?? "No mat"))}
            testId="schedule-day"
            renderSession={(item) => {
              const cls = dayClasses[indexOf.get(item.key) ?? -1];
              return cls ? blockFor(cls, placeShown(item)) : null;
            }}
            renderMore={(item) => (
              <MemberMore
                folded={foldedState(item.keys)}
                count={item.keys.length}
                label={`${item.keys.length} more classes, ${minToTime(item.startMin)} to ${minToTime(item.endMin)}. Show them.`}
                expanded={openMore === item.id}
                onOpen={() => setMore({ dow, id: item.id })}
                onClose={() => setMore(null)}
              />
            )}
            openMore={openMore}
            renderMorePanel={(item) => {
              const inCluster = item.clusterKeys.map((key) => dayClasses[indexOf.get(key) ?? -1]).filter((c): c is ScheduleClass => !!c);
              const from = Math.min(...inCluster.map((c) => spanMinutes(c.time, c.endTime).startMin));
              const to = Math.max(...inCluster.map((c) => spanMinutes(c.time, c.endTime).endMin));
              return (
                <MorePanel
                  label={`${inCluster.length} classes, ${minToTime(from)} to ${minToTime(to)}`}
                  className="shadow-lg"
                  style={{ background: "var(--member-elevated)" }}
                  closeClassName="text-[color-mix(in_srgb,var(--member-text)_72%,transparent)]"
                  onClose={(returnFocus) => {
                    if (returnFocus) root.current?.querySelector<HTMLElement>(`[data-cell-more="${item.id}"] button`)?.focus();
                    setMore(null);
                  }}
                >
                  {inCluster.map((cls) => (
                    <div key={cls.id} className="grid min-h-11">
                      {/* The panel's rows are not under a mat name: each says its mat. */}
                      {blockFor(cls, true)}
                    </div>
                  ))}
                </MorePanel>
              );
            }}
            breakLabel={(fromMin, toMin) => `No classes ${minToTime(fromMin)} to ${minToTime(toMin)}`}
          />
        ) : null}
      </div>
    </div>
  );
}

/** "+N more" on the members' day: a dashed block in the member shell's inks that opens the list over the grid. */
function MemberMore({ count, label, expanded, onOpen, onClose, folded }: { count: number; label: string; expanded: boolean; onOpen: () => void; onClose: () => void; folded?: "live" | "next" }) {
  const press = useMoreToggle(expanded, onOpen, onClose);
  return (
    <Button
      variant="ghost"
      {...press}
      aria-label={label}
      aria-expanded={expanded}
      data-testid="schedule-more"
      data-folded-state={folded}
      className="h-auto min-h-[44px] flex-col items-stretch justify-start gap-0.5 whitespace-normal rounded-xl border border-dashed px-[7px] pb-[8px] pt-[7px] text-left font-normal hover:bg-transparent"
      style={{ borderColor: "var(--member-border)", background: "var(--member-surface)", color: "var(--member-text)" }}
    >
      <span className="text-[13px] font-semibold leading-[17px]">+{count} more</span>
      <span className="text-[11px] leading-[14px]" style={{ color: QUIET_INK }}>Show them</span>
    </Button>
  );
}

/**
 * One class on the members' day. The time range is the first line (never cut),
 * then the name in full, then the pills on a wrapping row (the Bell with them),
 * then one last line that may be cut: the place where it tells two classes
 * apart — side by side by time, under "No mat", on a day drawn by time — and
 * the coach under a pinned mat name. Its temporal state is in words (a pill
 * and the accessible name), never in colour or opacity alone: "Live" gets the
 * accent edge, a pulsing dot (motion-safe) and an elapsed hairline; "Ended"
 * the pill and a paler fill (the ink is unchanged); "Cancelled" the pill and
 * a struck name. The same vocabulary appears on the staff timetable's chips.
 */
function SessionBlock({
  cls,
  state,
  progress,
  isSub,
  isSel,
  primaryColor,
  onSelect,
  size,
  showPlace,
  matName,
}: {
  cls: ScheduleClass;
  state: SessionState;
  progress: number;
  isSub: boolean;
  isSel: boolean;
  primaryColor: string;
  onSelect: (id: string) => void;
  /** "large" for one or two lanes, "small" for three (plan §4.7). */
  size: "large" | "small";
  /** The last line names the place (the mat, else the typed place) rather than the coach. */
  showPlace: boolean;
  /** The class's mat, for its accessible name. */
  matName: string | null;
}) {
  const color  = normalizeHex(cls.color ?? primaryColor);
  const text   = readableText(color);
  // Subscribed blocks are filled with the class colour, so the ink is whatever
  // reads on it. Unsubscribed blocks are a tint of that colour over the member
  // shell, so their ink is the shell's own text, never a hard-coded dark navy
  // (the contact sheet of 26 Sep showed near-invisible class names on a blue club).
  // On a booked block the secondary text (the last line, the category, the Bell) is the block's own ink: a
  // see-through ink measured about 2.7:1 on a blue class (plan Appendix B 19).
  const muted  = isSub ? text : QUIET_INK;
  const ink    = isSub ? text : "var(--member-text)";
  const ended  = state === "ended";
  const cancelled = state === "cancelled";
  const live   = state === "live";
  const label  = sessionStateLabel(state);
  const pillTint =
    live ? "var(--hue-success)" : state === "next" ? "var(--hue-info)" : cancelled ? "var(--hue-danger)" : undefined;
  const place  = showPlace ? (cls.location || cls.coach) : cls.coach;
  const where  = matName ?? (cls.location || null);
  const large  = size === "large";
  const pill   = "inline-flex items-center rounded-full px-1.5 text-[9px] font-bold uppercase tracking-wide leading-4";
  const category = classCategoryTag(cls);

  return (
    <Button
      variant="ghost"
      onClick={() => onSelect(cls.id)}
      data-session-state={state}
      data-block-size={size}
      data-booked={isSub || undefined}
      aria-label={`${cls.name}, ${cls.time} to ${cls.endTime}${where ? `, ${where}` : ""}${state === "upcoming" ? "" : `, ${label.toLowerCase()}`}`}
      className={[
        "relative h-auto flex-col items-stretch justify-start gap-0.5 overflow-hidden whitespace-normal rounded-xl text-left font-normal transition-all active:scale-[0.98] hover:bg-transparent",
        large ? "min-h-[56px] px-[7px] pb-[8px] pt-[7px]" : "min-h-[44px] px-[5px] pb-[6px] pt-[5px]",
      ].join(" ")}
      style={{
        // A booked class is filled with its colour; an ended one that is not booked has a paler tint, its ink unchanged (UI-RULES §8).
        background: isSub
          ? `linear-gradient(135deg, ${color}, ${hex(color, 0.82)})`
          : `linear-gradient(135deg, ${hex(color, ended ? 0.16 : 0.32)}, ${hex(color, ended ? 0.1 : 0.2)})`,
        border: `1px solid ${isSub ? hex(color, 0.9) : hex(color, ended ? 0.3 : 0.58)}`,
        borderLeft: live ? `3px solid ${isSub ? "var(--member-text)" : color}` : undefined,
        boxShadow: isSel ? `0 0 0 2px var(--member-elevated), 0 0 0 4px ${hex(color, 0.75)}` : undefined,
        color: ink,
        // A booked class that has ended is greyed. Desaturating keeps each colour's brightness, so its ink still
        // reads; a see-through fill would not on a light shell.
        filter: isSub && ended ? "saturate(0.35)" : undefined,
      }}
    >
      <span className={["font-bold tabular-nums", large ? "text-xs leading-[15px]" : "text-[11px] leading-[14px]"].join(" ")} data-block-part="time">
        {cls.time}–{cls.endTime}
      </span>
      <span
        className={["font-semibold [overflow-wrap:anywhere]", large ? "text-[13px] leading-[17px]" : "text-xs leading-[15px]"].join(" ")}
        style={{ textDecoration: cancelled ? "line-through" : undefined }}
        data-block-part="name"
      >
        {cls.name}
      </span>
      {cls.isKids || (isSub && cls.bookedIneligible) || cls.eligibility === "tier_not_included" || state !== "upcoming" || category || isSub ? (
        <span className="flex flex-wrap items-center gap-1">
          {state !== "upcoming" && (
            <span
              className={`${pill} gap-1`}
              style={{
                background: pillTint ? `color-mix(in srgb, ${pillTint} 18%, transparent)` : `color-mix(in srgb, ${ink} 10%, transparent)`,
                border: `1px solid ${pillTint ? `color-mix(in srgb, ${pillTint} 55%, transparent)` : `color-mix(in srgb, ${ink} 30%, transparent)`}`,
              }}
            >
              {live && (
                <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full motion-safe:animate-pulse" style={{ background: "var(--hue-success)" }} />
              )}
              {label}
            </span>
          )}
          {cls.isKids && (
            <span className={pill} style={{ border: `1px solid color-mix(in srgb, ${ink} 30%, transparent)` }}>
              Kids
            </span>
          )}
          {isSub && cls.bookedIneligible && (
            // D2: booked, but the door now refuses this member; the sheet says why.
            <span
              className={pill}
              style={{ border: `1px solid color-mix(in srgb, ${ink} 30%, transparent)` }}
              data-testid="schedule-cell-booked-ineligible"
              title={`Not eligible: ${cls.bookedIneligible.sentence}`}
            >
              Not eligible
            </span>
          )}
          {cls.eligibility === "tier_not_included" && (
            // T6a: locked, not hidden; the sheet says why.
            <span className="inline-flex items-center" title={TIER_LOCKED_LABEL} aria-label={TIER_LOCKED_LABEL} data-testid="schedule-cell-tier-locked">
              <Lock className="w-3 h-3" aria-hidden="true" />
            </span>
          )}
          {category && (
            <span className="text-[10px] leading-4" style={{ color: muted }} data-testid="schedule-cell-category">{category}</span>
          )}
          {isSub && !live && <Bell className="w-2.5 h-2.5" style={{ color: muted }} aria-hidden="true" />}
        </span>
      ) : null}
      {place ? (
        <span className="truncate text-[11px] leading-[14px]" style={{ color: muted }} data-testid={showPlace && cls.location ? "schedule-cell-place" : undefined} data-block-part="place">
          {place}
        </span>
      ) : null}
      {live && (
        <span
          aria-hidden="true"
          className="absolute left-0 bottom-0 h-0.5"
          style={{ width: `${Math.round(progress * 100)}%`, background: isSub ? text : color }}
        />
      )}
    </Button>
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
  // By mat or by time, and the mats. Read beside the schedule and waited for,
  // so the day never draws by time and then jumps to mat columns. If it cannot
  // be read the day is drawn by time: every class is still there.
  const [club, setClub] = useState<ClubTimetable>(BY_TIME);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  // UI-RULES §7: a failed load is an error, never "No classes today".
  const [loadError, setLoadError] = useState<string | null>(null);
  // T7: "2 of 4 classes used this 4-week period — resets …" for a plan with an
  // allowance. Supplementary to the grid, so its failure is said in its own
  // line rather than replacing the timetable (and never shown as nothing).
  const [allowance, setAllowance] = useState<{ kind: "loading" } | { kind: "ready"; text: string | null } | { kind: "error" }>({ kind: "loading" });

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
    let cancelled = false;
    // Deferred to a microtask so the effect body does not set state
    // synchronously (react-hooks/set-state-in-effect); same pattern as
    // app/member/home/page.tsx.
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const raw = localStorage.getItem("gym-settings");
        if (raw) {
          const settings = JSON.parse(raw) as { primaryColor?: string };
          if (settings.primaryColor && /^#[0-9a-f]{6}$/i.test(settings.primaryColor)) {
            setPrimaryColor(settings.primaryColor);
          }
        }
      } catch { /* localStorage unavailable in SSR / private mode — fall back to default */ }
    });
    return () => { cancelled = true; };
  }, []);

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

  // On opening a day the pane scrolls — no animation, focus stays where it is —
  // so the class that is on now, or the next one, is in view under the pinned
  // mat names. Any other day opens at its top. Runs when the day changes and
  // once the schedule has loaded.
  useEffect(() => {
    const pane = centerRef.current;
    if (!pane || scheduleLoading) return;
    const band = pane.querySelector<HTMLElement>("[data-mat-head]")?.getBoundingClientRect().height ?? 0;
    pane.style.scrollPaddingTop = `${Math.ceil(band)}px`;
    const target =
      pane.querySelector<HTMLElement>('[data-session-state="live"], [data-folded-state="live"]') ??
      pane.querySelector<HTMLElement>('[data-session-state="next"], [data-folded-state="next"]');
    if (!target) {
      pane.scrollTo({ top: 0 });
      return;
    }
    const top = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    pane.scrollTo({ top: Math.max(0, top - band - 8) });
  }, [selectedDay, scheduleLoading]);

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

    // `date` is the member's calendar day on their own device: without it the
    // API maps no instances at all, so the day view never knew that today's
    // session was cancelled (or which instance a booking should target).
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const classes = fetch(`/api/member/schedule?date=${localDate}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      // This hand-written shape is WHY the classId bug survived review: it
      // omitted classId, so dropping it in the mapping below was invisible to
      // the type checker. Keep it in step with app/api/member/schedule/route.ts.
      .then((data: Array<{
        id: string; classId: string; name: string; startTime: string; endTime: string;
        coach: string; location: string; matId?: string | null; capacity: number | null; color?: string | null;
        isKids?: boolean;
        kidsClassForAdult?: boolean;
        category?: string | null;
        eligibility?: "ok" | "rank_below" | "rank_above" | "roster_ok" | "tier_not_included";
        requiredRankName?: string | null; maxRankName?: string | null;
        dayOfWeek: number; classInstanceId?: string | null; cancelled?: boolean;
        bookedIneligible?: { reason: string; sentence: string } | null;
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
          matId: c.matId ?? null,
          capacity: c.capacity,
          isKids: c.isKids === true,
          kidsClassForAdult: c.kidsClassForAdult === true,
          category: c.category ?? null,
          color: c.color ?? null,
          // API: 0=Sun…6=Sat (JS getDay). Internal: 1=Mon…7=Sun.
          dow: c.dayOfWeek === 0 ? 7 : c.dayOfWeek,
          classInstanceId: c.classInstanceId ?? null,
          cancelled: c.cancelled === true,
          // Also dropped: without these the rank-lock badge and the disabled
          // state on the subscribe button were unreachable code.
          eligibility: c.eligibility,
          requiredRankName: c.requiredRankName ?? null,
          maxRankName: c.maxRankName ?? null,
          bookedIneligible: c.bookedIneligible ?? null,
        }));
        return mapped;
      });

    // Hydrate the subscribed set from the server so reload preserves state.
    const subs = fetch("/api/member/me/subscriptions")
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: { classIds?: string[] }) => {
        setSubscribed(new Set(data.classIds ?? []));
      });

    // T7: the plan allowance line. Not part of the grid's all-or-nothing load.
    fetch("/api/member/me/allowance", { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d: { allowance?: { text?: unknown } | null }) => {
        setAllowance({ kind: "ready", text: typeof d.allowance?.text === "string" ? d.allowance.text : null });
      })
      .catch(() => setAllowance({ kind: "error" }));

    // How the club splits same-time classes. Never rejects: without it the day
    // is drawn by time, which shows every class (only the mat columns are lost).
    const timetable = fetch("/api/member/timetable", { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d: { layout?: unknown; mats?: unknown }): ClubTimetable => {
        const mats = Array.isArray(d.mats)
          ? d.mats.filter((m): m is { id: string; name: string } => !!m && typeof (m as { id?: unknown }).id === "string" && typeof (m as { name?: unknown }).name === "string")
          : [];
        return { layout: d.layout === "mat" ? "mat" : "time", mats };
      })
      .catch(() => BY_TIME);

    // Raw exception text never reaches the member (UI-RULES §7/§10). The
    // classes and the layout are set together, once both are in, so the day is
    // drawn once — never by time first and then again in mat columns.
    Promise.all([classes, subs, timetable])
      .then(([mapped, , layout]) => {
        setAllClasses(mapped);
        setClub(layout);
      })
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
    let failure: string | null = null;
    try {
      const res = await fetch(`/api/member/class-subscriptions/${id}`, {
        method: wasSubscribed ? "DELETE" : "POST",
      });
      if (!res.ok) {
        // T6a/T6b: the refusal names the class and the plan (or says the
        // class is paused) — show that, not a guess (the list may be stale).
        const body = await res.json().catch(() => null);
        failure = bookingFailureMessage(res.status, body, wasSubscribed);
      } else if (!wasSubscribed) {
        // T7: the booking stands whatever the allowance says — a booking
        // consumes nothing and guarantees nothing. When the period is
        // already used up the server says so, and the member hears it now
        // rather than at the door.
        const body = (await res.json().catch(() => null)) as { allowanceNotice?: unknown } | null;
        if (typeof body?.allowanceNotice === "string" && body.allowanceNotice) toast(body.allowanceNotice, "warning", 8000);
      }
    } catch {
      failure = bookingFailureMessage(0, null, wasSubscribed);
    }
    if (failure) {
      // Audit D8: roll back AND tell the member — previously the button
      // flipped back with no feedback at all.
      setSubscribed((prev) => {
        const n = new Set(prev);
        if (wasSubscribed) n.add(id);
        else n.delete(id);
        return n;
      });
      toast(failure, "error");
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
    // The height of the layout's content area, which already leaves room for the header, the two-factor
    // banner when it shows, and the bottom tab bar. Sizing from fixed header and tab-bar heights instead
    // (audit U5) put the end of the day under the tab bar whenever the banner was showing.
    <div className="flex h-full flex-col">

      {/* ── Top controls ── */}
      <div className="px-4 pt-4 pb-2 shrink-0">
        {/* Week nav */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1">
            <button
              aria-label="Previous week"
              onClick={() => { const d = new Date(anchor); d.setDate(d.getDate() - 7); setAnchor(d); }}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 hover:text-white transition-all"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              aria-label="Next week"
              onClick={() => { const d = new Date(anchor); d.setDate(d.getDate() + 7); setAnchor(d); }}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 hover:text-white transition-all"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            {/* The page's only heading. It was a <span>, which left the
                schedule with no heading element at all: heading navigation
                skipped the page entirely and there was nothing to announce on
                arrival. The classes are unchanged, so it looks identical. */}
            <h1 className="text-white text-sm font-medium ml-1">{weekLabel}</h1>
          </div>
          <button
            onClick={() => { setAnchor(today); setSelectedDay(today.getDay() === 0 ? 6 : today.getDay() - 1); }}
            className="text-xs font-medium px-2.5 py-1.5 rounded-lg border border-white/10 text-gray-400 hover:text-white transition-all"
          >
            Today
          </button>
        </div>

        {allowance.kind === "ready" && allowance.text && (
          <p className="text-xs font-medium px-1 mb-2" style={{ color: "var(--member-text)" }} data-testid="schedule-allowance">
            {allowance.text}
          </p>
        )}
        {allowance.kind === "error" && (
          <p className="text-xs px-1 mb-2" style={{ color: "var(--member-text-muted)" }} data-testid="schedule-allowance">
            Couldn&apos;t load how many classes your plan has left.
          </p>
        )}

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
                  // §2a: 70% of the derived on-accent foreground, not 70% white —
                  // the selected pill is filled with the tenant's colour.
                  style={{ color: isSel ? "color-mix(in srgb, var(--tx-on-accent) 70%, transparent)" : "var(--member-inactive)" }}
                >
                  {DAY_LABELS[i]}
                </span>
                <span
                  className="text-base font-bold leading-none"
                  style={{ color: isSel ? "var(--tx-on-accent)" : isToday ? primaryColor : "var(--member-text)" }}
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

        {/* Day label: the day, how many classes, and how many are on right now */}
        <p className="text-gray-400 text-xs font-medium mt-2 mb-1 px-1">
          {DAY_FULL[selectedDay]}
          {(() => {
            const dayCount = allClasses.filter((c) => c.dow === currDow).length;
            if (scheduleLoading || dayCount === 0) return null;
            const isToday = fmt(weekDays[selectedDay]) === fmt(today);
            const nowMin = today.getHours() * 60 + today.getMinutes();
            const live = isToday
              ? sessionStates(
                  allClasses.filter((c) => c.dow === currDow).map((c) => ({ ...spanMinutes(c.time, c.endTime), cancelled: c.cancelled === true })),
                  nowMin,
                  true,
                ).filter((s) => s === "live").length
              : 0;
            return ` · ${dayCount} ${dayCount === 1 ? "class" : "classes"}${live > 0 ? ` · ${live} live` : ""}`;
          })()}
        </p>
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
          {/* Previous day. The side panes are off screen until a swipe brings one in: `inert`
              keeps their classes out of the Tab order and away from screen readers. */}
          <div className="overflow-hidden h-full shrink-0" style={{ width: "33.333%" }} inert data-testid="schedule-pane-prev">
            <DayPane
              dow={prevDow}
              primaryColor={primaryColor}
              subscribed={subscribed}
              selected={selected}
              onSelect={setSelected}
              loading={scheduleLoading}
              allClasses={allClasses}
              club={club}
            />
          </div>

          {/* Current day */}
          <div className="overflow-hidden h-full shrink-0" style={{ width: "33.333%" }} data-testid="schedule-pane">
            <DayPane
              dow={currDow}
              primaryColor={primaryColor}
              subscribed={subscribed}
              selected={selected}
              onSelect={setSelected}
              scrollRef={centerRef}
              loading={scheduleLoading}
              allClasses={allClasses}
              club={club}
            />
          </div>

          {/* Next day */}
          <div className="overflow-hidden h-full shrink-0" style={{ width: "33.333%" }} inert data-testid="schedule-pane-next">
            <DayPane
              dow={nextDow}
              primaryColor={primaryColor}
              subscribed={subscribed}
              selected={selected}
              onSelect={setSelected}
              loading={scheduleLoading}
              allClasses={allClasses}
              club={club}
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
