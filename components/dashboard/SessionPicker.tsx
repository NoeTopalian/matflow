"use client";

// The class picker of the staff register (Mark attendance). One list, from
// /api/coach/today, which materialises today's rows and says which session the
// register opens on (lib/register-default.ts). The picker shows the whole day
// in time order and lets the coach choose any session of it.

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Popover, placePopover, type PopoverPlacement } from "@/components/ui/popover";
import { formatTimeRange } from "@/lib/class-time";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { useToast } from "@/components/ui/Toast";
import { describeApiError } from "@/lib/api-field-errors";
import { SQUAD_ONLY_LABEL } from "@/lib/class-tier-gate";

/** One item of GET /api/coach/today. */
export type TodaySession = {
  id: string;
  classId: string;
  name: string;
  coachName: string | null;
  location: string | null;
  color: string | null;
  startTime: string;
  endTime: string | null;
  maxCapacity: number | null;
  attendedCount: number;
  waitlistCount: number;
  status: "ongoing" | "soon" | "future" | "ended";
  /**
   * Called off. The session STAYS in the list — /api/coach/today used to
   * filter it out, so cancelling tonight class made it vanish from the
   * staff own view of the day with nothing said. It is shown struck through
   * and never preselected; check-in refuses it at lib/checkin.ts:148.
   */
  isCancelled: boolean;
  cancellationReason: string | null;
  /** This staff member teaches it — the highlight Noe asked for. */
  isMine: boolean;
  /**
   * T6d: a squad / comp class — it has a roster, so only the members on it
   * may attend. Tagged "Squad only". Absent on an older server.
   */
  rosterOnly?: boolean;
  /** The mat the class is on, when it is on one. Absent on an older server. */
  matName?: string | null;
  /** That mat's place in the club's order (the timetable's), null with no mat. */
  matOrder?: number | null;
  /**
   * On the ONE session the register opens on: why it was chosen. Worked out on
   * the server from the club's clock (lib/register-default.ts).
   */
  auto?: "on_now" | "up_next" | "last_today";
  /** With `auto`: how many sessions are on now. */
  onNowCount?: number;
};

/**
 * Which session opens by default. `?class=` wins when that class has a live
 * session today; otherwise the session the server chose (on now, up next, or
 * the last class of the day). Mark Attendance used to open on instances[0], the
 * earliest class of the day, so at 12:30 it offered the 10:00 class.
 */
export function pickDefault(sessions: TodaySession[], preselectClassId: string | null): string | null {
  // Never open on a cancelled session. /api/coach/today now RETURNS cancelled
  // sessions — it used to filter them out, so calling one off made it vanish
  // from the staff's own view of the day — but every check-in into one is
  // refused at lib/checkin.ts:148, so preselecting it would open a screen that
  // cannot do the one thing it is for.
  const live = sessions.filter((s) => !s.isCancelled);
  if (preselectClassId) {
    const match = live.find((s) => s.classId === preselectClassId);
    if (match) return match.id;
  }
  // The server's choice: on now, else up next, else the last class of the day.
  const chosen = live.find((s) => s.auto);
  if (chosen) return chosen.id;
  // An older server says nothing: the first on now, then the next, never one that has ended.
  for (const status of ["ongoing", "soon", "future"] as const) {
    const first = live.find((s) => s.status === status);
    if (first) return first.id;
  }
  return null;
}

/** A small status label. Its text is part of the row's accessible name, so the state is never colour alone. */
export function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
      style={{ background: "color-mix(in srgb, currentColor 16%, transparent)" }}
    >
      {children}
    </span>
  );
}

/** The roles PATCH /api/classes/[id]/instances/[instanceId] admits. */
export const CAN_CANCEL_SESSION_ROLES = ["owner", "manager"] as const;

/**
 * Cancel or restore the selected session (verifier lane 3, D1). The route had
 * existed since J33 and nothing called it — the timetable's own toast told the
 * desk to "cancel them from the register" and the register had no such
 * control. Cancel needs a reason (members see it beside the struck-through
 * session); restore clears it. Shown only to the roles the route admits; on
 * any refusal the route's own sentence is shown, never a silent no-op.
 */
const STALE = Symbol("register day stale");

export function SessionCancelControl({
  session,
  onChanged,
  onOpenChange,
  beforeWrite,
  registerDay,
  onDayStale,
}: {
  session: TodaySession;
  onChanged: () => void | Promise<void>;
  /**
   * Told when the confirmation opens and closes (the scanner is paused while it
   * is open). Called from the handlers themselves, in the same event as the
   * dialog, so the pause takes effect in the same render.
   */
  onOpenChange?: (open: boolean) => void;
  /** Asked just before the cancel or restore is sent; false means "send nothing" (the club's day has moved on). */
  beforeWrite?: () => boolean;
  /** The club date the register was read for, sent with the cancel or restore (lib/register-day.ts). */
  registerDay?: string;
  /** The server refused because that date has passed (409 REGISTER_DAY_STALE): the club's date now. */
  onDayStale?: (clubDate: string | null) => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const reasonId = useId();
  const errorId = useId();
  const close = () => {
    setOpen(false);
    onOpenChange?.(false);
  };
  // Gone while open (another class was chosen): the confirmation went with it.
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);

  /** null when it was saved; a sentence when it failed; STALE when the server says the register's day has passed. */
  async function patch(isCancelled: boolean, cancellationReason?: string): Promise<string | null | typeof STALE> {
    try {
      const res = await fetch(`/api/classes/${session.classId}/instances/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(isCancelled ? { isCancelled, cancellationReason } : { isCancelled }), ...(registerDay ? { registerDay } : {}) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (res.status === 409 && body?.code === "REGISTER_DAY_STALE") {
          onDayStale?.(typeof body.clubDate === "string" ? body.clubDate : null);
          return STALE;
        }
        return describeApiError(body);
      }
      return null;
    } catch {
      return "Couldn't reach MatFlow — check the connection and try again.";
    }
  }

  async function confirmCancel() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Give a reason — members see it beside the cancelled session.");
      return;
    }
    if (beforeWrite && !beforeWrite()) {
      close();
      return;
    }
    const failure = await patch(true, trimmed);
    if (failure === STALE) {
      close();
      return;
    }
    if (failure) {
      setError(failure);
      return;
    }
    close();
    setReason("");
    setError(null);
    toast(`${session.name} at ${session.startTime} cancelled`, "success");
    await onChanged();
  }

  async function restore() {
    if (beforeWrite && !beforeWrite()) return;
    setRestoring(true);
    const failure = await patch(false);
    setRestoring(false);
    if (failure === STALE) return;
    if (failure) {
      toast(failure, "error");
      return;
    }
    toast(`${session.name} at ${session.startTime} restored`, "success");
    await onChanged();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {session.isCancelled ? (
        <>
          <p className="text-sm text-tx-2">
            Cancelled{session.cancellationReason ? `: ${session.cancellationReason}` : ""}
          </p>
          <Button variant="secondary" size="compact" loading={restoring} onClick={() => void restore()}>
            Restore session
          </Button>
        </>
      ) : (
        <Button
          variant="secondary"
          size="compact"
          onClick={() => {
            setError(null);
            setOpen(true);
            onOpenChange?.(true);
          }}
        >
          Cancel this session
        </Button>
      )}
      <ConfirmDialog
        open={open}
        onClose={() => {
          close();
          setError(null);
        }}
        onConfirm={confirmCancel}
        title={`Cancel ${session.name} at ${session.startTime}?`}
        description="Members see it struck through with your reason, and check-in into it is refused. The register is kept, and you can restore the session afterwards."
        confirmLabel="Cancel this session"
        cancelLabel="Keep it"
        destructive
      >
        <div className="mt-4 space-y-1.5">
          <label htmlFor={reasonId} className="block text-[13px] font-medium text-tx-2">
            Reason (members see this)
          </label>
          <input
            id={reasonId}
            type="text"
            value={reason}
            maxLength={200}
            onChange={(e) => {
              setReason(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Coach ill, back Thursday"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="w-full rounded-[var(--r-sm)] border border-bd-default bg-sf-1 px-3 py-2 text-sm text-tx-1 outline-none transition-colors focus:border-bd-active"
          />
          {error && (
            <p id={errorId} role="alert" className="text-[13px] text-[var(--hue-danger-ink)]">
              {error}
            </p>
          )}
        </div>
      </ConfirmDialog>
    </div>
  );
}

/** The mat a session is on when it has one, else the place typed on the class; null when neither is known. */
export function matLabel(s: Pick<TodaySession, "matName" | "location">): string | null {
  return s.matName?.trim() || s.location?.trim() || null;
}

/** What the selected-class card and the picker say about a session's place in the day. */
export function sessionLabel(s: TodaySession): string {
  if (s.isCancelled) return "Cancelled";
  if (s.auto === "last_today") return "Last class today";
  if (s.status === "ongoing") return "On now";
  if (s.auto === "up_next") return "Up next";
  return s.status === "ended" ? "Earlier today" : "Later today";
}

/**
 * Every session of the day in the order the picker shows them: by start time,
 * earliest first; sessions that start together in the club's mat order (a
 * session with no mat after those that have one), then by name and id so two
 * classes of the same name stay apart and in one place.
 */
export function groupByStart(sessions: TodaySession[]): Array<{ startTime: string; sessions: TodaySession[] }> {
  const NO_MAT = Number.MAX_SAFE_INTEGER;
  const sorted = sessions.slice().sort(
    (a, b) =>
      a.startTime.localeCompare(b.startTime) ||
      (a.matOrder ?? NO_MAT) - (b.matOrder ?? NO_MAT) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  const groups: Array<{ startTime: string; sessions: TodaySession[] }> = [];
  for (const s of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.startTime === s.startTime) last.sessions.push(s);
    else groups.push({ startTime: s.startTime, sessions: [s] });
  }
  return groups;
}

/** How the picker is shown: a popover hung from the button, or the sheet. */
export type PickerPlacement = { kind: "sheet" } | ({ kind: "popover" } & PopoverPlacement);

/** A popover on a wide window with room for a usable list below or above the button; otherwise the sheet. */
export function placePicker(
  anchor: { top: number; bottom: number; left: number },
  viewport: { width: number; height: number },
): PickerPlacement {
  const popover = placePopover(anchor, viewport);
  return popover ? { kind: "popover", ...popover } : { kind: "sheet" };
}

function SessionRows({
  sessions,
  selectedId,
  onSelect,
  selectedRef,
}: {
  sessions: TodaySession[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  selectedRef?: RefObject<HTMLButtonElement | null>;
}) {
  const groups = groupByStart(sessions);
  return (
    <div className="space-y-4" data-testid="class-picker-list">
      {groups.map((g) => (
        <section key={g.startTime} aria-label={`Starting at ${g.startTime}`}>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-tx-3">{g.startTime}</h3>
          <ul className="space-y-1.5">
            {g.sessions.map((c) => {
              const selected = c.id === selectedId;
              const mat = matLabel(c);
              return (
                <li key={c.id}>
                  {/* One row per SESSION (its own id), so two classes at one time, or two
                      sessions of one class, are two rows. `aria-current` and the tick say
                      which is selected; the row keeps its place in the order either way. */}
                  <Button
                    variant="secondary"
                    ref={selected ? selectedRef : undefined}
                    data-session-id={c.id}
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onSelect(c.id)}
                    className={[
                      "h-auto min-h-14 w-full items-start justify-start gap-3 whitespace-normal px-3 py-2.5 text-left font-normal",
                      selected ? "border-bd-active" : "bg-sf-1",
                    ].join(" ")}
                  >
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
                      {selected && <Check className="size-5 text-tx-1" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block break-words text-sm font-medium text-tx-1 ${c.isCancelled ? "line-through" : ""}`}>{c.name}</span>
                      <span className="block text-[13px] text-tx-3">
                        {formatTimeRange(c.startTime, c.endTime)}
                        {mat ? ` · ${mat}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1 text-tx-2">
                      {selected && <span className="sr-only">Selected</span>}
                      <Tag>{sessionLabel(c)}</Tag>
                      {c.isMine && <Tag>Yours</Tag>}
                      {c.rosterOnly && <Tag>{SQUAD_ONLY_LABEL}</Tag>}
                    </span>
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * "Change class": every session of the club's day the member of staff may
 * mark, one row each. Choosing a row switches once and closes; Close, Escape
 * or a tap outside closes and changes nothing. A popover hung from the button
 * on a wide window with room for it, a bottom sheet everywhere else.
 */
export default function ClassPicker({
  placement,
  sessions,
  selectedId,
  dateLabel,
  onSelect,
  onClose,
}: {
  /** null = closed. */
  placement: PickerPlacement | null;
  sessions: TodaySession[];
  selectedId: string | null;
  /** The club's date, in the club's zone. */
  dateLabel: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  if (!placement) return null;
  const rows = <SessionRows sessions={sessions} selectedId={selectedId} onSelect={onSelect} selectedRef={selectedRef} />;
  if (placement.kind === "popover") {
    return (
      <Popover placement={placement} title="Change class" description={dateLabel} onClose={onClose} initialFocusRef={selectedRef}>
        {rows}
      </Popover>
    );
  }
  return (
    <Sheet open onClose={onClose} title="Change class" description={dateLabel} initialFocusRef={selectedRef}>
      {rows}
    </Sheet>
  );
}
