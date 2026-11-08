"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { matNameKey, placeSuggestions } from "@/lib/mats";
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
import { parseIdParam } from "@/lib/id-param";
import { duplicateSessionKeys, minToTime, sessionStateLabel, sessionStates, spanMinutes, type SessionState } from "@/lib/schedule-state";
import { PosterDay, PosterGrid } from "@/components/schedule/PosterGrid";
import { MorePanel } from "@/components/schedule/MorePanel";
import { MoreChip, MoreRow, WeekChip } from "@/components/schedule/WeekChip";
import { buildTimetableGrid } from "@/lib/timetable-grid";
import type { ClassRow, CoachUserOption, MatOption, TierOption } from "@/app/dashboard/timetable/page";
import { MatsSheet } from "@/components/dashboard/MatsSheet";
import { effectiveLayout, matsInUse, type TimetableLayout } from "@/lib/timetable-layout";
import { Checkbox } from "@/components/ui/checkbox";
import { CLASS_CATEGORIES, CLASS_CATEGORY_LABELS, classCategoryTag } from "@/lib/class-category";
import type { RestrictionPreview } from "@/lib/booking-eligibility";
import { RestrictionPreviewBody, previewHasRefusals } from "@/components/dashboard/RestrictionPreview";

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
  /** The club's mats, in the club's order (the order of the columns). */
  mats?: MatOption[];
  /** How same-time classes are split, if somebody has chosen: "mat" | "time". null = nobody has. */
  storedLayout?: TimetableLayout | null;
  /** The mats could not be read: the timetable is drawn by time and says so. */
  matsLoadFailed?: boolean;
  /** When the server began reading this page's mats (ISO time): tells a list read after a save from one read before it. */
  matsReadAt?: string;
  primaryColor: string;
  role: string;
  // Session F: drives the "My classes" filter. When null (e.g. no
  // currentUserId resolvable from session) the toggle is suppressed.
  currentUserId: string | null;
}

const NO_MATS: MatOption[] = [];

/** A place typed on the club's classes that is not one of its mats yet. */
type PlaceOption = { key: string; name: string };
const NO_PLACES: PlaceOption[] = [];

/**
 * The places the Location select offers besides the mats: typed on the club's
 * classes that are on the timetable or paused and on no mat, one per name
 * whatever its capitals and spacing (lib/mats.ts placeSuggestions, the Mats
 * sheet's own list), less the ones that already name a mat or are too long to.
 */
export function locationPlaces(classes: readonly Pick<ClassRow, "location" | "matId">[], mats: readonly MatOption[]): PlaceOption[] {
  const offMat = classes.filter((c) => !c.matId);
  return placeSuggestions(offMat, mats.map((m) => ({ id: m.id, nameKey: matNameKey(m.name) })))
    .suggestions.filter((s) => s.matId === null && !s.tooLong)
    .map((s) => ({ key: s.key, name: s.name }));
}

/**
 * Where the Location select starts: the class's mat; else its typed place,
 * as a place option when the list offers it, or as "keep" (its own text,
 * kept as it is) when it does not: too long for a mat, or the name of a mat
 * the class is not on. A class is never moved onto a mat by a save that did
 * not change its Location (review, 7 Nov 2026). A class with no place, or a
 * new class, starts on "No location".
 */
function locationChoiceOf(initial: Partial<ClassRow> | null, mats: readonly MatOption[], places: readonly PlaceOption[]): string {
  if (initial?.matId) {
    if (mats.some((m) => m.id === initial.matId)) return `mat:${initial.matId}`;
    return initial.location ? "keep" : "none";
  }
  const key = matNameKey(initial?.location ?? "");
  if (!key) return "none";
  const place = places.find((p) => p.key === key);
  return place ? `place:${place.name}` : "keep";
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

/** What a save that added a Location reports: the mat, the club's other classes it took, and when it was saved. */
type LocationAdded = MatOption & { classIds?: string[]; savedAt?: string };

/**
 * Said when a save turned a typed Location into one of the club's saved locations (a mat): how many classes on the
 * timetable are now on it, and how many paused or archived ones went with them. Never "0 classes": when none on it
 * is on the timetable (a paused class saved), it says how many that are not.
 */
export const savedAsLocation = (name: string, live: number, notLive: number) =>
  live === 0
    ? `“${name}” is saved as a location. ${plural(notLive, "class not on the timetable is", "classes not on the timetable are")} on it.`
    : `“${name}” is saved as a location. ${plural(live, "class is", "classes are")} now on it${notLive > 0 ? ` (and ${notLive} not on the timetable)` : ""}.`;

/** How many of the classes a new Location took are on the timetable: the saved class (when it is) and the others. */
export function locationCounts(savedIsLive: boolean, others: readonly string[], liveIds: ReadonlySet<string>): { live: number; notLive: number } {
  const live = (savedIsLive ? 1 : 0) + others.filter((id) => liveIds.has(id)).length;
  return { live, notLive: 1 + others.length - live };
}

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

/**
 * D2: whether a save changes who the class admits — its memberships, its
 * squad list or its rank gate — so the owner is shown who it turns away
 * first. A new class is previewed when it is created restricted.
 */
function accessChanged(target: ClassRow | null, data: Record<string, unknown>): boolean {
  const ids = (v: unknown, key: "id" | "memberId") =>
    Array.isArray(v) ? (v as Array<string | Record<string, string>>).map((x) => (typeof x === "string" ? x : x[key])).sort().join(",") : null;
  const tiersAfter = Array.isArray(data.allowedTierIds) ? [...(data.allowedTierIds as string[])].sort().join(",") : null;
  const rosterAfter = ids(data.roster, "memberId");
  if (!target) return !!tiersAfter || !!rosterAfter || !!data.requiredRankId || !!data.maxRankId;
  const tiersBefore = ids(target.allowedTiers ?? [], "id") ?? "";
  const rosterBefore = ids(target.roster ?? [], "memberId") ?? "";
  const rankChanged =
    ("requiredRankId" in data && (data.requiredRankId ?? null) !== (target.requiredRankId ?? null)) ||
    ("maxRankId" in data && (data.maxRankId ?? null) !== (target.maxRankId ?? null));
  return (tiersAfter !== null && tiersAfter !== tiersBefore) || (rosterAfter !== null && rosterAfter !== rosterBefore) || rankChanged;
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

/** A refused save: the server's sentence, plus its machine reason when it gives one. */
class ApiRefusal extends Error {
  reason?: string;
  constructor(message: string, reason?: string) {
    super(message);
    this.reason = reason;
  }
}
export type SaveError = { message: string; reason?: string };

const placeOf = (cls: ClassRow) => cls.location ?? cls.coachUser?.name ?? cls.coachName ?? null;

/**
 * Today's states for one day column of the template: the owner's own device
 * clock, the same rule as the member's day view (lib/schedule-state.ts).
 * Returns `null` for any day that is not today.
 */
export function chipStatesFor(
  sessions: DaySession[],
  isToday: boolean,
  cancelledToday: ReadonlySet<string> = new Set(),
  now: Date = new Date(),
): (SessionState | null)[] {
  if (!isToday) return sessions.map(() => null);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  // Lane 3 D6: the template alone showed a called-off session as LIVE. Today's
  // instances (from /api/coach/today) mark a cancelled one, keyed on
  // class + start time, and lib/schedule-state decides cancellation FIRST —
  // so it reads "Cancelled", never Live or Next.
  const spans = sessions.map(({ cls, slot }) => ({
    ...spanMinutes(slot.startTime, slot.endTime),
    cancelled: cancelledToday.has(`${cls.id}|${slot.startTime}`),
  }));
  return sessionStates(spans, nowMin, true);
}

/**
 * One session on the staff timetable: a class and one of its slots. The week
 * grid and the agenda are built from these, not from classes, so a class that
 * runs three times on Monday gets three chips (Sean's Beginners Gi showed one).
 */
export type DaySession = { cls: ClassRow; slot: ClassRow["schedules"][number] };

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
  busy,
  locked,
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
  /** The lifecycle action in flight for THIS class, if any. */
  busy: "pause" | "archive" | "restore" | null;
  /** True while a lifecycle action runs on ANY class — one at a time, like its dialog. */
  locked: boolean;
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
              disabled={locked}
              loading={busy === "pause"}
              aria-label={`Pause ${cls.name}`}
              title="Pause: take it off the timetable for now"
              className="w-7 px-0"
            >
              {/* Icon-only: the spinner takes the icon's place, not a second slot. */}
              {busy !== "pause" && <Pause className="size-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="compact"
              onClick={() => onArchive(cls)}
              disabled={locked}
              loading={busy === "archive"}
              aria-label={`Archive ${cls.name}`}
              title="Archive: remove it from the timetable, keep its history"
              className="w-7 px-0"
            >
              {busy !== "archive" && <Archive className="size-3.5" />}
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
  busy,
  currentId,
  onRestore,
  onArchive,
}: {
  classes: ClassRow[];
  /** The lifecycle action in flight on any class, if one is. */
  busy: { id: string; action: "pause" | "archive" | "restore" } | null;
  /** The class a ?classId= link pointed at, marked in the list. */
  currentId: string | null;
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
                className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border border-bd-default bg-sf-1 px-3 py-2${
                  cls.id === currentId ? " outline outline-2 -outline-offset-2 outline-[var(--tx-2)]" : ""
                }`}
                data-testid={`inactive-class-${cls.id}`}
                aria-current={cls.id === currentId ? "true" : undefined}
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
                      disabled={busy !== null}
                      loading={busy?.id === cls.id && busy.action === "archive"}
                      aria-label={`Archive ${cls.name}`}
                    >
                      {!(busy?.id === cls.id && busy.action === "archive") && <Archive className="size-3.5" />}
                      Archive
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="compact"
                    onClick={() => onRestore(cls)}
                    disabled={busy !== null}
                    loading={busy?.id === cls.id && busy.action === "restore"}
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
  mats = NO_MATS,
  places = NO_PLACES,
  primaryColor,
  onSave,
  onCancel,
  saving,
  error = null,
}: {
  initial: Partial<ClassRow> | null;
  rankSystems: RankOption[];
  coachUsers: CoachUserOption[];
  membershipTiers?: TierOption[];
  /** The club's mats (its saved locations), in the club's order. */
  mats?: MatOption[];
  /** Places typed on the club's classes that are not mats yet, in name order. */
  places?: PlaceOption[];
  primaryColor: string;
  onSave: (data: Record<string, unknown>) => void;
  onCancel: () => void;
  saving: boolean;
  /** Why the last save was refused, shown beside the buttons (UI-RULES §7) — never a toast over them. */
  error?: SaveError | null;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [coachName, setCoachName] = useState(initial?.coachName ?? "");
  const [coachUserId, setCoachUserId] = useState(initial?.coachUserId ?? "");
  // Location (Noe, 7 Nov 2026): one select of the club's saved locations (its
  // mats), then the places typed on its classes that are not mats yet, "No
  // location" and "Add a new location…". A typed place or a new name is sent
  // by name and the server puts the class on the mat of that name, adding it
  // when there is none (lib/mats-store.ts matForLocation). Values:
  // "mat:<id>", "place:<name>" (one name per place, so unique), "none",
  // "new", and "keep" for the class's own place when the list cannot offer
  // it (see locationChoiceOf).
  const [initialChoice] = useState(() => locationChoiceOf(initial, mats, places));
  const [locationChoice, setLocationChoice] = useState(initialChoice);
  const [newLocation, setNewLocation] = useState("");
  const locationSelect = useRef<HTMLSelectElement>(null);
  const newLocationInput = useRef<HTMLInputElement>(null);
  // A refusal is said until the Location is changed: the select or the box. The next refused save says it again.
  const [locationErrorDismissed, setLocationErrorDismissed] = useState<SaveError | null>(null);
  const locationError = error?.reason === "location" && error !== locationErrorDismissed ? error.message : null;
  // The box's visible label (and its accessible name).
  const newLocationLabel = "Name of the new location";
  // The class's own place when the list cannot offer it. Never the same text as another option: a typed place that
  // is a saved location's name (older data, on no mat) says it is only typed here.
  const keepLabel = !initial?.matId && initial?.location && mats.some((m) => matNameKey(m.name) === matNameKey(initial.location ?? ""))
    ? `${initial.location} (typed on this class only)`
    : (initial?.location ?? "");
  // A refused Location is said beside the field; focus goes there so it is on screen, with what was typed kept.
  useEffect(() => {
    if (error?.reason !== "location") return;
    (newLocationInput.current ?? locationSelect.current)?.focus();
    // Focus brings the field on screen; the sentence under it comes too (on a phone the field can land at the edge).
    document.getElementById("class-form-location-error")?.scrollIntoView?.({ block: "nearest" });
  }, [error]);
  function locationFields(): Record<string, unknown> {
    const editing = Boolean(initial?.id);
    if (locationChoice.startsWith("mat:")) {
      const id = locationChoice.slice(4);
      // An edit that leaves the class on its mat names no mat, so the server takes no mats lock.
      return editing && id === initial?.matId ? {} : { matId: id };
    }
    if (editing && locationChoice === initialChoice) return {};
    if (locationChoice === "new") return { matName: newLocation.trim() };
    if (locationChoice.startsWith("place:")) return { matName: locationChoice.slice(6) };
    if (locationChoice === "keep") return {};
    return { matId: null, location: null };
  }
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
  if (locationChoice === "new" && !newLocation.trim()) missing.push("a name for the new location");
  // The same day and start twice in one class: a session is class + day +
  // start everywhere downstream (one ClassInstance per start, cancel keys,
  // the member view), so a second row at the same start would be quietly
  // collapsed by the server. Refuse out loud here instead.
  const repeated: string[] = [];
  {
    const seen = new Set<string>();
    for (const s of schedules) {
      if (!s.startTime) continue;
      const k = `${s.dayOfWeek}|${s.startTime}`;
      const label = `${DAYS_FULL[s.dayOfWeek]} ${s.startTime}`;
      if (seen.has(k) && !repeated.includes(label)) repeated.push(label);
      seen.add(k);
    }
  }
  const canSubmit = missing.length === 0 && repeated.length === 0;

  function submit() {
    if (!canSubmit) return;
    onSave({
      name: name.trim(),
      // When a User is selected, that's authoritative; coachName is the legacy
      // free-text fallback for clubs that haven't put their coaches in Users yet.
      coachName: coachName.trim() || null,
      coachUserId: coachUserId || null,
      // Sent on create, and on edit only when it changed. On a mat the server writes the mat's name as the place.
      ...locationFields(),
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
      // Switching an existing squad back with no rank chosen sends [] so the
      // server clears it: omitted, the squad stayed in force while the form
      // said anyone could attend. With a rank chosen the rank gate clears the
      // squad itself — and any roster array, even [], would null the rank.
      roster: useRoster
        ? rosterMemberIds.map((id) => ({ memberId: id }))
        : initial?.roster?.length && !requiredRankId && !maxRankId
          ? []
          : undefined,
      // T6a: [] = everyone. Sent on create, and on edit only when changed, so
      // an unrelated edit never rewrites the list; clearing every tick sends
      // [] and reopens the class.
      ...(!initial?.id || !sameTierSet(allowedTierIds, initialTierIds) ? { allowedTierIds } : {}),
      color,
      schedules,
      // P6: the slot ids this form loaded with. The server refuses the save
      // (409) if the class's days changed since, instead of taking this list
      // as the whole truth and quietly undoing another tab's change.
      ...(initial?.id ? { baseScheduleIds: (initial.schedules ?? []).map((s) => s.id) } : {}),
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
          <label htmlFor="class-form-location" className="text-xs font-medium block mb-1.5 text-tx-3">Location</label>
          <Select
            ref={locationSelect}
            id="class-form-location"
            aria-label="Location"
            value={locationChoice}
            onChange={(e) => {
              setLocationChoice(e.target.value);
              setLocationErrorDismissed(error);
            }}
            className="w-full"
            data-testid="class-form-location"
            aria-invalid={locationError && locationChoice !== "new" ? true : undefined}
            aria-describedby={locationError ? "class-form-location-error" : undefined}
          >
            {mats.map((m) => (
              <option key={m.id} value={`mat:${m.id}`}>{m.name}</option>
            ))}
            {places.map((p) => (
              <option key={p.key} value={`place:${p.name}`}>{p.name}</option>
            ))}
            {initialChoice === "keep" && <option value="keep">{keepLabel}</option>}
            <option value="none">No location</option>
            <option value="new">Add a new location…</option>
          </Select>
          {locationChoice === "new" && (
            <>
              <label htmlFor="class-form-new-location" className="text-xs font-medium block mt-2 mb-1.5 text-tx-3">
                {newLocationLabel}
              </label>
              <Input
                ref={newLocationInput}
                id="class-form-new-location"
                aria-label={newLocationLabel}
                value={newLocation}
                onChange={(e) => {
                  setNewLocation(e.target.value);
                  setLocationErrorDismissed(error);
                }}
                data-testid="class-form-new-location"
                aria-invalid={locationError ? true : undefined}
                aria-describedby={locationError ? "class-form-location-error" : undefined}
              />
            </>
          )}
          {locationError && (
            <p id="class-form-location-error" role="alert" data-testid="class-form-location-error" className="mt-1 text-xs text-[var(--hue-danger-ink)]">
              {locationError}
            </p>
          )}
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
            ? "This class has a squad list. Only members on it can book or check in; if memberships are also ticked, a member must be on one of them too."
            : allowedTierIds.length === 0
              ? "Everyone — any member can book and check in. Tick memberships to limit this class to them."
              : "Only members on the ticked memberships can book or check in — at the desk and the card scanner too. To admit someone else, change their membership."}
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
        {/* A refused Location is said beside its field instead (above). */}
        {error && error.reason !== "location" && (
          // A refused save stays with the form, above the buttons it belongs
          // to: on a phone a toast sat over Cancel / Save and the class
          // status controls. A stale-days refusal offers the way out, since
          // an installed app has no reload control of its own.
          <div
            className="flex items-start gap-2 rounded-lg px-3 py-2"
            style={{
              background: "color-mix(in srgb, var(--hue-danger) 10%, transparent)",
              border: "1px solid color-mix(in srgb, var(--hue-danger) 35%, transparent)",
            }}
          >
            <p role="alert" data-testid="class-form-save-error" className="text-xs flex-1" style={{ color: "var(--hue-danger-ink)" }}>
              {error.message}
            </p>
            {error.reason === "stale_schedules" && (
              <Button variant="secondary" size="compact" onClick={() => window.location.reload()} className="shrink-0">
                Reload
              </Button>
            )}
          </div>
        )}
        {missing.length > 0 && (
          <p role="status" className="text-xs" style={{ color: "var(--tx-3)" }}>
            Fill in: {missing.join(", ")}.
          </p>
        )}
        {repeated.length > 0 && (
          <p role="status" className="text-xs" style={{ color: "var(--hue-warning-ink)" }}>
            {repeated.join(", ")} {repeated.length === 1 ? "is" : "are"} already in this class — remove the repeat or change its start time.
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

// One array for "none passed": a `= []` default is a new array every render,
// which the snapshot check below would read as a new server snapshot.
const NO_CLASSES: ClassRow[] = [];

export default function TimetableManager({
  initialClasses, initialInactiveClasses = NO_CLASSES, rankSystems, coachUsers, membershipTiers = [],
  mats: serverMats = NO_MATS, storedLayout = null, matsLoadFailed = false, matsReadAt,
  primaryColor, role, currentUserId,
}: Props) {
  // A class saved with a new Location adds a mat: it is used at once, before the refresh brings the server's list.
  // It is kept until a server list has it, or until a list read AFTER the save lacks it (the mat was removed since,
  // in the Mats sheet or another tab). A list read before the save (a refresh that was already in flight) is not
  // the truth about it, so it does not drop it.
  const [added, setAdded] = useState<LocationAdded[]>([]);
  const readAt = matsReadAt ? Date.parse(matsReadAt) : Number.NaN;
  const addedMats = useMemo(
    () => added.filter((a) => !serverMats.some((m) => m.id === a.id) && !(readAt > Date.parse(a.savedAt ?? ""))),
    [added, serverMats, readAt],
  );
  const addMat = (mat: LocationAdded) => setAdded((a) => [...a, mat]);
  const mats = useMemo(() => {
    const extra = addedMats.filter((a) => !serverMats.some((m) => m.id === a.id));
    return extra.length > 0 ? [...serverMats, ...extra] : serverMats;
  }, [serverMats, addedMats]);
  const searchParams = useSearchParams();
  const router = useRouter();
  const openedFromQuery = useRef(false);
  const [classes, setClasses] = useState<ClassRow[]>(initialClasses);
  // T6b: paused and archived classes, kept whole (roster included) so Resume /
  // Restore puts the exact row back on the timetable.
  const [inactiveClasses, setInactiveClasses] = useState<ClassRow[]>(initialInactiveClasses);
  // A route refresh re-renders the server page and passes a new snapshot while
  // this component stays mounted. `useState` only reads its initial value once,
  // so a day saved in another tab (Gi on Tuesday) stayed hidden, and a class
  // paused elsewhere stayed on the grid. Adopt each new snapshot — both lists
  // together, because pause/archive/restore move a class between them — during
  // render, as React recommends for state that follows a prop. Local changes
  // stay until the next snapshot; every save below asks for one.
  const [snapshot, setSnapshot] = useState({ active: initialClasses, inactive: initialInactiveClasses });
  if (snapshot.active !== initialClasses || snapshot.inactive !== initialInactiveClasses) {
    setSnapshot({ active: initialClasses, inactive: initialInactiveClasses });
    // A snapshot read before a save that added a Location does not know the classes it put on the new mat: keep
    // them on it until one read after the save comes (as the mat itself is kept), so the split does not flicker.
    const pending = added.filter((a) => !(readAt > Date.parse(a.savedAt ?? "")));
    const onPending = (rows: ClassRow[]) =>
      pending.length === 0 ? rows : rows.map((c) => {
        const a = pending.find((p) => p.classIds?.includes(c.id));
        return a ? { ...c, matId: a.id, location: a.name } : c;
      });
    setClasses(onPending(initialClasses));
    setInactiveClasses(onPending(initialInactiveClasses));
  }
  // Which class has a lifecycle action in flight, and which action — so the
  // right button shows it (Archive is busy from its history read onwards).
  // One at a time, like its confirmation: every class's lifecycle buttons are
  // disabled meanwhile, and each handler clears only its own entry.
  const [lifecycleBusy, setLifecycleBusy] = useState<{ id: string; action: "pause" | "archive" | "restore" } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ClassRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  // Desktop: the week grid, or one day (the same one-day poster grid a phone always shows).
  const [desktopView, setDesktopView] = useState<"week" | "day">("week");
  // "Expand timetable": the side menu and the page's width cap give way, so the
  // timetable takes the whole window. Plain state — never stored, so nobody on
  // a shared desk computer arrives without navigation — and it only counts
  // while its button is on screen.
  const [expanded, setExpanded] = useState(false);
  // Without :has() the shell cannot make room, and the button is not shown
  // (app/globals.css `[data-needs-has]`).
  const [canExpand, setCanExpand] = useState(true);
  useEffect(() => {
    setCanExpand(typeof CSS !== "undefined" && typeof CSS.supports === "function" ? CSS.supports("selector(:has(*))") : false);
  }, []);
  // Whether the week is wider than its scroll box (PosterGrid measures it).
  const [weekWider, setWeekWider] = useState(false);
  // Which day the one-day view is showing: a phone's only view, and the
  // desktop's Day view. Defaults to today, the day the owner almost always wants.
  const [agendaDow, setAgendaDow] = useState(() => new Date().getDay());
  // A desktop has room for more side-by-side columns in one day than a phone
  // before the day falls back to time. Known only in the browser, so the first
  // render is the phone's (three); a wider window is noticed on mount.
  const [roomyDay, setRoomyDay] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const wide = window.matchMedia("(min-width: 1024px)");
    const read = () => setRoomyDay(wide.matches);
    read();
    wide.addEventListener("change", read);
    return () => wide.removeEventListener("change", read);
  }, []);
  // The day's open "+N more" panel. Keyed by day as well as by the
  // button, so it is closed again when another day is chosen.
  const [phoneMore, setPhoneMore] = useState<{ day: number; id: string } | null>(null);
  const phoneDay = useRef<HTMLDivElement>(null);
  const { toast: showToast } = useToast();
  const { ask, dialogProps } = useConfirmDialog();

  const canManage = ["owner", "manager"].includes(role);

  // ── Mats and the same-time split ──────────────────────────────────────────
  // The choice somebody pressed follows the server's: a refresh brings a new
  // prop, and a press shows at once and is put back if the save fails.
  const [matsOpen, setMatsOpen] = useState(false);
  const [choice, setChoice] = useState<{ from: TimetableLayout | null; stored: TimetableLayout | null }>({ from: storedLayout, stored: storedLayout });
  if (choice.from !== storedLayout) setChoice({ from: storedLayout, stored: storedLayout });
  const [savingLayout, setSavingLayout] = useState(false);
  // Mats with a live class on them, over the whole club (not the filtered view).
  const inUse = matsInUse(classes, mats);
  // The class form's Location list after the mats: places typed on live and paused classes, not mats yet.
  const places = useMemo(
    () => locationPlaces([...classes, ...inactiveClasses.filter((c) => c.lifecycle === "paused")], mats),
    [classes, inactiveClasses, mats],
  );
  // Until someone chooses, the timetable follows the mats (lib/timetable-layout.ts).
  const layout: TimetableLayout = matsLoadFailed ? "time" : effectiveLayout(choice.stored, inUse);
  // When the split changes by itself (a class put on a second mat, a mat
  // removed), say so once. A change the reader has just been told about — the
  // control's own toast, the Mats sheet's own line — sets `quietSplit` first.
  const quietSplit = useRef(false);
  const lastLayout = useRef(layout);
  // A failed mats read draws the week by time and says why in its own line; neither that nor the recovery is a
  // change of the split, so neither gets the toast.
  const lastLoadFailed = useRef(matsLoadFailed);
  useEffect(() => {
    const readChanged = lastLoadFailed.current !== matsLoadFailed;
    lastLoadFailed.current = matsLoadFailed;
    if (lastLayout.current === layout) return;
    lastLayout.current = layout;
    if (quietSplit.current) {
      quietSplit.current = false;
      return;
    }
    if (readChanged || matsLoadFailed) return;
    showToast(`The timetable is now split by ${layout === "mat" ? "mat" : "time"}.`, "info");
  }, [layout, matsLoadFailed, showToast]);

  // "By mat" pressed before any class is on a mat: the Mats sheet opens to set them up, and the press is
  // remembered so the club is split by mat as soon as it can be. Forgotten when the sheet is closed.
  const [wantByMat, setWantByMat] = useState(false);
  async function splitByMatAfterSetup() {
    try {
      const res = await fetch("/api/timetable/layout", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: "mat" }) });
      // 409: still no class on a mat (a mat was added but nothing put on it yet). The sheet stays open.
      if (!res.ok) return;
      quietSplit.current = true;
      setChoice((c) => ({ ...c, stored: "mat" }));
      setWantByMat(false);
      setMatsOpen(false);
      showToast("Your timetable is now split by mat. Saved for the whole club.", "success");
      router.refresh();
    } catch {
      // The mats are saved; only the split is not. The control is still there to press.
    }
  }

  async function chooseLayout(next: TimetableLayout) {
    if (savingLayout) return;
    if (next === "mat" && inUse === 0) {
      setWantByMat(true);
      setMatsOpen(true);
      return;
    }
    if (choice.stored === next) return; // already saved: nothing to send
    const before = choice.stored;
    const changes = effectiveLayout(next, inUse) !== layout;
    if (changes) quietSplit.current = true;
    setChoice((c) => ({ ...c, stored: next }));
    setSavingLayout(true);
    // What the reader is told if the save does not land. A refusal the server
    // explains (no class is on a mat any more: 409) is shown in its words.
    let failure = "Couldn't save that. Try again.";
    try {
      const res = await fetch("/api/timetable/layout", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: next }) });
      if (!res.ok) {
        if (res.status === 409) {
          const said = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
          if (typeof said === "string" && said) failure = said;
        }
        throw new Error("refused");
      }
      // Every screen follows the choice: the staff week, the Day view, the phone and the members' day.
      showToast("Saved for the whole club.", "success");
      router.refresh();
    } catch {
      if (changes) quietSplit.current = true;
      setChoice((c) => ({ ...c, stored: before }));
      showToast(failure, "error");
    } finally {
      setSavingLayout(false);
    }
  }

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
    .filter((c) => !venueFilter || c.locationId === null || c.locationId === venueFilter);

  // Group by day — one entry per session, in start-time order — driven by
  // `visibleClasses` so the weekly grid filters too
  const byDay: DaySession[][] = Array.from({ length: 7 }, (_, i) =>
    visibleClasses
      .flatMap((cls) => cls.schedules.filter((s) => s.dayOfWeek === i).map((slot) => ({ cls, slot })))
      .sort((a, b) =>
        a.slot.startTime.localeCompare(b.slot.startTime)
        || a.cls.name.localeCompare(b.cls.name)
        || (placeOf(a.cls) ?? "").localeCompare(placeOf(b.cls) ?? "")
        || a.cls.id.localeCompare(b.cls.id))
  );
  // The week as a poster grid: rows are the real times, same-time sessions sit
  // side by side (lib/timetable-grid) — one column per mat, or in lanes by
  // time. Equal starts order by the club's mat order, then by the typed place,
  // so Mat 1 stays left of Mat 2 when the week is split by time too.
  const sessionByKey = new Map(byDay.flat().map((session) => [session.slot.id, session] as const));
  const matOrder = new Map(mats.map((m, i) => [m.id, i] as const));
  const matNames = new Map(mats.map((m) => [m.id, m.name] as const));
  const gridSession = ({ cls, slot }: DaySession) => {
    const position = cls.matId ? matOrder.get(cls.matId) : undefined;
    return {
      key: slot.id, day: slot.dayOfWeek, startTime: slot.startTime, endTime: slot.endTime,
      matId: cls.matId ?? null,
      tie: position !== undefined ? String(position).padStart(2, "0") : (cls.location ?? ""),
    };
  };
  const gridMats = mats.map((m) => ({ id: m.id }));
  const weekGrid = buildTimetableGrid(byDay.flat().map(gridSession), { days: [1, 2, 3, 4, 5, 6, 0], layout, mats: gridMats });
  // One day: the same grid for one day, on a phone and in the desktop's Day
  // view. It shows mat columns while the day needs no more side-by-side columns
  // than the screen has room for (three on a phone, six on a desktop); a busier
  // day is laid out by time and says so (`fellBack`).
  const dayMaxTracks = roomyDay ? 6 : 3;
  const oneDayGrid = (dow: number) => buildTimetableGrid(byDay[dow].map(gridSession), { days: [dow], layout, mats: gridMats, maxTracks: dayMaxTracks });
  const phoneGrid = oneDayGrid(agendaDow);
  // Same name, day, start and place twice: almost certainly entered twice.
  const duplicates = duplicateSessionKeys(
    visibleClasses.flatMap((cls) => cls.schedules.map((slot) => ({ key: slot.id, name: cls.name, dayOfWeek: slot.dayOfWeek, startTime: slot.startTime, place: placeOf(cls), venue: cls.locationId }))),
  );

  function openAdd() {
    setEditTarget(null);
    setSaveError(null);
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

  // ?classId=<id>: a link to one class. An active class opens its edit sheet;
  // a paused or archived one has no sheet, so its row below is marked and
  // brought into view. The param is removed either way, so Back does not
  // repeat it.
  // The last value handled, not a flag: a second link to another class while
  // this page stays mounted must work, and a re-run for the same value (strict
  // mode, or the render before Next sees the replaceState) must not.
  const handledClassLink = useRef<string | null>(null);
  const [linkedInactiveId, setLinkedInactiveId] = useState<string | null>(null);
  useEffect(() => {
    const raw = searchParams.get("classId");
    if (raw === null) {
      handledClassLink.current = null;
      return;
    }
    if (handledClassLink.current === raw) return;
    handledClassLink.current = raw;
    const rest = new URLSearchParams(window.location.search);
    rest.delete("classId");
    const query = rest.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : "") + window.location.hash);
    if (!canManage) return;
    const id = parseIdParam(raw);
    const active = classes.find((c) => c.id === id);
    if (active) {
      setLinkedInactiveId(null);
      setEditTarget(active);
      setSaveError(null);
      setDrawerOpen(true);
      return;
    }
    const inactive = inactiveClasses.find((c) => c.id === id);
    setLinkedInactiveId(inactive ? inactive.id : null);
    if (!inactive) showToast("That class isn't on the timetable any more.", "info");
  }, [canManage, searchParams, classes, inactiveClasses, showToast]);
  useEffect(() => {
    if (!linkedInactiveId) return;
    document.querySelector(`[data-testid="inactive-class-${linkedInactiveId}"]`)?.scrollIntoView({ block: "center" });
  }, [linkedInactiveId]);

  function openEdit(cls: ClassRow) {
    setEditTarget(cls);
    setSaveError(null);
    setDrawerOpen(true);
  }

  // A save that added a Location: the new mat is used at once, and the club's other classes it took are shown on it.
  // Returns what to say: classes on the timetable now on it, and the paused or archived ones that went too.
  function takeLocation(loc: LocationAdded, savedId: string, savedIsLive: boolean): string {
    const others = loc.classIds ?? [];
    // Remembered with the saved class too, so a snapshot read before the save cannot put any of them back.
    addMat({ ...loc, classIds: [savedId, ...others] });
    const { live, notLive } = locationCounts(savedIsLive, others, new Set(classes.map((c) => c.id)));
    const said = savedAsLocation(loc.name, live, notLive);
    if (others.length === 0) return said;
    const moved = new Set(others);
    const onIt = (c: ClassRow) => (moved.has(c.id) ? { ...c, matId: loc.id, location: loc.name } : c);
    setClasses((prev) => prev.map(onIt));
    setInactiveClasses((prev) => prev.map(onIt));
    return said;
  }

  async function handleSave(data: Record<string, unknown>) {
    setSaving(true);
    setSaveError(null);
    try {
      // D2 (booking preservation, approved 21 Oct 2026): a change to who can
      // attend — squad list, rank gate or memberships — is previewed first:
      // who is booked and would no longer be admitted (their bookings are
      // KEPT), and who is not booked but would be refused. Nothing is
      // deleted; the owner confirms having seen it.
      if (accessChanged(editTarget, data)) {
        const preview = await fetch(editTarget ? `/api/classes/${editTarget.id}?dryRun=1` : "/api/classes?dryRun=1", {
          method: editTarget ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!preview.ok) {
          const body = await preview.json().catch(() => null);
          throw new ApiRefusal(describeApiError(body), body?.reason);
        }
        const { restriction } = (await preview.json()) as { restriction?: RestrictionPreview };
        if (previewHasRefusals(restriction)) {
          const ok = await ask({
            title: editTarget ? "Check who this change turns away" : "Check who this class turns away",
            body: <RestrictionPreviewBody preview={restriction} editing={!!editTarget} />,
            confirmLabel: editTarget ? "Save — bookings are kept" : "Create class",
          });
          if (!ok) return;
        }
      }
      if (editTarget) {
        const res = await fetch(`/api/classes/${editTarget.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new ApiRefusal(describeApiError(body), body?.reason);
        }
        // `scheduleChange` is a report about the save, not a field of the
        // class — destructured out so it never lands on the row.
        const { scheduleChange, bookingsKeptIneligible, locationAdded, ...updated } = (await res.json()) as {
          scheduleChange: ScheduleChange | null;
          bookingsKeptIneligible?: Partial<Record<"squad" | "rank" | "membership", string[]>>;
          locationAdded?: LocationAdded | null;
        } & Partial<ClassRow>;
        const locationSaid = locationAdded ? takeLocation(locationAdded, editTarget.id, classes.some((c) => c.id === editTarget.id)) : "";
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
        const turnedAway = new Set(Object.values(bookingsKeptIneligible ?? {}).flat()).size;
        showToast(
          (turnedAway > 0
            ? `${describeSave(scheduleChange).replace(/\.?$/, ".")} ${turnedAway} booked ${turnedAway === 1 ? "member is" : "members are"} now turned away at the door; ${turnedAway === 1 ? "the booking is" : "their bookings are"} kept.`
            : describeSave(scheduleChange)) + (locationSaid ? ` ${locationSaid}` : ""),
          kept > 0 || turnedAway > 0 ? "warning" : "success",
        );
      } else {
        const res = await fetch("/api/classes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          // With its reason, so a refused Location is said beside its field.
          throw new ApiRefusal(describeApiError(body), body?.reason);
        }
        // `instancesCreated` is a report about the save (the sessions minted
        // for the next eight weeks), not a field of the class — kept off the row
        // and put in the toast, so "created" also says it is on the timetable.
        const { instancesCreated, locationAdded, ...created } = (await res.json()) as { instancesCreated: number; allowedTierIds?: string[]; locationAdded?: LocationAdded | null } & ClassRow;
        const locationSaid = locationAdded ? takeLocation(locationAdded, created.id, true) : "";
        setClasses((prev) => [...prev, createdClassRow(created, membershipTiers)]);
        showToast(`Class created · ${instancesCreated} sessions added to the timetable${locationSaid ? `. ${locationSaid}` : ""}`, "success");
      }
      // The page's cached copy predates this save; without a refresh, browser
      // Back re-mounts the timetable from it and the change is not shown.
      router.refresh();
      setDrawerOpen(false);
    } catch (err) {
      // In the form, beside the buttons — not a toast that lands on top of them.
      setSaveError({
        message: err instanceof Error && err.message ? err.message : "Something went wrong. Try again.",
        reason: err instanceof ApiRefusal ? err.reason : undefined,
      });
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
      setLifecycleBusy({ id: cls.id, action: "pause" });
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
        router.refresh();
      } catch (err) {
        showToast(err instanceof Error && err.message ? err.message : "Could not pause the class. Try again.", "error");
      } finally {
        setLifecycleBusy((b) => (b?.id === cls.id ? null : b));
      }
    },
    [ask, showToast, router]
  );

  // T6b: Archive — a counted confirmation instead of the old 409. The counts
  // are read first; if they cannot be read the archive does not go ahead.
  const handleArchive = useCallback(
    async (cls: ClassRow) => {
      let counts: { attendanceCount: number; rosterCount: number; bookingCount: number };
      // Busy from the click: the history read can take seconds, and an idle
      // button invited a second click and a second confirmation.
      setLifecycleBusy({ id: cls.id, action: "archive" });
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
        setLifecycleBusy((b) => (b?.id === cls.id ? null : b));
        return;
      }
      const confirmed = await ask({
        title: `Archive ${cls.name}?`,
        body: archiveConfirmBody(counts, cls.lifecycle),
        confirmLabel: "Archive class",
      });
      if (!confirmed) {
        setLifecycleBusy((b) => (b?.id === cls.id ? null : b));
        return;
      }
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
        router.refresh();
      } catch (err) {
        showToast(err instanceof Error && err.message ? err.message : "Could not archive the class. Try again.", "error");
      } finally {
        setLifecycleBusy((b) => (b?.id === cls.id ? null : b));
      }
    },
    [ask, showToast, router]
  );

  // T6b: Resume (paused) / Restore (archived) — both clear the state and put
  // the class back on the timetable; the server mints its upcoming sessions.
  const handleRestore = useCallback(
    async (cls: ClassRow) => {
      const wasArchived = cls.lifecycle === "archived";
      setLifecycleBusy({ id: cls.id, action: "restore" });
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
        router.refresh();
      } catch (err) {
        showToast(
          err instanceof Error && err.message ? err.message : `Could not ${wasArchived ? "restore" : "resume"} the class. Try again.`,
          "error",
        );
      } finally {
        setLifecycleBusy((b) => (b?.id === cls.id ? null : b));
      }
    },
    [showToast, router]
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
      {/* UI-RULES §4a.1: Timetable is the one wide staff page, and its "Hide
          menu" button hides the side menu (app/globals.css .dash-content /
          .dash-shell). The menu can only be hidden while the button that
          brings it back is on screen. */}
      <span hidden data-page-width="wide" data-expand-timetable={expanded && classes.length > 0 ? "true" : undefined} />

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

      {/* UI-RULES §7: the mats could not be read, so the timetable says what it is showing instead. */}
      {matsLoadFailed && (
        <p className="mb-3 flex flex-wrap items-center gap-2 text-sm text-tx-1" role="alert" data-testid="timetable-mats-load-failed">
          Couldn&rsquo;t load the mats, so this is split by time.
          <Button variant="secondary" size="compact" onClick={() => router.refresh()}>Try again</Button>
        </p>
      )}

      {classes.length === 0 ? (
        <>
          {/* Mats do not depend on classes: a club can name its mats before its first class. */}
          {canManage && !matsLoadFailed && (
            <div className="mb-3 flex justify-end">
              <Button variant="secondary" size="compact" onClick={() => setMatsOpen(true)} data-testid="timetable-mats-empty">Mats</Button>
            </div>
          )}
          <EmptyState onAdd={openAdd} primaryColor={primaryColor} canManage={canManage} />
        </>
      ) : (
        <div className="space-y-6">
          {/* Weekly view */}
          {(() => {
            const weekDates = getWeekDates(weekOffset);
            const todayMidnight = new Date();
            todayMidnight.setHours(0, 0, 0, 0);
            // Every screen follows the split (the week, the Day view, the phone, the members' day), so its control is on all three here.
            // A MatFlow edit support session chooses it as the owner does (RULES §5b).
            const showSplit = !matsLoadFailed;
            const todayPill = (
              <span className="rounded-full border border-[color-mix(in_srgb,var(--hue-info)_45%,var(--sf-1))] bg-[color-mix(in_srgb,var(--hue-info)_14%,var(--sf-1))] px-[3px] text-[9px] font-bold uppercase leading-4 tracking-wide text-[var(--hue-info-ink)]">
                Today
              </span>
            );
            // What "By mat" will do while no class is on a mat yet, with the places the club has already typed.
            // One name per place whatever its capitals and spacing; the first spelling met is the one shown.
            const spellings = new Map<string, string>();
            for (const c of classes) {
              const place = c.matId ? "" : (c.location ?? "").trim().replace(/\s+/g, " ");
              if (place && !spellings.has(place.toLowerCase())) spellings.set(place.toLowerCase(), place);
            }
            const typed = [...spellings.values()];
            const typedList = typed.length === 0 ? "" : typed.length <= 3 ? typed.join(typed.length === 2 ? " and " : ", ") : `${typed.slice(0, 2).join(", ")} and ${typed.length - 2} more`;
            const splitHint = !showSplit
              ? null
              : !canManage || inUse > 0
                ? null
                : mats.length === 0
                  ? typedList
                    ? `By mat gives each mat its own column. Press it to set up your mats: your classes say ${typedList}.`
                    : "By mat gives each mat its own column. Press it to add your mats."
                  : "By mat gives each mat its own column. Press it to put your classes on their mats.";
            return (
              <>
                {/* Week navigation. One wrapping row: when it wraps, the right-hand group moves down as a unit. */}
                <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
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
                  {/* On a phone this group is the toolbar's second row: the split control across the width, Mats beside it. */}
                  <div className="flex w-full flex-wrap items-end justify-end gap-2 md:w-auto md:items-center">
                    {(weekOffset !== 0 || (desktopView === "day" && agendaDow !== new Date().getDay())) && (
                      <Button variant="secondary" size="compact" onClick={() => { setWeekOffset(0); setAgendaDow(new Date().getDay()); }}>
                        Today
                      </Button>
                    )}
                    {/* Desktop only: the phone already shows one day at a time. The
                        selected segment is white on the grey track (UI-RULES §4a.5). */}
                    <div className="hidden md:flex items-center gap-1 rounded-lg p-0.5" role="group" aria-label="Timetable view" style={{ background: "var(--sf-2)" }}>
                      {(["week", "day"] as const).map((v) => (
                        <Button
                          key={v}
                          variant="ghost"
                          size="compact"
                          aria-pressed={desktopView === v}
                          onClick={() => setDesktopView(v)}
                          data-testid={`timetable-view-${v}`}
                          className={desktopView === v ? "border" : ""}
                          style={desktopView === v ? { background: "var(--sf-1)", borderColor: "var(--bd-active)", boxShadow: "var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.08))", color: "var(--tx-1)" } : { color: "var(--tx-2)" }}
                        >
                          {v === "week" ? "Week" : "Day"}
                        </Button>
                      ))}
                    </div>
                    {/* How classes at the same time are split: one column per mat, or lanes by
                        time. Owner and manager choose (saved for the club); a coach reads it. */}
                    {showSplit && (
                      <div className="flex min-w-0 flex-1 flex-col gap-1 md:flex-none md:flex-row md:items-center md:gap-2" data-testid="timetable-split">
                        {canManage ? (
                          <>
                            <span id="timetable-split-label" className="text-xs font-medium text-tx-2 md:whitespace-nowrap">Split same-time classes (whole club)</span>
                            <div className="flex items-center gap-1 rounded-lg bg-sf-2 p-0.5 [&>*]:flex-1 md:[&>*]:flex-none" role="group" aria-labelledby="timetable-split-label">
                              {(["mat", "time"] as const).map((v) => {
                                // Never a dead button: with no class on a mat yet, "By mat" opens the mats set-up (its sentence says so).
                                const setsUp = v === "mat" && inUse === 0;
                                return (
                                  <Button
                                    key={v}
                                    variant="ghost"
                                    size="compact"
                                    aria-pressed={layout === v}
                                    aria-describedby={setsUp ? "timetable-split-hint" : undefined}
                                    aria-haspopup={setsUp ? "dialog" : undefined}
                                    onClick={() => void chooseLayout(v)}
                                    data-testid={`timetable-split-${v}`}
                                    className={layout === v ? "border border-bd-active bg-sf-1 text-tx-1 shadow-sm" : "text-tx-2"}
                                  >
                                    {v === "mat" ? "By mat" : "By time"}
                                  </Button>
                                );
                              })}
                            </div>
                          </>
                        ) : (
                          <span className="whitespace-nowrap text-xs font-medium text-tx-2" data-testid="timetable-split-text">Split by {layout === "mat" ? "mat" : "time"}</span>
                        )}
                      </div>
                    )}
                    {canManage && !matsLoadFailed && (
                      <>
                        <Button variant="secondary" size="compact" className="hidden md:inline-flex" onClick={() => setMatsOpen(true)} data-testid="timetable-mats">
                          Mats
                        </Button>
                        <Button variant="secondary" size="compact" className="md:hidden" onClick={() => setMatsOpen(true)} data-testid="timetable-mats-phone">
                          Mats
                        </Button>
                      </>
                    )}
                    <Button variant="secondary" size="compact" className="hidden md:inline-flex" data-needs-has data-testid="timetable-expand" aria-pressed={expanded} onClick={() => setExpanded((v) => !v)}>
                      {expanded ? "Shrink timetable" : "Expand timetable"}
                    </Button>
                  </div>
                </div>
                {/* What "By mat" does while no class is on a mat yet, on its own line under the control. */}
                {splitHint && (
                  <p id="timetable-split-hint" className="-mt-1 mb-3 text-xs text-tx-2 md:text-right" data-testid="timetable-split-hint">
                    {splitHint}
                  </p>
                )}

                {/* ── One day, as the poster grid ────────────────────────────
                    A phone's only view, and the desktop's Day view (Noe, 6 Nov
                    2026: the clock-scale Day view did not show when the day
                    starts; this does). Day tabs, then the day as one card: the
                    same row lines and columns as the week (lib/timetable-grid),
                    so each row starts at a real start time, two classes at the
                    same time sit side by side and a 20-minute class never sits
                    over the one after it. Columns share the width: no sideways
                    scroll. Same chips, same edit gating. */}
                <div className={desktopView === "day" ? "" : "md:hidden"} data-testid={desktopView === "day" ? "day-view" : undefined}>
                  <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-2" role="tablist" aria-label="Day of week">
                    {weekDates.map((date, rawIdx) => {
                      const dow = rawIdx === 6 ? 0 : rawIdx + 1;
                      const isToday = date.getTime() === todayMidnight.getTime();
                      const selected = agendaDow === dow;
                      const count = byDay[dow].length;
                      return (
                        // Selected and today are told apart without the club's colour: a border and
                        // weight for the selected tab, an underline for today (as the Day view's chooser).
                        <Button
                          key={rawIdx}
                          variant="ghost"
                          role="tab"
                          aria-selected={selected}
                          aria-label={`${DAYS_FULL[dow]} ${date.getDate()}${isToday ? ", today" : ""}, ${count === 0 ? "no sessions" : `${count} session${count === 1 ? "" : "s"}`}`}
                          data-today={isToday || undefined}
                          // Choosing a day closes an open "+N more" list: it never follows to another day or comes back with this one.
                          onClick={() => { setAgendaDow(dow); setPhoneMore(null); }}
                          className={[
                            "h-auto shrink-0 flex-col gap-0 rounded-xl border px-3 py-2 text-center font-normal",
                            selected ? "border-bd-active bg-sf-2 hover:bg-sf-2" : "border-bd-default bg-sf-1",
                          ].join(" ")}
                        >
                          <span className={["block text-[10px] uppercase tracking-wider text-tx-2", selected ? "font-bold text-tx-1" : "font-semibold", isToday ? "underline underline-offset-2" : ""].join(" ")}>
                            {DAYS[dow]}
                          </span>
                          <span className="block text-sm font-bold text-tx-1">{date.getDate()}</span>
                          <span className="block text-[10px] tabular-nums text-tx-2">{count === 0 ? "—" : count}</span>
                        </Button>
                      );
                    })}
                  </div>

                  {(() => {
                    const sessions = byDay[agendaDow];
                    const agendaDate = weekDates[agendaDow === 0 ? 6 : agendaDow - 1];
                    const agendaIsToday = agendaDate.getTime() === todayMidnight.getTime();
                    const states = chipStatesFor(sessions, agendaIsToday, cancelledToday);
                    const stateOf = new Map(sessions.map(({ slot }, i) => [slot.id, states[i]] as const));
                    const day = phoneGrid.days[0];
                    const countText = `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
                    // Three lanes leave a phone chip about a third of the card: it keeps the week's smaller sizes.
                    const chipSize = day.lanes >= 3 ? "week" : "phone";
                    const openId = phoneMore && phoneMore.day === agendaDow ? phoneMore.id : null;
                    const labelOf = ({ cls, slot }: DaySession) => {
                      const place = placeOf(cls);
                      const state = stateOf.get(slot.id) ?? null;
                      return (
                        `${canManage ? "Edit " : ""}${cls.name}, ${DAYS_FULL[slot.dayOfWeek]} ${slot.startTime} to ${slot.endTime}${place ? `, ${place}` : mats.length > 0 ? ", no mat" : ""}` +
                        `${state !== null && state !== "upcoming" ? ` (${sessionStateLabel(state).toLowerCase()})` : ""}${duplicates.has(slot.id) ? " (possible duplicate)" : ""}`
                      );
                    };
                    return (
                      // On a wide window the card stops at a readable width (about 300 px a lane) rather than
                      // stretching one class across the screen. Lanes, not grid tracks: a day with a two-way and a
                      // three-way clash has six tracks and three lanes.
                      <div ref={phoneDay} className="mt-1 rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-3" data-testid="phone-day" style={{ maxWidth: Math.max(880, 60 + day.lanes * 300) }}>
                        <div className="mb-2 flex items-center gap-2">
                          <h2 className="text-[15px] font-bold leading-5 text-tx-1">{DAYS_FULL[agendaDow]}</h2>
                          {agendaIsToday ? todayPill : null}
                          {sessions.length > 0 ? <span className="ml-auto text-xs text-tx-2">{countText}</span> : null}
                        </div>
                        {day.fellBack ? (
                          <p className="mb-2 text-xs text-tx-2" data-testid="phone-day-fallback">
                            Too much on at once to show by mat on this screen. Each class shows its mat.
                          </p>
                        ) : null}
                        {sessions.length === 0 ? (
                          <p className="py-6 text-center text-sm text-tx-2">No classes scheduled.</p>
                        ) : (
                          <PosterDay
                            grid={phoneGrid}
                            label={`${DAYS_FULL[agendaDow]} ${agendaDate.getDate()} ${agendaDate.toLocaleDateString("en-GB", { month: "long" })}, ${countText}`}
                            matName={(matId) => (matId === null ? "No mat" : (matNames.get(matId) ?? "No mat"))}
                            testId="phone-day-grid"
                            renderSession={(item) => {
                              const session = sessionByKey.get(item.key);
                              if (!session) return null;
                              const { cls, slot } = session;
                              return (
                                <WeekChip
                                  size={chipSize}
                                  name={cls.name}
                                  dayName={DAYS_FULL[slot.dayOfWeek]}
                                  startTime={slot.startTime}
                                  endTime={slot.endTime}
                                  color={cls.color ?? primaryColor}
                                  place={placeOf(cls)}
                                  // Nothing is pinned on a phone, so every chip says its place, under a mat name too.
                                  showPlace
                                  noPlaceLabel={mats.length > 0 ? "no mat" : undefined}
                                  state={stateOf.get(slot.id) ?? null}
                                  duplicate={duplicates.has(slot.id)}
                                  kids={cls.isKids}
                                  category={classCategoryTag(cls)}
                                  canManage={canManage}
                                  onEdit={() => openEdit(cls)}
                                />
                              );
                            }}
                            renderMore={(item) => (
                              <MoreChip
                                count={item.keys.length}
                                label={`${item.keys.length} more sessions, ${minToTime(item.startMin)} to ${minToTime(item.endMin)}. Show them.`}
                                hint="Show them"
                                expanded={openId === item.id}
                                onOpen={() => setPhoneMore({ day: agendaDow, id: item.id })}
                                onClose={() => setPhoneMore(null)}
                              />
                            )}
                            openMore={openId}
                            renderMorePanel={(item) => {
                              const inCluster = item.clusterKeys.map((key) => sessionByKey.get(key)).filter((s): s is DaySession => !!s);
                              const from = Math.min(...inCluster.map(({ slot }) => spanMinutes(slot.startTime, slot.endTime).startMin));
                              const to = Math.max(...inCluster.map(({ slot }) => spanMinutes(slot.startTime, slot.endTime).endMin));
                              return (
                                <MorePanel
                                  label={`${inCluster.length} sessions, ${minToTime(from)} to ${minToTime(to)}`}
                                  className="bg-sf-1 shadow-md"
                                  closeClassName="text-tx-2"
                                  onClose={(returnFocus) => {
                                    // The button stays in the grid, so focus can go back before the panel is gone.
                                    if (returnFocus) phoneDay.current?.querySelector<HTMLElement>(`[data-cell-more="${item.id}"] button`)?.focus();
                                    setPhoneMore(null);
                                  }}
                                >
                                  {inCluster.map((session) => (
                                    <MoreRow
                                      key={session.slot.id}
                                      label={labelOf(session)}
                                      name={session.cls.name}
                                      startTime={session.slot.startTime}
                                      endTime={session.slot.endTime}
                                      color={session.cls.color ?? primaryColor}
                                      place={placeOf(session.cls)}
                                      canManage={canManage}
                                      onEdit={() => openEdit(session.cls)}
                                    />
                                  ))}
                                </MorePanel>
                              );
                            }}
                            breakLabel={(fromMin, toMin) => `No classes ${minToTime(fromMin)} to ${minToTime(toMin)}`}
                          />
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* ── Desktop: the week as a poster grid ─────────────────────
                    Rows are the real times, so same-time sessions sit side by
                    side and line up across the week. The grid lives in its own
                    scroll box with the day headers and the time gutter pinned
                    (UI-RULES §4a.8); the line above it is a fixed-height slot,
                    so saying "wider than this window" never moves the box. */}
                {desktopView === "week" ? (
                <div className="hidden md:block">
                  <p className="mb-1 h-4 text-xs leading-4 text-tx-2" role="status" data-testid="week-wider">
                    {weekWider ? (expanded || !canExpand ? "Wider than this window. Scroll sideways." : "Wider than this window. Scroll sideways, or expand the timetable.") : ""}
                  </p>
                  {(() => {
                    const todayIdx = weekDates.findIndex((d) => d.getTime() === todayMidnight.getTime());
                    const todayDow = todayIdx === -1 ? null : todayIdx === 6 ? 0 : todayIdx + 1;
                    const dateOf = (dow: number) => weekDates[dow === 0 ? 6 : dow - 1];
                    const stateByKey = new Map<string, SessionState | null>();
                    for (let dow = 0; dow < 7; dow++) {
                      const states = chipStatesFor(byDay[dow], dow === todayDow, cancelledToday);
                      byDay[dow].forEach(({ slot }, i) => stateByKey.set(slot.id, states[i]));
                    }
                    // Where the box opens: today's live class, else its next one, under the pinned header.
                    const todays = todayDow === null ? [] : byDay[todayDow];
                    const liveOrNext = todays.find(({ slot }) => stateByKey.get(slot.id) === "live") ?? todays.find(({ slot }) => stateByKey.get(slot.id) === "next");
                    const count = (n: number) => (n === 0 ? "no sessions" : `${n} session${n === 1 ? "" : "s"}`);
                    // An empty day is as wide as the others while there is room, and 40 px when a full week of
                    // mat columns squeezes it. Squeezed: the same pill, a size down and without its border and
                    // letter-spacing, so "TODAY" stays inside 36 px. The header asks its own width which to show.
                    const todayPillNarrow = (
                      <span className="rounded-full bg-[color-mix(in_srgb,var(--hue-info)_14%,var(--sf-1))] px-[3px] text-[8px] font-bold uppercase leading-[14px] text-[var(--hue-info-ink)]">
                        Today
                      </span>
                    );
                    return (
                      <PosterGrid
                        grid={weekGrid}
                        label="Week timetable"
                        today={todayDow}
                        matName={(matId) => (matId === null ? "No mat" : (matNames.get(matId) ?? "No mat"))}
                        dayLabel={(day) => {
                          const date = dateOf(day.day);
                          return `${DAYS_FULL[day.day]} ${date.getDate()} ${date.toLocaleDateString("en-GB", { month: "long" })}, ${count(day.count)}${day.day === todayDow ? ", today" : ""}`;
                        }}
                        dayHeader={(day) => {
                          const isToday = day.day === todayDow;
                          if (day.count === 0) {
                            return (
                              <span className="@container block w-full">
                                <span className="flex flex-col items-center text-[13px] font-semibold leading-[15px] text-tx-1 @[96px]:hidden" data-empty-head="narrow">
                                  <span>{DAYS[day.day]}</span>
                                  <span>{dateOf(day.day).getDate()}</span>
                                </span>
                                <span className="hidden flex-col items-center gap-px @[96px]:flex" data-empty-head="wide">
                                  <span className="flex items-center gap-1 whitespace-nowrap text-[13px] font-semibold leading-4 text-tx-1">
                                    {DAYS[day.day]} {dateOf(day.day).getDate()}
                                    {isToday ? todayPill : null}
                                  </span>
                                  <span className="whitespace-nowrap text-[11px] leading-[14px] text-tx-2">No classes</span>
                                </span>
                              </span>
                            );
                          }
                          // A one-lane day is too narrow for the name and the pill on one line: the pill takes the count's line.
                          const pillBeside = isToday && day.lanes > 1;
                          return (
                            <>
                              <span className="flex items-center gap-1 whitespace-nowrap text-[13px] font-semibold leading-4 text-tx-1">
                                {DAYS[day.day]} {dateOf(day.day).getDate()}
                                {pillBeside ? todayPill : null}
                              </span>
                              {isToday && !pillBeside ? todayPill : <span className="whitespace-nowrap text-[11px] leading-[14px] text-tx-2">{count(day.count)}</span>}
                            </>
                          );
                        }}
                        emptyDay={(day) => (
                          <span className="@container block w-full">
                            <span className="flex justify-center pt-1.5 text-xs text-tx-2">
                              {day.day === todayDow ? (
                                <>
                                  <span className="@[96px]:hidden">{todayPillNarrow}</span>
                                  <span aria-hidden="true" className="hidden @[96px]:inline">—</span>
                                </>
                              ) : <span aria-hidden="true">—</span>}
                            </span>
                          </span>
                        )}
                        renderSession={(item) => {
                          const session = sessionByKey.get(item.key);
                          if (!session) return null;
                          const { cls, slot } = session;
                          return (
                            <WeekChip
                              name={cls.name}
                              dayName={DAYS_FULL[slot.dayOfWeek]}
                              startTime={slot.startTime}
                              endTime={slot.endTime}
                              color={cls.color ?? primaryColor}
                              place={placeOf(cls)}
                              // Under a pinned mat header the column already says the mat; by time, and under "No mat", the chip says its place.
                              showPlace={layout === "time" || item.matId === null}
                              noPlaceLabel={mats.length > 0 ? "no mat" : undefined}
                              state={stateByKey.get(slot.id) ?? null}
                              duplicate={duplicates.has(slot.id)}
                              kids={cls.isKids}
                              category={classCategoryTag(cls)}
                              canManage={canManage}
                              onEdit={() => openEdit(cls)}
                            />
                          );
                        }}
                        renderMore={(item) => (
                          <MoreChip
                            count={item.keys.length}
                            label={`${item.keys.length} more sessions, ${DAYS_FULL[item.day]} ${minToTime(item.startMin)} to ${minToTime(item.endMin)}. Open the day.`}
                            hint="Open the day"
                            onOpen={() => {
                              // The day opens with this clash listed, where the day folds it too.
                              const folded = oneDayGrid(item.day).items.find((i) => i.type === "more" && i.clusterKeys.includes(item.keys[0]));
                              setAgendaDow(item.day);
                              setPhoneMore(folded && folded.type === "more" ? { day: item.day, id: folded.id } : null);
                              setDesktopView("day");
                            }}
                          />
                        )}
                        breakLabel={(fromMin, toMin) => `No classes ${minToTime(fromMin)} to ${minToTime(toMin)}`}
                        scrollTarget={weekOffset === 0 ? { key: liveOrNext?.slot.id ?? null, day: todayDow } : null}
                        scrollToken={weekOffset}
                        onOverflowChange={setWeekWider}
                      />
                    );
                  })()}
                </div>
                ) : null}
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
            <div className="grid max-w-[72rem] grid-cols-1 lg:grid-cols-2 gap-3">
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
                  busy={lifecycleBusy?.id === cls.id ? lifecycleBusy.action : null}
                  locked={lifecycleBusy !== null}
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
          busy={lifecycleBusy}
          currentId={linkedInactiveId}
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
          mats={mats}
          places={places}
          primaryColor={primaryColor}
          onSave={handleSave}
          onCancel={() => setDrawerOpen(false)}
          saving={saving}
          error={saveError}
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

      {canManage && (
        <MatsSheet
          open={matsOpen}
          onClose={() => { setMatsOpen(false); setWantByMat(false); }}
          onChanged={(opts) => {
            // The sheet has already said what the split is now: the page need not say it again.
            if (opts?.quiet) quietSplit.current = true;
            router.refresh();
            // Opened by pressing "By mat": now that mats are set up, split by mat as asked.
            if (wantByMat) void splitByMatAfterSetup();
          }}
        />
      )}

      <ConfirmDialog {...dialogProps} />
    </>
  );
}
