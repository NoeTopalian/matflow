"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { Select } from "@/components/ui/select";
import {
  Plus, Calendar, Clock, Users, MapPin, ChevronRight, ChevronLeft,
  X, Edit2, RefreshCw, Tag, Pause, Archive, ArchiveRestore, Play,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { hex } from "@/lib/color";
import { describeApiError } from "@/lib/api-field-errors";
import { sessionStateLabel, sessionStates, spanMinutes, type SessionState } from "@/lib/schedule-state";
import type { ClassRow, CoachUserOption, TierOption } from "@/app/dashboard/timetable/page";
import { Checkbox } from "@/components/ui/checkbox";
import { CLASS_CATEGORIES, CLASS_CATEGORY_LABELS, classCategoryLabel, classCategoryTag } from "@/lib/class-category";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RankOption {
  id: string;
  name: string;
  color: string | null;
  discipline: string;
}

interface Props {
  initialClasses: ClassRow[];
  /** T6b: paused and archived classes, for the "Paused and archived" section. */
  initialInactiveClasses?: ClassRow[];
  rankSystems: RankOption[];
  coachUsers: CoachUserOption[];
  /** T6a: every membership tier of the club, for "Who can attend". */
  membershipTiers?: TierOption[];
  primaryColor: string;
  role: string;
  // Session F: drives the "My classes" filter. When null (e.g. no
  // currentUserId resolvable from session) the toggle is suppressed.
  currentUserId: string | null;
}

interface ScheduleInput {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/** What PATCH /api/classes/[id] reports back about a timetable edit (task 3c). */
interface ScheduleChange {
  slotsAdded: number;
  slotsRemoved: number;
  instancesRemoved: string[];
  instancesKept: string[];
  instancesCreated: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The save message, in the interface's voice: state what happened.
 *
 * The old code toasted "Class updated" for a `schedules` field the server threw
 * away, which is the exact failure RULES §2 names. Changing a class time now
 * deletes upcoming sessions and mints new ones, so §5 requires the operator to
 * see that — especially the sessions that could NOT be moved because members
 * are already on them.
 */
function describeSave(change: ScheduleChange | null | undefined): string {
  if (!change || (change.slotsAdded === 0 && change.slotsRemoved === 0)) {
    return "Class updated";
  }
  const parts = [`Class updated. Timetable changed`];
  if (change.instancesRemoved.length > 0) {
    parts.push(`${plural(change.instancesRemoved.length, "upcoming session", "upcoming sessions")} removed`);
  }
  if (change.instancesCreated > 0) {
    parts.push(`${plural(change.instancesCreated, "new session", "new sessions")} added`);
  }
  let message = `${parts.join(", ")}.`;
  if (change.instancesKept.length > 0) {
    message +=
      ` ${plural(change.instancesKept.length, "session", "sessions")} kept at the old time` +
      ` — members have already checked in or joined the waitlist. Cancel them from the register if they are not running.`;
  }
  return message;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const CLASS_COLORS = [
  "#3b82f6", "#8b5cf6", "#ec4899", "#ef4444",
  "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#06b6d4", "#6366f1",
];

// UI-RULES §2: the inline hex()/alpha-maths copy that lived here is gone —
// lib/color.ts is the single source (imported above).

/** Value of the timetable category filter that selects uncategorised classes. */
const UNCATEGORISED = "__uncategorised";

/**
 * One class as it appears inside a day — used by BOTH the desktop week grid and
 * the mobile agenda, so the two views can never drift apart in what they show
 * or how they behave. Extracting it also means the mobile view adds no new raw
 * <button> site (UI-RULES §11): there is one clickable class chip in this file,
 * not one per layout.
 *
 * `canManage` gates the click. A coach or admin sees the same chip but it is a
 * genuine `disabled` button rather than something that merely looks clickable —
 * the UI audit flagged fake-clickable cells here specifically.
 */
function ClassChip({
  cls,
  startTime,
  primaryColor,
  canManage,
  onEdit,
  size = "grid",
  state = null,
}: {
  cls: ClassRow;
  startTime: string | undefined;
  primaryColor: string;
  canManage: boolean;
  onEdit: (cls: ClassRow) => void;
  /** "grid" = dense 7-column cell, "agenda" = full-width mobile row. */
  size?: "grid" | "agenda";
  /**
   * Today's temporal state for this slot (lib/schedule-state.ts) — the same
   * words the member's day view uses. `null` on any other day. Today's
   * cancelled sessions come from /api/coach/today (D6) and read "Cancelled".
   */
  state?: SessionState | null;
}) {
  const color = cls.color ?? primaryColor;
  const agenda = size === "agenda";
  const showState = state !== null && state !== "upcoming";
  const stateTint =
    state === "live" ? "var(--hue-success)" : state === "next" ? "var(--hue-info)" : null;
  const stateInk =
    state === "live" ? "var(--hue-success-ink)" : state === "next" ? "var(--hue-info-ink)" : "var(--tx-3)";
  return (
    <button
      type="button"
      onClick={() => canManage && onEdit(cls)}
      disabled={!canManage}
      aria-label={
        canManage
          ? `Edit ${cls.name}${showState ? ` (${sessionStateLabel(state).toLowerCase()})` : ""}`
          : undefined
      }
      data-session-state={state ?? undefined}
      className={[
        "w-full text-left flex items-start gap-1.5 transition-all",
        "enabled:hover:brightness-110 disabled:cursor-default",
        agenda ? "rounded-xl px-3 py-2.5 gap-2.5" : "rounded-xl px-2 py-1.5",
      ].join(" ")}
      style={{
        background: hex(color, 0.12),
        border: `1px solid ${hex(color, 0.2)}`,
        borderLeft: state === "live" ? `3px solid ${color}` : undefined,
        opacity: state === "ended" || state === "cancelled" ? 0.55 : undefined,
      }}
    >
      <div
        className={agenda ? "w-2 h-2 rounded-full shrink-0 mt-1.5" : "w-1.5 h-1.5 rounded-full shrink-0 mt-1"}
        style={{ background: color }}
      />
      <div className="min-w-0 flex-1">
        {/* break-words (not truncate) so class names like "Fundamentals BJJ"
            wrap to two lines on narrow viewports instead of cutting off. */}
        <p
          className={[
            agenda ? "text-sm font-semibold leading-tight break-words" : "text-[11px] font-semibold leading-tight break-words",
            state === "cancelled" ? "line-through" : "",
          ].join(" ")}
          style={{ color: "var(--tx-1)" }}
        >
          {cls.name}
        </p>
        <p className={agenda ? "text-xs mt-0.5 flex items-center gap-1.5 flex-wrap" : "text-[10px] mt-0.5 flex items-center gap-1 flex-wrap"} style={{ color: "var(--tx-3)" }}>
          <span>{startTime}{cls.duration != null && ` · ${cls.duration}m`}</span>
          {cls.isKids && (
            <span
              className="inline-flex items-center rounded-full px-1.5 font-bold uppercase tracking-wide leading-4 text-[9px]"
              style={{ background: "var(--sf-2)", border: "1px solid var(--bd-default)", color: "var(--tx-2)" }}
            >
              Kids
            </span>
          )}
          {classCategoryTag(cls) && (
            <span
              data-testid="class-chip-category"
              className="inline-flex items-center rounded-full px-1.5 font-semibold tracking-wide leading-4 text-[9px]"
              style={{ background: "var(--sf-2)", border: "1px solid var(--bd-default)", color: "var(--tx-2)" }}
            >
              {classCategoryTag(cls)}
            </span>
          )}
          {showState && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-1.5 font-bold uppercase tracking-wide leading-4 text-[9px]"
              style={{
                background: stateTint ? `color-mix(in srgb, ${stateTint} 14%, transparent)` : "var(--sf-2)",
                border: `1px solid ${stateTint ? `color-mix(in srgb, ${stateTint} 45%, transparent)` : "var(--bd-default)"}`,
                color: stateInk,
              }}
            >
              {state === "live" && (
                <span
                  aria-hidden="true"
                  className="w-1.5 h-1.5 rounded-full motion-safe:animate-pulse"
                  style={{ background: "var(--hue-success)" }}
                />
              )}
              {sessionStateLabel(state)}
            </span>
          )}
        </p>
      </div>
    </button>
  );
}

/**
 * Today's states for one day column of the template: the owner's own device
 * clock, the same rule as the member's day view (lib/schedule-state.ts).
 * Returns `null` for any day that is not today.
 */
export function chipStatesFor(
  classes: ClassRow[],
  dow: number,
  isToday: boolean,
  cancelledToday: ReadonlySet<string> = new Set(),
  now: Date = new Date(),
): (SessionState | null)[] {
  if (!isToday) return classes.map(() => null);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  // Lane 3 D6: the template alone showed a called-off session as LIVE. Today's
  // instances (from /api/coach/today) mark a cancelled one, keyed on
  // class + start time, and lib/schedule-state decides cancellation FIRST —
  // so it reads "Cancelled", never Live or Next.
  const spans = classes.map((cls) => {
    const slot = cls.schedules.find((sc) => sc.dayOfWeek === dow);
    const startTime = slot?.startTime ?? "00:00";
    return {
      ...spanMinutes(startTime, slot?.endTime ?? "00:00"),
      cancelled: cancelledToday.has(`${cls.id}|${startTime}`),
    };
  });
  return sessionStates(spans, nowMin, true);
}

function getWeekDates(offset: number): Date[] {
  const now = new Date();
  const dow = now.getDay();
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - ((dow + 6) % 7) + offset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function fmtWeekLabel(dates: Date[]): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const start = dates[0].toLocaleDateString("en-GB", opts);
  const end = dates[6].toLocaleDateString("en-GB", opts);
  return `${start} – ${end}`;
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onAdd, primaryColor, canManage }: { onAdd: () => void; primaryColor: string; canManage: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div
        className="w-16 h-16 rounded-3xl flex items-center justify-center mb-4"
        style={{ background: hex(primaryColor, 0.1) }}
      >
        <Calendar className="w-8 h-8" style={{ color: primaryColor }} />
      </div>
      <h3 className="font-semibold text-lg mb-1" style={{ color: "var(--tx-1)" }}>No classes yet</h3>
      <p className="text-sm mb-6 max-w-xs" style={{ color: "var(--tx-3)" }}>
        {canManage
          ? "Add your first class to start building your timetable."
          : "No classes yet — an owner or manager can add the first one."}
      </p>
      {/* Audit R5: POST /api/classes is owner|manager — don't offer the CTA
          to roles whose save would 403 (the header button was already gated;
          this empty state wasn't). */}
      {canManage && (
        <Button onClick={onAdd}>
          <Plus className="size-4" />
          Add class
        </Button>
      )}
    </div>
  );
}

// ─── Class card ───────────────────────────────────────────────────────────────

function ClassCard({
  cls,
  primaryColor,
  onEdit,
  onPause,
  onArchive,
  onGenerate,
  generating,
  canManage,
}: {
  cls: ClassRow;
  primaryColor: string;
  onEdit: (c: ClassRow) => void;
  /** T6b: take it off the timetable for now (reversible). */
  onPause: (c: ClassRow) => void;
  /** T6b: remove it from the timetable and lists (history kept, restorable). */
  onArchive: (c: ClassRow) => void;
  onGenerate: (id: string) => void;
  /** True while THIS class's instance generation is in flight. */
  generating: boolean;
  canManage: boolean;
}) {
  const color = cls.color ?? primaryColor;

  return (
    <div
      className="rounded-2xl border p-4 transition-all"
      style={{ background: "var(--sf-1)", borderColor: hex(color, 0.25) }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
          <div className="min-w-0">
            <h3 className="font-semibold text-sm truncate" style={{ color: "var(--tx-1)" }}>{cls.name}</h3>
            {cls.description && (
              <p className="text-xs mt-0.5 line-clamp-1" style={{ color: "var(--tx-3)" }}>{cls.description}</p>
            )}
          </div>
        </div>
        {canManage && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => onGenerate(cls.id)}
              disabled={generating}
              aria-busy={generating || undefined}
              className="w-7 h-7 rounded-[var(--r-sm)] flex items-center justify-center transition-colors hover:bg-sf-2 hover:text-[var(--hue-info)] disabled:opacity-50 disabled:pointer-events-none"
              style={{ color: "var(--tx-3)" }}
              title="Generate schedule instances"
              aria-label={`Generate schedule instances for ${cls.name}`}
            >
              <RefreshCw className={`w-3.5 h-3.5${generating ? " animate-spin" : ""}`} />
            </button>
            <button
              onClick={() => onEdit(cls)}
              aria-label={`Edit ${cls.name}`}
              className="w-7 h-7 rounded-[var(--r-sm)] flex items-center justify-center transition-colors hover:bg-sf-2 hover:text-[var(--tx-1)]"
              style={{ color: "var(--tx-3)" }}
            >
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            {/* T6b: two lifecycle actions, both reversible, both asked first. */}
            <Button
              variant="ghost"
              size="compact"
              onClick={() => onPause(cls)}
              aria-label={`Pause ${cls.name}`}
              title="Pause: take it off the timetable for now"
              className="w-7 px-0"
            >
              <Pause className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="compact"
              onClick={() => onArchive(cls)}
              aria-label={`Archive ${cls.name}`}
              title="Archive: remove it from the timetable, keep its history"
              className="w-7 px-0"
            >
              <Archive className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap gap-2 mb-3">
        <span className="flex items-center gap-1 text-xs" style={{ color: "var(--tx-3)" }}>
          <Clock className="w-3 h-3" />
          {cls.duration != null ? `${cls.duration} min` : "Length not set"}
        </span>
        {(cls.coachUser?.name ?? cls.coachName) && (
          <span className="text-xs" style={{ color: "var(--tx-3)" }}>· {cls.coachUser?.name ?? cls.coachName}</span>
        )}
        {cls.location && (
          <span className="flex items-center gap-1 text-xs" style={{ color: "var(--tx-3)" }}>
            <MapPin className="w-3 h-3" />
            {cls.location}
          </span>
        )}
        {cls.maxCapacity && (
          <span className="flex items-center gap-1 text-xs" style={{ color: "var(--tx-3)" }}>
            <Users className="w-3 h-3" />
            Max {cls.maxCapacity}
          </span>
        )}
        {cls.isKids && (
          <span
            className="flex items-center text-xs px-2 py-0.5 rounded-full font-semibold"
            style={{ background: "var(--sf-2)", border: "1px solid var(--bd-default)", color: "var(--tx-2)" }}
          >
            Kids
          </span>
        )}
        {classCategoryTag(cls) && (
          // T6c: what kind of class this is. Absent = uncategorised.
          <span
            className="flex items-center text-xs px-2 py-0.5 rounded-full font-medium"
            style={{ background: "var(--sf-2)", border: "1px solid var(--bd-default)", color: "var(--tx-2)" }}
            data-testid="class-card-category"
          >
            {classCategoryTag(cls)}
          </span>
        )}
        {cls.allowedTiers && cls.allowedTiers.length > 0 && (
          // T6a: who the class is for. Absent = everyone.
          <span
            className="flex items-center text-xs px-2 py-0.5 rounded-full"
            style={{ background: "var(--sf-2)", border: "1px solid var(--bd-default)", color: "var(--tx-2)" }}
            data-testid="class-card-tiers"
            title="Memberships that include this class"
          >
            For: {cls.allowedTiers.map((t) => t.name).join(", ")}
          </span>
        )}
        {cls.requiredRank && (
          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full" style={{ background: hex(cls.requiredRank.color ?? primaryColor, 0.15), color: cls.requiredRank.color ?? primaryColor }}>
            <Tag className="w-2.5 h-2.5" />
            {cls.requiredRank.name}+
          </span>
        )}
        {cls.maxRank && (
          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full" style={{ background: hex(cls.maxRank.color ?? primaryColor, 0.15), color: cls.maxRank.color ?? primaryColor }}>
            <Tag className="w-2.5 h-2.5" />
            ≤ {cls.maxRank.name}
          </span>
        )}
      </div>

      {/* Schedule chips */}
      {cls.schedules.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {cls.schedules.map((s) => (
            <span
              key={s.id}
              className="text-xs px-2.5 py-1 rounded-lg font-medium"
              style={{ background: hex(color, 0.12), color: color }}
            >
              {DAYS[s.dayOfWeek]} {s.startTime}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs italic" style={{ color: "var(--tx-4)" }}>No schedule set</p>
      )}
    </div>
  );
}

// ─── Paused and archived (T6b) ────────────────────────────────────────────────

/**
 * The classes that are off the timetable, with the one action that brings
 * each back. Paused: Resume (and Archive, to remove it for good). Archived:
 * Restore. Owner and manager only — the caller renders it under `canManage`.
 * The rows come from the server render, so an empty list is the true state,
 * never a failed read (a failed read throws to the segment error boundary).
 */
function InactiveClassList({
  classes,
  busyId,
  onRestore,
  onArchive,
}: {
  classes: ClassRow[];
  busyId: string | null;
  onRestore: (c: ClassRow) => void;
  onArchive: (c: ClassRow) => void;
}) {
  if (classes.length === 0) return null;
  const paused = classes.filter((c) => c.lifecycle !== "archived");
  const archived = classes.filter((c) => c.lifecycle === "archived");
  const group = (title: string, rows: ClassRow[], hint: string) =>
    rows.length === 0 ? null : (
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-tx-3 mb-1">
          {title} ({rows.length})
        </h3>
        <p className="text-xs text-tx-4 mb-2">{hint}</p>
        <ul className="space-y-2">
          {rows.map((cls) => {
            const isArchived = cls.lifecycle === "archived";
            return (
              <li
                key={cls.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-bd-default bg-sf-1 px-3 py-2"
                data-testid={`inactive-class-${cls.id}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-tx-1 break-words">
                    {cls.name}{" "}
                    <span className="ml-1 inline-flex items-center rounded-full border border-bd-default bg-sf-2 px-1.5 text-[10px] font-bold uppercase tracking-wide text-tx-2">
                      {isArchived ? "Archived" : "Paused"}
                    </span>
                  </p>
                  <p className="text-xs text-tx-3">
                    {cls.schedules.length > 0
                      ? cls.schedules.map((s) => `${DAYS[s.dayOfWeek]} ${s.startTime}`).join(" · ")
                      : "No schedule set"}
                    {isArchived && cls.archivedAt
                      ? ` · archived ${new Date(cls.archivedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`
                      : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!isArchived && (
                    <Button
                      variant="ghost"
                      size="compact"
                      onClick={() => onArchive(cls)}
                      disabled={busyId === cls.id}
                      aria-label={`Archive ${cls.name}`}
                    >
                      <Archive className="size-3.5" />
                      Archive
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="compact"
                    onClick={() => onRestore(cls)}
                    loading={busyId === cls.id}
                    aria-label={`${isArchived ? "Restore" : "Resume"} ${cls.name}`}
                  >
                    {isArchived ? <ArchiveRestore className="size-3.5" /> : <Play className="size-3.5" />}
                    {isArchived ? "Restore" : "Resume"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );
  return (
    <section aria-labelledby="inactive-classes-heading" className="mt-8 space-y-4" data-testid="inactive-classes">
      <h2 id="inactive-classes-heading" className="font-semibold text-sm text-tx-1">
        Paused and archived
      </h2>
      {group(
        "Paused",
        paused,
        "Off the timetable, the member app, booking and the kiosk. No new sessions are made. Bookings and history are kept.",
      )}
      {group(
        "Archived",
        archived,
        "Removed from the timetable and lists. Check-ins stay in reports. Restoring puts it back on the timetable.",
      )}
    </section>
  );
}

/** The counted confirmation for an archive (T6b): what is kept, in numbers. */
export function archiveConfirmBody(
  counts: { attendanceCount: number; rosterCount: number; bookingCount: number },
  lifecycle?: ClassRow["lifecycle"],
): string {
  const kept: string[] = [];
  const nonZero = [counts.attendanceCount, counts.rosterCount, counts.bookingCount].filter((n) => n > 0);
  if (counts.attendanceCount > 0) kept.push(plural(counts.attendanceCount, "check-in", "check-ins"));
  if (counts.rosterCount > 0) kept.push(`${plural(counts.rosterCount, "member", "members")} on its roster`);
  if (counts.bookingCount > 0) kept.push(plural(counts.bookingCount, "booking", "bookings"));
  // "Its 1 check-in is kept", "Its 2 bookings are kept", "Its 1 check-in, 1 booking are kept".
  const verb = nonZero.length === 1 && nonZero[0] === 1 ? "is" : "are";
  const keeps = kept.length > 0 ? ` Its ${kept.join(", ")} ${verb} kept.` : " It has no check-ins, roster or bookings yet.";
  // A paused class is already off the timetable and gets no new sessions.
  const lead = lifecycle === "paused"
    ? "It moves from Paused to Archived."
    : "It comes off the timetable, the member app, booking and the kiosk, and no new sessions are made.";
  return (
    lead +
    keeps +
    " Check-ins stay in reports. You can restore it from Paused and archived, or undo this from Activity."
  );
}

/**
 * The timetable row for a class POST /api/classes just created. The response
 * carries `allowedTiers` ({id, name, isActive}); a response without it (an
 * older server) is mapped from `allowedTierIds` against the club's tiers, so
 * the row's "For: …" chip and the form reopened on it never read as
 * "Everyone" for a class that is restricted.
 */
export function createdClassRow(
  created: ClassRow & { allowedTierIds?: string[] },
  membershipTiers: readonly TierOption[],
): ClassRow {
  const { allowedTierIds, ...row } = created;
  if (Array.isArray(row.allowedTiers)) return row;
  const ids = allowedTierIds ?? [];
  return {
    ...row,
    allowedTiers: ids.map((id) => membershipTiers.find((t) => t.id === id)).filter((t): t is TierOption => !!t),
  };
}

// ─── Schedule row input ───────────────────────────────────────────────────────

function timeToMins(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function addMins(t: string, mins: number) {
  const total = timeToMins(t) + mins;
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

type RowMode = "end" | "duration";

/**
 * Lane 3 D3: the class Duration and a day's end time could disagree — editing
 * only Duration (60 → 90) saved 90 while Tuesday stayed 20:00–21:00, so the
 * timetable card said "90m" and the register said 20:00–21:00. When Duration
 * changes, every row in DURATION mode (F-13's default) moves its end to
 * start + duration; a row the desk switched to END mode keeps the end it was
 * given. Exported for the unit test.
 */
export function applyClassDuration(
  schedules: ScheduleInput[],
  modes: RowMode[],
  mins: number,
): ScheduleInput[] {
  if (!Number.isInteger(mins) || mins < 1 || mins > 480) return schedules;
  return schedules.map((s, i) =>
    (modes[i] ?? "duration") === "duration" && s.startTime
      ? { ...s, endTime: addMins(s.startTime, mins) }
      : s,
  );
}

function ScheduleRow({
  sched,
  mode,
  onModeChange,
  onChange,
  onRemove,
}: {
  sched: ScheduleInput;
  mode: RowMode;
  onModeChange: (m: RowMode) => void;
  onChange: (s: ScheduleInput) => void;
  onRemove: () => void;
}) {
  // F-13: default to duration so typing a start time moves the end with it;
  // a 45-minute class no longer saves as 12:51–18:45 because the end field
  // kept an old value. The toggle still lets the desk type an explicit end.
  // The mode lives in ClassForm (D3) so a change to the class Duration can
  // move every duration-mode row's end with it.
  const setMode = (fn: (m: RowMode) => RowMode) => onModeChange(fn(mode));
  const durationMins = timeToMins(sched.endTime) - timeToMins(sched.startTime);

  function handleStartChange(val: string) {
    if (!val) return;
    if (mode === "duration") {
      onChange({ ...sched, startTime: val, endTime: addMins(val, Math.max(durationMins, 30)) });
    } else {
      onChange({ ...sched, startTime: val });
    }
  }
  function handleDurationChange(mins: number) {
    onChange({ ...sched, endTime: addMins(sched.startTime, mins) });
  }

  // --sf-2, not --sf-1: the Sheet panel is already an --sf-3 white surface, so
  // an --sf-1 block sitting on it was white-in-white and read as no block.
  return (
    <div className="p-3 rounded-[var(--r-md)] space-y-2.5" style={{ background: "var(--sf-2)" }}>
      <div className="flex items-center gap-2">
        <select
          aria-label="Day of the week"
          value={sched.dayOfWeek}
          onChange={(e) => onChange({ ...sched, dayOfWeek: Number(e.target.value) })}
          className="flex-1 bg-transparent text-sm rounded-lg px-2 py-1.5 outline-none"
          style={{ color: "var(--tx-1)", border: "1px solid var(--bd-default)", appearance: "auto" }}
        >
          {DAYS_FULL.map((d, i) => (
            <option key={i} value={i} style={{ background: "var(--sf-1)" }}>{d}</option>
          ))}
        </select>
        <button
          onClick={onRemove}
          aria-label="Remove this schedule slot"
          className="w-7 h-7 rounded-[var(--r-sm)] flex items-center justify-center shrink-0 transition-colors hover:bg-sf-2 hover:text-[var(--hue-danger)]"
          style={{ color: "var(--tx-3)" }}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1">
          <label className="text-[10px] block mb-0.5" style={{ color: "var(--tx-3)" }}>Start time</label>
          <input aria-label="Start time"
            type="time"
            value={sched.startTime}
            onChange={(e) => handleStartChange(e.target.value)}
            className="w-full bg-transparent text-sm rounded-lg px-2 py-1.5"
            style={{ color: "var(--tx-1)", border: "1px solid var(--bd-default)" }}
          />
        </div>

        {/* Mode toggle */}
        <div className="flex flex-col items-center gap-1 pt-4">
          <button
            onClick={() => setMode((m) => m === "end" ? "duration" : "end")}
            className="text-[10px] px-2 py-1 rounded border transition-colors"
            style={{ borderColor: "var(--bd-default)", color: "var(--tx-3)" }}
          >
            {mode === "end" ? "end" : "dur"}
          </button>
        </div>

        {mode === "end" ? (
          <div className="flex-1">
            <label className="text-[10px] block mb-0.5" style={{ color: "var(--tx-3)" }}>End time</label>
            <input aria-label="End time"
              type="time"
              value={sched.endTime}
              onChange={(e) => onChange({ ...sched, endTime: e.target.value })}
              className="w-full bg-transparent text-sm rounded-lg px-2 py-1.5"
              style={{ color: "var(--tx-1)", border: "1px solid var(--bd-default)" }}
            />
          </div>
        ) : (
          <div className="flex-1">
            <label className="text-[10px] block mb-0.5" style={{ color: "var(--tx-3)" }}>Duration (mins)</label>
            <input aria-label="Duration (mins)"
              type="number"
              min={15}
              max={480}
              step={15}
              value={Math.max(durationMins, 30)}
              onChange={(e) => handleDurationChange(Number(e.target.value))}
              className="w-full bg-transparent text-sm rounded-lg px-2 py-1.5"
              style={{ color: "var(--tx-1)", border: "1px solid var(--bd-default)" }}
            />
          </div>
        )}
      </div>
      {durationMins > 0 && (
        <p className="text-[10px]" style={{ color: "var(--tx-4)" }}>{durationMins} mins · ends {sched.endTime}</p>
      )}
    </div>
  );
}

// ─── Class form (add / edit) ──────────────────────────────────────────────────

/** Same set of tier ids, order ignored. */
function sameTierSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function ClassForm({
  initial,
  rankSystems,
  coachUsers,
  membershipTiers = [],
  primaryColor,
  onSave,
  onCancel,
  saving,
}: {
  initial: Partial<ClassRow> | null;
  rankSystems: RankOption[];
  coachUsers: CoachUserOption[];
  membershipTiers?: TierOption[];
  primaryColor: string;
  onSave: (data: Record<string, unknown>) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [coachName, setCoachName] = useState(initial?.coachName ?? "");
  const [coachUserId, setCoachUserId] = useState(initial?.coachUserId ?? "");
  const [location, setLocation] = useState(initial?.location ?? "");
  // ADR-001 D2: the venue. The picker only appears once the club has more
  // than one location; a single-venue club never sees it.
  const [locationId, setLocationId] = useState(initial?.locationId ?? "");
  const [venues, setVenues] = useState<{ id: string; name: string; isDefault: boolean }[]>([]);
  // UI-RULES §7: a failed read is said, not shown as "one venue".
  const [venuesError, setVenuesError] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/locations");
        if (!r.ok) { if (alive) setVenuesError(true); return; }
        const d = (await r.json()) as { locations?: { id: string; name: string; isDefault: boolean }[] };
        if (alive && d.locations) setVenues(d.locations);
      } catch {
        if (alive) setVenuesError(true);
      }
    })();
    return () => { alive = false; };
  }, []);
  const [duration, setDuration] = useState(String(initial?.duration ?? 60));
  const [maxCapacity, setMaxCapacity] = useState(String(initial?.maxCapacity ?? ""));
  const [isKids, setIsKids] = useState<boolean>(initial?.isKids ?? false);
  // T6c: "" = uncategorised (sent as null).
  const initialCategory = initial?.category ?? "";
  const [category, setCategory] = useState<string>(initialCategory);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [requiredRankId, setRequiredRankId] = useState(initial?.requiredRankId ?? "");
  const [maxRankId, setMaxRankId] = useState(initial?.maxRankId ?? "");
  // Task 12: per-class roster (mutually exclusive with rank gates).
  // useRoster=true switches the form into "comp class" mode: rank pickers hide,
  // member checkbox list appears. Server enforces mutual exclusion in PATCH too.
  const [useRoster, setUseRoster] = useState<boolean>(
    Boolean(initial?.roster && initial.roster.length > 0),
  );
  const [rosterMemberIds, setRosterMemberIds] = useState<string[]>(
    initial?.roster?.map((r: { memberId: string }) => r.memberId) ?? [],
  );
  const [availableMembers, setAvailableMembers] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  // RULES §2: a failed fetch is not an empty state. Before, a 500 from
  // /api/members rendered "No members available. Add members first." — which
  // reads as a gym with no members and invites the operator to re-add them.
  const [membersError, setMembersError] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  // T6a "Who can attend": none ticked = everyone (the class stays open).
  const [allowedTierIds, setAllowedTierIds] = useState<string[]>(
    initial?.allowedTiers?.map((t) => t.id) ?? [],
  );
  const initialTierIds = (initial?.allowedTiers ?? []).map((t) => t.id);
  // A deactivated tier still attached is shown read-only (it still admits its
  // members); one that is not attached is not offered.
  const tierChoices = [
    ...membershipTiers.filter((t) => t.isActive),
    ...membershipTiers.filter((t) => !t.isActive && initialTierIds.includes(t.id)),
    // An attached tier the club list did not return (should not happen) is kept visible.
    ...(initial?.allowedTiers ?? []).filter((t) => !membershipTiers.some((m) => m.id === t.id)),
  ];
  function toggleTier(id: string) {
    setAllowedTierIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  const [color, setColor] = useState(initial?.color ?? CLASS_COLORS[0]);
  const [schedules, setSchedules] = useState<ScheduleInput[]>(
    initial?.schedules?.map((s) => ({ dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime })) ?? []
  );

  // One mode per schedule row, parallel to `schedules` (D3).
  const [rowModes, setRowModes] = useState<RowMode[]>(() => schedules.map(() => "duration"));

  function addSchedule() {
    // F-13: the class Duration and a day's end time used to disagree (a 60-min
    // class saved as 09:58–19:00). A new day starts from the duration.
    const mins = Number.parseInt(duration, 10);
    const len = Number.isInteger(mins) && mins >= 1 && mins <= 480 ? mins : 60;
    setSchedules((prev) => [...prev, { dayOfWeek: 1, startTime: "18:00", endTime: addMins("18:00", len) }]);
    setRowModes((prev) => [...prev, "duration"]);
  }

  function updateSchedule(i: number, s: ScheduleInput) {
    setSchedules((prev) => prev.map((x, idx) => (idx === i ? s : x)));
  }

  function removeSchedule(i: number) {
    setSchedules((prev) => prev.filter((_, idx) => idx !== i));
    setRowModes((prev) => prev.filter((_, idx) => idx !== i));
  }

  function changeDuration(value: string) {
    setDuration(value);
    setSchedules((prev) => applyClassDuration(prev, rowModes, Number.parseInt(value, 10)));
  }

  // Noe, 18 Sep 10:06: "all minimum criteria should be filled in." The
  // minimum is a name, a real duration, and at least one day with both
  // times. `parseInt(duration) || 60` used to paper over a cleared duration
  // with 60; a blank is now a blank, and the sentence above the button says
  // which item is missing. The server enforces the same minimum
  // (lib/schemas/class.ts), so this is the honest half, not the only half.
  const durationNum = Number.parseInt(duration, 10);
  const durationOk = Number.isInteger(durationNum) && durationNum >= 1 && durationNum <= 480;
  const missing: string[] = [];
  if (!name.trim()) missing.push("Class Name");
  if (!durationOk) missing.push("Duration (1–480 minutes)");
  if (schedules.length === 0) missing.push("at least one day");
  else if (schedules.some((s) => !s.startTime || !s.endTime)) missing.push("a start and end time on every day");
  const canSubmit = missing.length === 0;

  function submit() {
    if (!canSubmit) return;
    onSave({
      name: name.trim(),
      // When a User is selected, that's authoritative; coachName is the legacy
      // free-text fallback for clubs that haven't put their coaches in Users yet.
      coachName: coachName.trim() || null,
      coachUserId: coachUserId || null,
      location: location.trim() || null,
      locationId: locationId || null,
      duration: durationNum,
      maxCapacity: maxCapacity ? parseInt(maxCapacity) : null,
      isKids,
      // T6c: sent on create, and on edit only when changed, so an unrelated
      // edit never rewrites it. "" (Uncategorised) clears it to null.
      ...(!initial?.id || category !== initialCategory ? { category: category || null } : {}),
      description: description.trim() || null,
      requiredRankId: useRoster ? null : (requiredRankId || null),
      maxRankId: useRoster ? null : (maxRankId || null),
      // Task 12: roster array is sent when in comp-class mode. Server clears
      // requiredRankId/maxRankId on the row to enforce mutual exclusion.
      roster: useRoster ? rosterMemberIds.map((id) => ({ memberId: id })) : undefined,
      // T6a: [] = everyone. Sent on create, and on edit only when changed, so
      // an unrelated edit never rewrites the list; clearing every tick sends
      // [] and reopens the class.
      ...(!initial?.id || !sameTierSet(allowedTierIds, initialTierIds) ? { allowedTierIds } : {}),
      color,
      schedules,
    });
  }

  const loadMembers = useCallback(async () => {
    setMembersLoading(true);
    setMembersError(false);
    try {
      // `take=200` was silently clamped to the route's maxTake of 100 with no
      // flag, so on a club with more than 100 members this roster picker
      // quietly offered only the first page — a member simply could not be
      // added to a class. This is a multi-select over everyone, not a search
      // box, so the fix is to follow the cursor rather than push a filter down.
      // Bounded so a pathological tenant cannot spin here forever.
      const MAX_PAGES = 12; // 12 × 100 = 1,200 members
      const collected: Array<{ id: string; name: string; email: string }> = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res: Response = await fetch(
          // T6d: training members only — a guardian account (or an import's
          // guardian draft) is never offered as a squad member.
          `/api/members?take=100&population=training${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: { members?: Array<{ id: string; name: string; email: string }>; nextCursor?: string | null } =
          await res.json();
        const list = Array.isArray(data) ? data : data.members ?? [];
        collected.push(
          ...list.map((m: { id: string; name: string; email: string }) => ({ id: m.id, name: m.name, email: m.email })),
        );
        cursor = data.nextCursor ?? null;
        if (!cursor) break;
      }
      setAvailableMembers(collected);
    } catch {
      setMembersError(true);
    } finally {
      setMembersLoading(false);
    }
  }, []);

  // A class that already HAS a roster now opens the form in roster mode (the
  // page finally selects rosterMembers), so the member list has to load without
  // waiting for the picker button that used to be its only trigger — otherwise
  // the operator reads "3 selected" above an empty list.
  useEffect(() => {
    if (useRoster && availableMembers.length === 0 && !membersLoading && !membersError) {
      void loadMembers();
    }
  }, [useRoster, availableMembers.length, membersLoading, membersError, loadMembers]);

  function openRosterPicker() {
    setUseRoster(true);
    // Wipe rank gates client-side so the form reflects the mutual-exclusion contract.
    setRequiredRankId("");
    setMaxRankId("");
  }

  function closeRosterPicker() {
    setUseRoster(false);
    setRosterMemberIds([]);
  }

  function toggleRosterMember(id: string) {
    setRosterMemberIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  // Base input classes — border and focus handled via inline style + onFocus/onBlur
  const inputCls = "w-full bg-transparent rounded-xl px-3 py-2.5 text-sm outline-none placeholder:text-[var(--tx-3)] transition-colors";
  const inputStyle = { color: "var(--tx-1)", border: "1px solid var(--bd-default)" };
  const focusHandlers = {
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = "var(--bd-active)";
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = "var(--bd-default)";
    },
  };

  return (
    <div className="space-y-4">
      {/* Noe 2026-09-18: star what the API actually requires (name, duration)
          so a blank optional field is never mistaken for the reason a save
          failed. A schedule is optional to the API; its empty state says
          what leaving it empty costs. */}
      <p className="text-[11px]" style={{ color: "var(--tx-4)" }}>* required — everything else is optional</p>

      {/* Name */}
      <div>
        <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Class Name *</label>
        <input aria-label="Class Name"
          aria-required="true"
          className={inputCls}
          style={inputStyle}
          placeholder="e.g. Beginner BJJ"
          value={name}
          onChange={(e) => setName(e.target.value)}
          {...focusHandlers}
        />
      </div>

      {/* T6c: Category */}
      <div>
        <label htmlFor="class-category" className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Category</label>
        <Select
          id="class-category"
          aria-label="Category"
          aria-describedby="class-category-hint"
          className="w-full"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          data-testid="class-category-select"
        >
          <option value="">Uncategorised</option>
          {CLASS_CATEGORIES.map((key) => (
            <option key={key} value={key}>{CLASS_CATEGORY_LABELS[key]}</option>
          ))}
        </Select>
        <p id="class-category-hint" className="text-[11px] mt-1" style={{ color: "var(--tx-3)" }}>
          Shown on the timetable, the members&rsquo; schedule and the kiosk. It does not change who can attend.
        </p>
      </div>

      {/* Coach + Location */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Coach</label>
          {coachUsers.length > 0 ? (
            <select
              aria-label="Coach"
              className={inputCls}
              style={{ ...inputStyle, appearance: "auto" }}
              value={coachUserId}
              onChange={(e) => setCoachUserId(e.target.value)}
              {...focusHandlers}
            >
              <option value="" style={{ background: "var(--sf-1)" }}>
                Free-text (use coach name below)
              </option>
              {coachUsers.map((u) => (
                <option key={u.id} value={u.id} style={{ background: "var(--sf-1)" }}>
                  {u.name} ({u.role})
                </option>
              ))}
            </select>
          ) : (
            <p className="text-xs py-2.5" style={{ color: "var(--tx-3)" }}>No staff users yet — using free-text coach name below.</p>
          )}
          <input
            aria-label={coachUserId ? "Coach name override" : "Coach name"}
            className={inputCls + " mt-2"}
            style={inputStyle}
            placeholder={coachUserId ? "Override (optional)" : "Coach Mike"}
            value={coachName}
            onChange={(e) => setCoachName(e.target.value)}
            {...focusHandlers}
          />
        </div>
        <div>
          <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Location</label>
          <input aria-label="Location"
            className={inputCls}
            style={inputStyle}
            placeholder="Mat 1"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            {...focusHandlers}
          />
        </div>
      </div>

      {venuesError && (
        <p className="text-xs" style={{ color: "var(--hue-warning-ink)" }} role="alert">
          Could not load the club&rsquo;s venues — the class keeps its current venue.
        </p>
      )}
      {venues.length > 1 && (
        <div>
          <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Venue</label>
          <Select aria-label="Venue" value={locationId} onChange={(e) => setLocationId(e.target.value)} className="w-full">
            <option value="">Every location</option>
            {venues.map((v) => (
              <option key={v.id} value={v.id}>{v.name}{v.isDefault ? " (default)" : ""}</option>
            ))}
          </Select>
        </div>
      )}

      {/* Duration + Capacity */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Duration (mins) *</label>
          <input aria-label="Duration (mins)"
            aria-required="true"
            type="number"
            className={inputCls}
            style={inputStyle}
            placeholder="60"
            value={duration}
            onChange={(e) => changeDuration(e.target.value)}
            min={1}
            max={480}
            {...focusHandlers}
          />
        </div>
        <div>
          <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Max Capacity</label>
          <input aria-label="Max Capacity"
            type="number"
            className={inputCls}
            style={inputStyle}
            placeholder="Unlimited"
            value={maxCapacity}
            onChange={(e) => setMaxCapacity(e.target.value)}
            min={1}
            {...focusHandlers}
          />
        </div>
      </div>

      {/* Kids class */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <label htmlFor="class-is-kids" className="text-xs font-medium block" style={{ color: "var(--tx-2)" }}>Kids class</label>
          <p id="class-is-kids-hint" className="text-[11px] mt-0.5" style={{ color: "var(--tx-3)" }}>
            Adults can&rsquo;t check themselves in. The register asks before marking an adult in.
          </p>
        </div>
        <Switch
          id="class-is-kids"
          checked={isKids}
          onCheckedChange={setIsKids}
          aria-label="Kids class"
          aria-describedby="class-is-kids-hint"
        />
      </div>

      {/* T6a: Who can attend — the memberships that include this class. */}
      <fieldset className="space-y-2" aria-describedby="class-tiers-hint">
        <legend className="text-xs font-medium" style={{ color: "var(--tx-2)" }}>Who can attend</legend>
        <p id="class-tiers-hint" className="text-[11px]" style={{ color: "var(--tx-3)" }}>
          {useRoster
            ? "This class has a roster, so the roster decides who can attend. Memberships ticked here apply only if the roster is removed."
            : allowedTierIds.length === 0
              ? "Everyone — any member can book and check in. Tick memberships to limit this class to them."
              : "Only members on the ticked memberships can book or check themselves in. The register and card scanner ask before admitting anyone else."}
        </p>
        {tierChoices.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--tx-3)" }}>
            No memberships set up yet — the class is open to everyone. Add memberships under Memberships to limit who can attend.
          </p>
        ) : (
          <div className="space-y-1" role="group" aria-label="Memberships that include this class">
            {tierChoices.map((t) => {
              const checked = allowedTierIds.includes(t.id);
              const readOnly = !t.isActive;
              const id = `class-tier-${t.id}`;
              return (
                <div key={t.id} className="flex items-center gap-2 rounded px-2 py-1.5">
                  <Checkbox
                    id={id}
                    checked={checked}
                    disabled={readOnly}
                    onCheckedChange={() => toggleTier(t.id)}
                    aria-label={t.name}
                  />
                  <label htmlFor={id} className="text-xs" style={{ color: readOnly ? "var(--tx-3)" : "var(--tx-2)" }}>
                    {t.name}
                    {readOnly && " (deactivated — still admits its members)"}
                  </label>
                </div>
              );
            })}
          </div>
        )}
      </fieldset>

      {/* Description */}
      <div>
        <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Description</label>
        <textarea aria-label="Description"
          className={inputCls + " resize-none"}
          style={inputStyle}
          placeholder="Optional class description..."
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          {...focusHandlers}
        />
      </div>

      {/* Required + Max Rank — hidden when roster mode is on (mutually exclusive) */}
      {rankSystems.length > 0 && !useRoster && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Required Rank (min)</label>
            <select aria-label="Required Rank (min)"
              className={inputCls}
              style={{ ...inputStyle, appearance: "auto" }}
              value={requiredRankId}
              onChange={(e) => setRequiredRankId(e.target.value)}
              {...focusHandlers}
            >
              <option value="" style={{ background: "var(--sf-1)" }}>No requirement</option>
              {rankSystems.map((r) => (
                <option key={r.id} value={r.id} style={{ background: "var(--sf-1)" }}>
                  {r.discipline} — {r.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Max Rank (cap)</label>
            <select aria-label="Max Rank (cap)"
              className={inputCls}
              style={{ ...inputStyle, appearance: "auto" }}
              value={maxRankId}
              onChange={(e) => setMaxRankId(e.target.value)}
              {...focusHandlers}
            >
              <option value="" style={{ background: "var(--sf-1)" }}>No cap</option>
              {rankSystems.map((r) => (
                <option key={r.id} value={r.id} style={{ background: "var(--sf-1)" }}>
                  {r.discipline} — {r.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Task 12: Comp-class roster picker (mutually exclusive with rank gates). */}
      {!useRoster && (
        <button
          type="button"
          onClick={openRosterPicker}
          className="text-xs underline underline-offset-2 transition-colors hover:text-[var(--tx-1)]"
          style={{ color: "var(--tx-3)" }}
        >
          + Select specific people (comp class)
        </button>
      )}
      {useRoster && (
        <div className="rounded-xl border p-3 space-y-2" style={{ borderColor: "var(--bd-default)" }}>
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium" style={{ color: "var(--tx-3)" }}>Comp class roster</label>
            <button
              type="button"
              onClick={closeRosterPicker}
              className="text-xs underline underline-offset-2 transition-colors hover:text-[var(--tx-1)]"
              style={{ color: "var(--tx-3)" }}
            >
              Switch back to rank gate
            </button>
          </div>
          <p className="text-[11px]" style={{ color: "var(--tx-3)" }}>
            Only the members ticked below can attend or check in. Rank requirements are ignored when roster is set.
          </p>
          <input aria-label="Search by name or email"
            className={inputCls}
            style={inputStyle}
            placeholder="Search by name or email"
            value={memberSearch}
            onChange={(e) => setMemberSearch(e.target.value)}
            {...focusHandlers}
          />
          <div className="max-h-48 overflow-y-auto space-y-1">
            {membersLoading && <p className="text-xs" style={{ color: "var(--tx-3)" }}>Loading members…</p>}
            {!membersLoading && membersError && (
              <div className="space-y-2">
                <p className="text-xs" style={{ color: "var(--hue-danger)" }}>
                  Couldn&apos;t load the member list. The count below is the roster already saved on this class — saving now keeps it.
                </p>
                <Button variant="secondary" size="compact" onClick={loadMembers}>
                  Try again
                </Button>
              </div>
            )}
            {!membersLoading && !membersError && availableMembers.length === 0 && (
              <p className="text-xs" style={{ color: "var(--tx-3)" }}>
                No members yet. Add members to the club and they&apos;ll appear here to tick.
              </p>
            )}
            {availableMembers
              .filter((m) => {
                const q = memberSearch.trim().toLowerCase();
                if (!q) return true;
                return m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q);
              })
              .map((m) => {
                const checked = rosterMemberIds.includes(m.id);
                return (
                  <label key={m.id} className="flex items-center gap-2 text-xs cursor-pointer rounded px-2 py-1 hover:bg-sf-2" style={{ color: "var(--tx-2)" }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRosterMember(m.id)}
                      className="accent-[var(--color-primary)]"
                    />
                    <span>{m.name}</span>
                    <span style={{ color: "var(--tx-3)" }}>{m.email}</span>
                  </label>
                );
              })}
          </div>
          {!membersLoading && !membersError && availableMembers.length > 0 && (() => {
            // T6d: the picker lists training members only. Someone already on
            // the roster who is a guardian account (an import's guardian draft,
            // say) is no longer in that list, so they are shown here, by name,
            // where they can be unticked rather than kept invisibly.
            const listed = new Set(availableMembers.map((m) => m.id));
            const unlisted = rosterMemberIds.filter((id) => !listed.has(id));
            if (unlisted.length === 0) return null;
            const names = new Map((initial?.roster ?? []).map((r) => [r.memberId, r.name]));
            return (
              <div className="space-y-1" data-testid="roster-unlisted">
                <p className="text-[11px]" style={{ color: "var(--tx-3)" }}>
                  Already on the roster but not in the list above (usually a parent or guardian account, which is not a training member):
                </p>
                {unlisted.map((id) => {
                  const inputId = `roster-unlisted-${id}`;
                  const label = names.get(id) ?? "Member not listed";
                  return (
                    <div key={id} className="flex items-center gap-2 text-xs rounded px-2 py-1 hover:bg-sf-2" style={{ color: "var(--tx-2)" }}>
                      <Checkbox
                        id={inputId}
                        checked
                        onCheckedChange={() => toggleRosterMember(id)}
                        aria-label={label}
                      />
                      <label htmlFor={inputId} className="cursor-pointer">{label}</label>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <p className="text-[11px]" style={{ color: "var(--tx-3)" }}>{rosterMemberIds.length} selected</p>
        </div>
      )}

      {/* Color */}
      <div>
        <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Colour</label>
        <div className="flex gap-2 flex-wrap">
          {CLASS_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              aria-label={`Class colour ${c}`}
              aria-pressed={color === c}
              className="w-7 h-7 rounded-full transition-all"
              style={{
                background: c,
                // §4a.5: the selection halo used a literal `white` gap ring,
                // which on the white drawer surface read as no ring at all
                // once the swatch itself was pale. The gap is the surface
                // token, so it stays a gap on whatever the drawer is.
                boxShadow: color === c ? `0 0 0 2px var(--sf-3), 0 0 0 4px ${c}` : "none",
              }}
            />
          ))}
        </div>
      </div>

      {/* Schedules */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-medium" style={{ color: "var(--tx-3)" }}>Recurring Schedule *</label>
          <button
            onClick={addSchedule}
            className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-[var(--r-sm)]"
            style={{ background: hex(primaryColor, 0.15), color: primaryColor }}
          >
            <Plus className="w-3 h-3" />
            Add day
          </button>
        </div>
        {schedules.length === 0 ? (
          <p className="text-xs italic" style={{ color: "var(--tx-4)" }}>No day added yet — a class with no day will not appear on the weekly timetable.</p>
        ) : (
          <div className="space-y-2">
            {schedules.map((s, i) => (
              <ScheduleRow
                key={i}
                sched={s}
                mode={rowModes[i] ?? "duration"}
                onModeChange={(m) => setRowModes((prev) => prev.map((x, idx) => (idx === i ? m : x)))}
                onChange={(u) => updateSchedule(i, u)}
                onRemove={() => removeSchedule(i)}
              />
            ))}
          </div>
        )}
        {/* D3: a day whose span differs from the class Duration says so,
            rather than silently disagreeing with the card's "90m". */}
        {durationOk &&
          schedules.map((s, i) => {
            if (!s.startTime || !s.endTime) return null;
            const { startMin, endMin } = spanMinutes(s.startTime, s.endTime);
            const span = endMin - startMin;
            if (span === durationNum) return null;
            return (
              <p key={`span-${i}`} role="note" className="mt-1.5 text-xs" style={{ color: "var(--tx-3)" }}>
                {DAYS_FULL[s.dayOfWeek]} runs {span} min — different from the class duration
              </p>
            );
          })}
      </div>

      {/* Actions — a disabled button always says why (UI-RULES §7). */}
      <div className="pt-2 space-y-2">
        {!canSubmit && (
          <p role="status" className="text-xs" style={{ color: "var(--tx-3)" }}>
            Fill in: {missing.join(", ")}.
          </p>
        )}
        <div className="flex gap-3">
          <Button variant="secondary" onClick={onCancel} className="flex-1">
            Cancel
          </Button>
          <Button onClick={submit} loading={saving} disabled={!canSubmit} className="flex-1">
            {initial?.id ? "Save changes" : "Create class"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TimetableManager({ initialClasses, initialInactiveClasses = [], rankSystems, coachUsers, membershipTiers = [], primaryColor, role, currentUserId }: Props) {
  const searchParams = useSearchParams();
  const openedFromQuery = useRef(false);
  const [classes, setClasses] = useState<ClassRow[]>(initialClasses);
  // T6b: paused and archived classes, kept whole (roster included) so Resume /
  // Restore puts the exact row back on the timetable.
  const [inactiveClasses, setInactiveClasses] = useState<ClassRow[]>(initialInactiveClasses);
  const [lifecycleBusy, setLifecycleBusy] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ClassRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  // Between md: and xl: the week grid keeps its 980px floor inside a
  // horizontal scroller, so on a tablet the page opened with Monday on the
  // left and today (Saturday, say) off-screen to the right — the one column
  // that carries the Live / Next pills. Bring it into view when the grid
  // overflows; `block: "nearest"` keeps the page's own scroll where it is.
  const todayColRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const col = todayColRef.current;
    const scroller = col?.parentElement?.parentElement;
    if (!col || !scroller || scroller.scrollWidth <= scroller.clientWidth + 1) return;
    col.scrollIntoView({ inline: "center", block: "nearest" });
  }, [weekOffset]);
  // Which day the MOBILE agenda is showing. Defaults to today so a phone opens
  // on the day the owner almost always wants, rather than on Sunday.
  const [agendaDow, setAgendaDow] = useState(() => new Date().getDay());
  const { toast: showToast } = useToast();
  const { ask, dialogProps } = useConfirmDialog();

  const canManage = ["owner", "manager"].includes(role);

  // Session F: "My classes" filter. Default ON for coaches (the role most
  // likely to want it on every load), OFF for owner/manager. Persists per-
  // browser via localStorage so the choice survives reloads.
  const MY_CLASSES_KEY = "timetable.myClassesOnly";
  const [myClassesOnly, setMyClassesOnly] = useState<boolean>(role === "coach");
  // Hydrate from localStorage on mount (avoid SSR mismatch by reading inside effect)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(MY_CLASSES_KEY);
      if (stored === "true") setMyClassesOnly(true);
      else if (stored === "false") setMyClassesOnly(false);
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem(MY_CLASSES_KEY, String(myClassesOnly)); } catch {}
  }, [myClassesOnly]);

  // Hide the toggle entirely if the current user owns zero classes — there's
  // nothing to filter to. Owners with no coachUserId assignments also don't
  // see the toggle, which keeps the header clean for non-coach owners.
  const ownedCount = currentUserId
    ? classes.filter((c) => c.coachUserId === currentUserId).length
    : 0;
  const showMyToggle = currentUserId !== null && ownedCount > 0;

  // ADR-001 D2: venue filter. Shown only when the club has more than one
  // venue; a class with no venue belongs to every venue and stays visible.
  const [venueFilter, setVenueFilter] = useState("");
  // T6c: category filter. "" = every category; UNCATEGORISED = no category.
  // Offered only once at least one class has a category.
  const [categoryFilter, setCategoryFilter] = useState("");
  const showCategoryFilter = classes.some((c) => classCategoryLabel(c.category) !== null);
  const [venueList, setVenueList] = useState<{ id: string; name: string; isDefault: boolean }[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/locations");
        if (!r.ok) return;
        const d = (await r.json()) as { locations?: { id: string; name: string; isDefault: boolean }[] };
        if (alive && d.locations) setVenueList(d.locations);
      } catch {}
    })();
    return () => { alive = false; };
  }, []);

  // D6: today's called-off sessions, keyed `classId|startTime`. A failed read
  // leaves the set empty — the chips then show the template's clock states,
  // exactly what they showed before this read existed; nothing is claimed
  // cancelled that is not.
  const [cancelledToday, setCancelledToday] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/coach/today");
        if (!r.ok) return;
        const d = (await r.json()) as unknown;
        if (!Array.isArray(d)) return;
        const keys = new Set<string>();
        for (const s of d as { classId?: string; startTime?: string; isCancelled?: boolean }[]) {
          if (s.isCancelled && s.classId && s.startTime) keys.add(`${s.classId}|${s.startTime}`);
        }
        if (alive) setCancelledToday(keys);
      } catch {}
    })();
    return () => { alive = false; };
  }, []);

  const visibleClasses = (
    myClassesOnly && showMyToggle
      ? classes.filter((c) => c.coachUserId === currentUserId)
      : classes
  )
    .filter((c) => !venueFilter || c.locationId === null || c.locationId === venueFilter)
    .filter((c) =>
      !categoryFilter || !showCategoryFilter
        ? true
        : categoryFilter === UNCATEGORISED
          ? classCategoryLabel(c.category) === null
          : c.category === categoryFilter,
    );

  // Group by day — driven by `visibleClasses` so the weekly grid filters too
  const byDay = Array.from({ length: 7 }, (_, i) =>
    visibleClasses
      .filter((c) => c.schedules.some((s) => s.dayOfWeek === i))
      .sort((a, b) => {
        const at = a.schedules.find((s) => s.dayOfWeek === i)?.startTime ?? "";
        const bt = b.schedules.find((s) => s.dayOfWeek === i)?.startTime ?? "";
        return at.localeCompare(bt);
      })
  );

  function openAdd() {
    setEditTarget(null);
    setDrawerOpen(true);
  }

  useEffect(() => {
    if (!canManage || openedFromQuery.current) return;
    if (searchParams.get("new") === "class") {
      openedFromQuery.current = true;
      setEditTarget(null);
      setDrawerOpen(true);
    }
  }, [canManage, searchParams]);

  function openEdit(cls: ClassRow) {
    setEditTarget(cls);
    setDrawerOpen(true);
  }

  async function handleSave(data: Record<string, unknown>) {
    setSaving(true);
    try {
      if (editTarget) {
        // T6a: narrowing the memberships removes the bookings of members it
        // no longer includes. Preview first and ask, rather than surprise.
        const before = (editTarget.allowedTiers ?? []).map((t) => t.id).sort().join(",");
        const after = Array.isArray(data.allowedTierIds) ? [...(data.allowedTierIds as string[])].sort().join(",") : before;
        if (after !== before && after !== "") {
          const preview = await fetch(`/api/classes/${editTarget.id}?dryRun=1`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
          if (!preview.ok) {
            const body = await preview.json().catch(() => null);
            throw new Error(describeApiError(body));
          }
          const { tierAffectedMemberIds } = (await preview.json()) as { tierAffectedMemberIds?: string[] };
          const n = tierAffectedMemberIds?.length ?? 0;
          if (n > 0) {
            const ok = await ask({
              title: "Remove bookings outside these memberships?",
              body: `${n} ${n === 1 ? "member is" : "members are"} booked on this class but not on the memberships you ticked. Saving removes ${n === 1 ? "that booking" : "those bookings"}; past check-ins are kept.`,
              confirmLabel: "Save and remove bookings",
            });
            if (!ok) return;
          }
        }
        const res = await fetch(`/api/classes/${editTarget.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(describeApiError(body));
        }
        // `scheduleChange` is a report about the save, not a field of the
        // class — destructured out so it never lands on the row.
        const { scheduleChange, ...updated } = (await res.json()) as {
          scheduleChange: ScheduleChange | null;
        } & Partial<ClassRow>;
        setClasses((prev) =>
          prev.map((c) =>
            c.id === editTarget.id
              ? { ...c, ...updated, schedules: updated.schedules ?? c.schedules }
              : c
          )
        );
        // RULES §2 + §5. This used to say "Class updated" unconditionally,
        // for a `schedules` field the server was silently discarding. It now
        // says what the save actually did, including the upcoming sessions
        // the change removed.
        const kept = scheduleChange?.instancesKept.length ?? 0;
        showToast(describeSave(scheduleChange), kept > 0 ? "warning" : "success");
      } else {
        const res = await fetch("/api/classes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(describeApiError(body));
        }
        // `instancesCreated` is a report about the save (the sessions minted
        // for the next eight weeks), not a field of the class — kept off the row
        // and put in the toast, so "created" also says it is on the timetable.
        const { instancesCreated, ...created } = (await res.json()) as { instancesCreated: number; allowedTierIds?: string[] } & ClassRow;
        setClasses((prev) => [...prev, createdClassRow(created, membershipTiers)]);
        showToast(`Class created · ${instancesCreated} sessions added to the timetable`, "success");
      }
      setDrawerOpen(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Something went wrong", "error");
    } finally {
      setSaving(false);
    }
  }

  // T6b: Pause — off the timetable for now, one click to resume.
  const handlePause = useCallback(
    async (cls: ClassRow) => {
      const confirmed = await ask({
        title: `Pause ${cls.name}?`,
        body:
          "It comes off the timetable, the member app, booking and the kiosk, and no new sessions are made. " +
          "Bookings and check-in history are kept. Resume it any time from Paused and archived, or undo this from Activity.",
        confirmLabel: "Pause class",
      });
      if (!confirmed) return;
      setLifecycleBusy(cls.id);
      try {
        const res = await fetch(`/api/classes/${cls.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: false }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(describeApiError(body));
        }
        setClasses((prev) => prev.filter((c) => c.id !== cls.id));
        setInactiveClasses((prev) => [...prev.filter((c) => c.id !== cls.id), { ...cls, lifecycle: "paused", archivedAt: null }]);
        showToast("Class paused. Resume it from Paused and archived.", "success");
      } catch (err) {
        showToast(err instanceof Error && err.message ? err.message : "Could not pause the class. Try again.", "error");
      } finally {
        setLifecycleBusy(null);
      }
    },
    [ask, showToast]
  );

  // T6b: Archive — a counted confirmation instead of the old 409. The counts
  // are read first; if they cannot be read the archive does not go ahead.
  const handleArchive = useCallback(
    async (cls: ClassRow) => {
      let counts: { attendanceCount: number; rosterCount: number; bookingCount: number };
      try {
        const preview = await fetch(`/api/classes/${cls.id}?dryRun=1`, { method: "DELETE" });
        const body = (await preview.json().catch(() => null)) as Partial<typeof counts> | null;
        if (!preview.ok) throw new Error(describeApiError(body));
        // The confirmation states these numbers; without all three it would
        // have to guess, so it does not ask at all (UI-RULES §7).
        if (
          !body ||
          typeof body.attendanceCount !== "number" ||
          typeof body.rosterCount !== "number" ||
          typeof body.bookingCount !== "number"
        ) {
          throw new Error("");
        }
        counts = { attendanceCount: body.attendanceCount, rosterCount: body.rosterCount, bookingCount: body.bookingCount };
      } catch (err) {
        showToast(err instanceof Error && err.message ? err.message : "Could not check this class's history. Try again.", "error");
        return;
      }
      const confirmed = await ask({
        title: `Archive ${cls.name}?`,
        body: archiveConfirmBody(counts, cls.lifecycle),
        confirmLabel: "Archive class",
      });
      if (!confirmed) return;
      setLifecycleBusy(cls.id);
      try {
        const res = await fetch(`/api/classes/${cls.id}`, { method: "DELETE" });
        const body = (await res.json().catch(() => null)) as { archivedAt?: string } | null;
        if (!res.ok) throw new Error(describeApiError(body));
        setClasses((prev) => prev.filter((c) => c.id !== cls.id));
        setInactiveClasses((prev) => [
          ...prev.filter((c) => c.id !== cls.id),
          { ...cls, lifecycle: "archived", archivedAt: body?.archivedAt ?? new Date().toISOString() },
        ]);
        showToast("Class archived. Its history is kept — restore it from Paused and archived.", "success");
      } catch (err) {
        showToast(err instanceof Error && err.message ? err.message : "Could not archive the class. Try again.", "error");
      } finally {
        setLifecycleBusy(null);
      }
    },
    [ask, showToast]
  );

  // T6b: Resume (paused) / Restore (archived) — both clear the state and put
  // the class back on the timetable; the server mints its upcoming sessions.
  const handleRestore = useCallback(
    async (cls: ClassRow) => {
      const wasArchived = cls.lifecycle === "archived";
      setLifecycleBusy(cls.id);
      try {
        const res = await fetch(`/api/classes/${cls.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: true }),
        });
        const body = (await res.json().catch(() => null)) as { sessionsCreatedOnResume?: number } | null;
        if (!res.ok) throw new Error(describeApiError(body));
        setInactiveClasses((prev) => prev.filter((c) => c.id !== cls.id));
        setClasses((prev) => [...prev.filter((c) => c.id !== cls.id), { ...cls, lifecycle: "active", archivedAt: null }]);
        const n = body?.sessionsCreatedOnResume ?? 0;
        const verb = wasArchived ? "Class restored" : "Class resumed";
        showToast(n > 0 ? `${verb} · ${plural(n, "session", "sessions")} added to the timetable` : `${verb} — it's back on the timetable`, "success");
      } catch (err) {
        showToast(
          err instanceof Error && err.message ? err.message : `Could not ${wasArchived ? "restore" : "resume"} the class. Try again.`,
          "error",
        );
      } finally {
        setLifecycleBusy(null);
      }
    },
    [showToast]
  );

  const handleGenerate = useCallback(
    async (id: string) => {
      setGenerating(id);
      try {
        const res = await fetch(`/api/classes/${id}/instances`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ weeks: 4 }),
        });
        const data = (await res.json().catch(() => null)) as { created?: number; error?: string } | null;
        // T6b: a paused or archived class answers 409 with a sentence; say it.
        if (!res.ok) throw new Error(data?.error ?? "");
        // Without the res.ok check above, a 200-with-error-body rendered
        // "Generated undefined class instances".
        showToast(`Generated ${data?.created ?? 0} class instances`, "success");
      } catch (err) {
        showToast(err instanceof Error && err.message ? err.message : "Failed to generate instances", "error");
      } finally {
        setGenerating(null);
      }
    },
    [showToast]
  );

  return (
    <>

      {/* §4: one PageHeader treatment. The description keeps its exact wording
          so the "N of M classes (mine)" count stays the single readout of the
          active filter. */}
      <PageHeader
        title="Timetable"
        description={
          <>
            {myClassesOnly && showMyToggle
              ? `${visibleClasses.length} of ${classes.length} class${classes.length !== 1 ? "es" : ""} (mine)`
              : `${classes.length} class${classes.length !== 1 ? "es" : ""}`}{" "}
            · Manage your schedule
          </>
        }
        action={
          canManage ? (
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    const res = await fetch("/api/instances/generate", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ weeks: 4 }),
                    });
                    // Same fix as the sibling handler above: without the res.ok
                    // check a 200-with-error-body toasted "Generated undefined
                    // instances" as a SUCCESS. The fix was applied there and
                    // not here.
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const d = (await res.json()) as { created?: number };
                    showToast(`Generated ${d.created ?? 0} instances for next 4 weeks`, "success");
                  } catch {
                    showToast("Failed to generate", "error");
                  }
                }}
              >
                <RefreshCw className="size-3.5" />
                Generate 4 weeks
              </Button>
              <Button onClick={openAdd}>
                <Plus className="size-4" />
                Add class
              </Button>
            </div>
          ) : undefined
        }
      />

      {/* My-classes filter toggle. Shown only when the current user owns ≥1 class;
          coaches default to ON, owner/manager to OFF (override persisted in localStorage). */}
      {showMyToggle && (
        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={() => setMyClassesOnly(false)}
            className="px-3 py-1.5 rounded-full text-xs font-medium transition-all"
            style={{
              background: !myClassesOnly ? hex(primaryColor, 0.15) : "var(--sf-1)",
              color: !myClassesOnly ? primaryColor : "var(--tx-3)",
              border: `1px solid ${!myClassesOnly ? primaryColor : "var(--bd-default)"}`,
            }}
          >
            All classes ({classes.length})
          </button>
          <button
            onClick={() => setMyClassesOnly(true)}
            className="px-3 py-1.5 rounded-full text-xs font-medium transition-all"
            style={{
              background: myClassesOnly ? hex(primaryColor, 0.15) : "var(--sf-1)",
              color: myClassesOnly ? primaryColor : "var(--tx-3)",
              border: `1px solid ${myClassesOnly ? primaryColor : "var(--bd-default)"}`,
            }}
          >
            My classes ({ownedCount})
          </button>
        </div>
      )}

      {venueList.length > 1 && (
        <div className="mb-4 flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs font-medium" style={{ color: "var(--tx-3)" }}>
            Venue
            <Select aria-label="Filter by venue" className="w-[200px]" value={venueFilter} onChange={(e) => setVenueFilter(e.target.value)} data-testid="timetable-venue-filter">
              <option value="">Every venue</option>
              {venueList.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </Select>
          </label>
          {venueFilter && (
            <span className="text-xs" style={{ color: "var(--tx-4)" }}>
              {visibleClasses.length} of {classes.length} classes · classes with no venue show everywhere
            </span>
          )}
        </div>
      )}

      {showCategoryFilter && (
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-2 text-xs font-medium" style={{ color: "var(--tx-3)" }}>
            Category
            <Select aria-label="Filter by category" className="w-[200px]" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} data-testid="timetable-category-filter">
              <option value="">Every category</option>
              {CLASS_CATEGORIES.map((key) => (
                <option key={key} value={key}>{CLASS_CATEGORY_LABELS[key]}</option>
              ))}
              <option value={UNCATEGORISED}>Uncategorised</option>
            </Select>
          </label>
          {categoryFilter && (
            <span className="text-xs" style={{ color: "var(--tx-4)" }} data-testid="timetable-category-count">
              Showing {visibleClasses.length} of {classes.length} classes
            </span>
          )}
        </div>
      )}

      {classes.length === 0 ? (
        <EmptyState onAdd={openAdd} primaryColor={primaryColor} canManage={canManage} />
      ) : (
        <div className="space-y-6">
          {/* Weekly view */}
          {(() => {
            const weekDates = getWeekDates(weekOffset);
            const todayMidnight = new Date();
            todayMidnight.setHours(0, 0, 0, 0);
            return (
              <>
                {/* Week navigation */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="compact"
                      onClick={() => setWeekOffset((w) => w - 1)}
                      className="w-8 px-0"
                      aria-label="Previous week"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <span className="text-sm font-medium px-1 min-w-[180px] text-center" style={{ color: "var(--tx-2)" }}>
                      {fmtWeekLabel(weekDates)}
                    </span>
                    <Button
                      variant="ghost"
                      size="compact"
                      onClick={() => setWeekOffset((w) => w + 1)}
                      className="w-8 px-0"
                      aria-label="Next week"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                  {weekOffset !== 0 && (
                    <Button variant="secondary" size="compact" onClick={() => setWeekOffset(0)}>
                      Today
                    </Button>
                  )}
                </div>

                {/* 7-column week grid. Each cell wants ≥130px to fit names like
                    "Fundamentals BJJ" without cramming, so below `xl:` the grid
                    keeps its 980px floor and scrolls. From `xl:` the layout's
                    max-w-6xl content box is wider than that floor, so BOTH the
                    floor and the scroller are released — otherwise the page
                    kept a horizontal scrollbar over empty margin (§4a.1). */}
                {/* ── Mobile: day-at-a-time agenda ──────────────────────────
                    Below `md:` the 7-column grid was a 980px canvas inside a
                    horizontal scroller, so a phone showed roughly two days at a
                    time and the owner had to swipe sideways to find Thursday.
                    An agenda shows one day full-width with real tap targets.
                    Same data, same ClassChip, same edit gating. */}
                <div className="md:hidden">
                  <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-2" role="tablist" aria-label="Day of week">
                    {weekDates.map((date, rawIdx) => {
                      const dow = rawIdx === 6 ? 0 : rawIdx + 1;
                      const isToday = date.getTime() === todayMidnight.getTime();
                      const selected = agendaDow === dow;
                      const count = byDay[dow].length;
                      return (
                        <button
                          key={rawIdx}
                          type="button"
                          role="tab"
                          aria-selected={selected}
                          onClick={() => setAgendaDow(dow)}
                          className="shrink-0 rounded-xl border px-3 py-2 text-center transition-colors"
                          style={{
                            background: selected ? hex(primaryColor, 0.12) : "var(--sf-1)",
                            borderColor: selected ? hex(primaryColor, 0.4) : "var(--bd-default)",
                          }}
                        >
                          <span
                            className="block text-[10px] font-semibold uppercase tracking-wider"
                            style={{ color: isToday ? primaryColor : "var(--tx-3)" }}
                          >
                            {DAYS[dow]}
                          </span>
                          <span className="block text-sm font-bold" style={{ color: "var(--tx-1)" }}>
                            {date.getDate()}
                          </span>
                          <span className="block text-[10px] tabular-nums" style={{ color: "var(--tx-4)" }}>
                            {count === 0 ? "—" : count}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="space-y-2 mt-1">
                    <p className="text-xs font-semibold" style={{ color: "var(--tx-2)" }}>
                      {DAYS_FULL[agendaDow]}
                    </p>
                    {byDay[agendaDow].length === 0 ? (
                      <p className="text-sm py-6 text-center" style={{ color: "var(--tx-4)" }}>
                        No classes scheduled.
                      </p>
                    ) : (
                      (() => {
                        const agendaDate = weekDates[agendaDow === 0 ? 6 : agendaDow - 1];
                        const agendaIsToday = agendaDate.getTime() === todayMidnight.getTime();
                        const chipStates = chipStatesFor(byDay[agendaDow], agendaDow, agendaIsToday, cancelledToday);
                        return byDay[agendaDow].map((cls, i) => (
                          <ClassChip
                            key={cls.id}
                            cls={cls}
                            startTime={cls.schedules.find((sc) => sc.dayOfWeek === agendaDow)?.startTime}
                            primaryColor={primaryColor}
                            canManage={canManage}
                            onEdit={openEdit}
                            size="agenda"
                            state={chipStates[i]}
                          />
                        ));
                      })()
                    )}
                  </div>
                </div>

                {/* ── Desktop: the week grid ─────────────────────────────── */}
                <div className="hidden md:block overflow-x-auto xl:overflow-x-visible -mx-1 px-1">
                  <div className="grid grid-cols-7 min-w-[980px] xl:min-w-0 gap-2">
                    {weekDates.map((date, rawIdx) => {
                      const dow = rawIdx === 6 ? 0 : rawIdx + 1;
                      const dayClasses = byDay[dow];
                      const isToday = date.getTime() === todayMidnight.getTime();
                      const chipStates = chipStatesFor(dayClasses, dow, isToday, cancelledToday);
                      return (
                        <div
                          key={rawIdx}
                          ref={isToday ? todayColRef : undefined}
                          data-today={isToday || undefined}
                          className="rounded-2xl border p-2 flex flex-col"
                          style={{
                            background: isToday ? hex(primaryColor, 0.04) : "var(--sf-1)",
                            borderColor: isToday ? hex(primaryColor, 0.3) : "var(--bd-default)",
                          }}
                        >
                          {/* Day header */}
                          <div className="text-center mb-2">
                            <p
                              className="text-[10px] font-semibold uppercase tracking-wider mb-1"
                              style={{ color: isToday ? primaryColor : "var(--tx-3)" }}
                            >
                              {DAYS[dow]}
                            </p>
                            <div
                              className="w-7 h-7 rounded-full flex items-center justify-center mx-auto text-sm font-bold"
                              style={
                                isToday
                                  ? { background: primaryColor, color: "var(--tx-on-accent)" }
                                  : { color: "var(--tx-2)" }
                              }
                            >
                              {date.getDate()}
                            </div>
                          </div>

                          {/* Classes */}
                          <div className="space-y-1.5 flex-1">
                            {dayClasses.length === 0 ? (
                              <p className="text-center text-[11px] py-4" style={{ color: "var(--tx-4)" }}>—</p>
                            ) : (
                              dayClasses.map((cls, i) => (
                                <ClassChip
                                  key={cls.id}
                                  cls={cls}
                                  startTime={cls.schedules.find((sc) => sc.dayOfWeek === dow)?.startTime}
                                  primaryColor={primaryColor}
                                  canManage={canManage}
                                  onEdit={openEdit}
                                  state={chipStates[i]}
                                />
                              ))
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            );
          })()}

          {/* All classes list */}
          <div>
            <h2 className="font-semibold text-sm mb-3" style={{ color: "var(--tx-1)" }}>
              {myClassesOnly && showMyToggle ? "My Classes" : "All Classes"}
            </h2>
            {/* §4a.2: two columns is a WIDENING, and at `md:` the sidebar left
                each card only ~236px. It now splits at `lg:`, where the content
                box can actually carry two readable cards. */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {visibleClasses.map((cls) => (
                <ClassCard
                  key={cls.id}
                  cls={cls}
                  primaryColor={primaryColor}
                  onEdit={openEdit}
                  onPause={handlePause}
                  onArchive={handleArchive}
                  onGenerate={handleGenerate}
                  generating={generating === cls.id}
                  canManage={canManage}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* T6b: the classes that are off the timetable, with Resume / Restore.
          Outside the empty-state ternary: a club whose every class is paused
          still needs the way back. */}
      {canManage && (
        <InactiveClassList
          classes={inactiveClasses}
          busyId={lifecycleBusy}
          onRestore={handleRestore}
          onArchive={handleArchive}
        />
      )}

      {/* §4a.3: one overlay standard. The hand-rolled slide-over that lived
          here (no role, no aria-modal, no Escape, no focus trap, no scroll
          lock) is replaced by the Sheet primitive — the right shape, because
          the class form is a long, scrolling, multi-field form. */}
      <Sheet
        open={drawerOpen}
        title={editTarget ? "Edit class" : "New class"}
        onClose={() => setDrawerOpen(false)}
      >
        <ClassForm
          initial={editTarget}
          rankSystems={rankSystems}
          coachUsers={coachUsers}
          membershipTiers={membershipTiers}
          primaryColor={primaryColor}
          onSave={handleSave}
          onCancel={() => setDrawerOpen(false)}
          saving={saving}
        />
        {/* T6b: the lifecycle actions, on the class itself as well as its card. */}
        {editTarget && canManage && (
          <div className="mt-6 border-t border-bd-default pt-4" data-testid="class-lifecycle-actions">
            <p className="text-xs font-semibold text-tx-2 mb-1">Class status</p>
            <p className="text-xs text-tx-3 mb-3">
              Pause takes it off the timetable for now; archive removes it. Both keep its history and bookings, and both can be undone.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="compact"
                onClick={() => {
                  const target = editTarget;
                  setDrawerOpen(false);
                  void handlePause(target);
                }}
              >
                <Pause className="size-3.5" />
                Pause class
              </Button>
              <Button
                variant="ghost"
                size="compact"
                onClick={() => {
                  const target = editTarget;
                  setDrawerOpen(false);
                  void handleArchive(target);
                }}
              >
                <Archive className="size-3.5" />
                Archive class
              </Button>
            </div>
          </div>
        )}
      </Sheet>

      <ConfirmDialog {...dialogProps} />
    </>
  );
}
