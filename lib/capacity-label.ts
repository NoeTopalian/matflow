/**
 * Class capacity state for timetable labels (dashboard day list, member home).
 *
 * "Almost full" used to mean "three or fewer places left" — so a class with a
 * capacity of 3 and NOBODY booked was labelled "ALMOST FULL · 3 / 3 spots",
 * which an owner reads as full (end-user simulation, 30 Sep 2026). The label
 * now follows what has been taken, not the capacity alone: at least one place
 * taken, and the places left are at most a quarter of the class (never more
 * than three).
 */
export type CapacityState = {
  /** Places left, never negative. Null when the class has no capacity limit. */
  spotsLeft: number | null;
  full: boolean;
  almostFull: boolean;
};

export function capacityState(capacity: number | null | undefined, taken: number): CapacityState {
  if (capacity == null || capacity <= 0) return { spotsLeft: null, full: false, almostFull: false };
  const used = Math.max(0, taken);
  const spotsLeft = Math.max(0, capacity - used);
  const full = spotsLeft === 0;
  const threshold = Math.min(3, Math.ceil(capacity / 4));
  const almostFull = !full && used > 0 && spotsLeft <= threshold;
  return { spotsLeft, full, almostFull };
}
