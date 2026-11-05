/**
 * How a club's timetable splits classes that are on at the same time.
 *
 * "mat"  — one column per mat, like a printed two-mat timetable.
 * "time" — classes side by side in whatever lanes they need.
 *
 * Until someone chooses, the timetable follows the mats: by mat while two or
 * more mats have a class on them, otherwise by time. That is worked out each
 * time and never saved; `Tenant.timetableLayout` holds only a choice somebody
 * pressed (PATCH /api/timetable/layout is its one writer). By mat means
 * nothing while no class is on a mat, so that case is always by time.
 *
 * Pure: no I/O, safe in client components.
 */

export type TimetableLayout = "mat" | "time";

export function isTimetableLayout(value: unknown): value is TimetableLayout {
  return value === "mat" || value === "time";
}

/** The split in effect. `matsInUse` counts mats with at least one live class. */
export function effectiveLayout(stored: string | null | undefined, matsInUse: number): TimetableLayout {
  if (matsInUse <= 0) return "time";
  if (isTimetableLayout(stored)) return stored;
  return matsInUse >= 2 ? "mat" : "time";
}

/** How many of the club's mats have at least one of these classes on them. Pass the live classes. */
export function matsInUse(classes: readonly { matId?: string | null }[], mats: readonly { id: string }[]): number {
  const used = new Set<string>();
  for (const c of classes) if (c.matId) used.add(c.matId);
  let n = 0;
  for (const m of mats) if (used.has(m.id)) n += 1;
  return n;
}
