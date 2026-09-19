"use client";

// The session picker every attendance surface shares. One list, from
// /api/coach/today, which materialises today's rows and orders them
// ongoing → soon → future → ended. The client's only job is to show that
// order honestly and preselect the top of it.

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/ErrorState";

/** One item of GET /api/coach/today. */
export type TodaySession = {
  id: string;
  classId: string;
  name: string;
  coachName: string | null;
  location: string | null;
  color: string | null;
  startTime: string;
  endTime: string;
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
};

/**
 * Which session opens by default. `?class=` wins when that class has a session
 * today; otherwise the one on now, then the next, then the rest of the day —
 * never one that has ended. Mark Attendance used to open on instances[0], the
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
  for (const status of ["ongoing", "soon", "future"] as const) {
    const first = live.find((s) => s.status === status);
    if (first) return first.id;
  }
  return null;
}

const BADGE: Record<TodaySession["status"], string | null> = {
  ongoing: "Now",
  soon: "Next",
  future: null,
  ended: "Ended",
};

function Tag({ children }: { children: React.ReactNode }) {
  // Inherits the button's ink so it reads on both the primary and secondary
  // variants; the wash is the ink at low alpha. `aria-hidden`: the button's
  // accessible NAME stays exactly "HH:MM · class · location" (what every spec
  // and every screen reader already knows it as); the status reaches
  // assistive tech through the button's aria-describedby instead.
  return (
    <span
      aria-hidden="true"
      className="ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
      style={{ background: "color-mix(in srgb, currentColor 16%, transparent)" }}
    >
      {children}
    </span>
  );
}

const DESCRIPTION: Record<TodaySession["status"], string> = {
  ongoing: "On now",
  soon: "Next",
  future: "Later today",
  ended: "Ended",
};

export default function SessionPicker({
  sessions,
  error,
  selectedId,
  onSelect,
  onRetry,
}: {
  sessions: TodaySession[] | null;
  error: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
}) {
  if (error) {
    return <ErrorState message="Couldn't load today's classes — tap to retry" onRetry={onRetry} />;
  }
  if (sessions === null) {
    return <p className="text-sm text-tx-3">Loading today&rsquo;s classes…</p>;
  }
  if (sessions.length === 0) {
    return (
      <p className="text-sm text-tx-3">
        Nothing scheduled today. Add a class on the timetable and it appears here straight away.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <span id="scan-session-label" className="block text-sm font-medium text-tx-2">
        Session
      </span>
      {/* A horizontal chip rail on the phone (one thumb, no wrapping below the
          fold), wrapping from lg:. Which session is selected must not be
          conveyed by colour alone: `aria-pressed` carries it. */}
      <div
        role="group"
        aria-labelledby="scan-session-label"
        className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0 lg:pb-0"
        style={{ scrollbarWidth: "none" }}
      >
        {sessions.map((c) => {
          const selected = c.id === selectedId;
          const badge = BADGE[c.status];
          const descriptionId = `session-${c.id}-status`;
          // `relative`: the sr-only description below is absolutely positioned,
          // and without a positioned wrapper it escaped the scrolling rail and
          // sat at x≈515 on a 390 px phone — which widened the layout viewport
          // to 516 and pushed every fixed sheet (the confirm dialog included)
          // half off the screen. Measured, 18 Sep 2026.
          return (
            <span key={c.id} className="relative shrink-0 snap-start">
              <Button
                variant={selected ? "primary" : "secondary"}
                aria-pressed={selected}
                aria-describedby={descriptionId}
                onClick={() => onSelect(c.id)}
              >
                {/* Struck through AND labelled: the state must not be carried
                    by the line alone, so the tag says it and the sr-only
                    description below says it to assistive tech. */}
                <span className={c.isCancelled ? "line-through" : undefined}>
                  {c.startTime} · {c.name}
                  {c.location ? ` · ${c.location}` : ""}
                </span>
                {c.isCancelled ? <Tag>Cancelled</Tag> : badge && <Tag>{badge}</Tag>}
                {c.isMine && <Tag>Yours</Tag>}
              </Button>
              <span id={descriptionId} className="sr-only">
                {c.isCancelled
                  ? `Cancelled${c.cancellationReason ? `: ${c.cancellationReason}` : ""}`
                  : DESCRIPTION[c.status]}
                {c.isMine ? ", yours" : ""}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
