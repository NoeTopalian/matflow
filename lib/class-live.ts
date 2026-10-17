/**
 * T6b (Sean note 7): a class's lifecycle, and the one predicate every reader
 * uses for "on the timetable".
 *
 * Owner decision, 17 Oct 2026 (Q7):
 *  - PAUSED   = `isActive = false`, `deletedAt = null`. Hidden from the
 *    timetable, booking, the member app and the kiosk; no new sessions are
 *    generated; history and bookings are kept; one click resumes it.
 *  - ARCHIVED = `isActive = false` and `deletedAt` set. Removed from the
 *    timetable and every list; history is kept (reports still count its
 *    check-ins); Restore puts it back.
 *  - RESTORE / RESUME clear both.
 *  - A class an attendance-history import created (`sourceImportJobId` set)
 *    is never live and can never be put back on the timetable.
 *
 * Pure: no I/O, safe in client components.
 */

export type ClassLifecycle = "active" | "paused" | "archived";

type LifecycleFields = {
  isActive: boolean;
  deletedAt: Date | string | null;
};

/** The state a class row is in. `deletedAt` wins: an archived class is archived whatever `isActive` says. */
export function classLifecycle(c: LifecycleFields): ClassLifecycle {
  if (c.deletedAt) return "archived";
  return c.isActive ? "active" : "paused";
}

/**
 * A class that is on the timetable: active, not archived, not imported
 * history. The `where` for `Class` (or a `class: …` relation filter).
 */
export function liveClassWhere(tenantId: string) {
  return {
    tenantId,
    isActive: true,
    deletedAt: null,
    sourceImportJobId: null,
  } as const;
}

/**
 * A session members can be offered: a live class's session that is not
 * cancelled and was not created by an attendance-history import. The `where`
 * for `ClassInstance`. Readers that show cancelled sessions on purpose (the
 * staff day view, the member's day) filter `class: liveClassWhere(...)`
 * instead and flag `isCancelled` themselves.
 */
export function liveSessionWhere(tenantId: string) {
  return {
    isCancelled: false,
    sourceImportJobId: null,
    class: liveClassWhere(tenantId),
  } as const;
}

/**
 * The classes the timetable's "Paused and archived" section lists: every
 * class of the club that is not live, except imported history, which the
 * import's own Rollback owns.
 */
export function inactiveClassWhere(tenantId: string) {
  return {
    tenantId,
    sourceImportJobId: null,
    OR: [{ isActive: false }, { deletedAt: { not: null } }],
  };
}

/** Refused when anyone tries to put an imported history class on the timetable. */
export const IMPORTED_CLASS_REACTIVATE_REFUSAL =
  "This class holds imported attendance history, so it can't be put on the timetable. Create a new class instead.";

/** What the member app, kiosk and booking say about a paused or archived class. */
export function classNotLiveSentence(className: string, state: Exclude<ClassLifecycle, "active">): string {
  return state === "archived"
    ? `${className} is no longer on the timetable, so check-in and booking are closed.`
    : `${className} is paused at the moment, so check-in and booking are closed. Ask staff when it's back.`;
}
