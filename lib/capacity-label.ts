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

/** "1 space left", "3 spaces left" — never "1 spaces". */
export function spacesLeftText(n: number): string {
  return `${n} ${n === 1 ? "space" : "spaces"} left`;
}

export type CapacityTone = "danger" | "warning" | "muted";

export type CapacityLabel = {
  /** The pill beside the class name, or null when there is nothing to say. */
  badge: "Over capacity" | "Full" | "Almost full" | null;
  tone: CapacityTone;
  /** The figure column: "1 space left" / "Full" / "Over capacity". */
  primary: string;
  /** The line under it: "of 4" / "3 of 3" / "4 of 3". */
  secondary: string;
  /** One short phrase for a tight cell: "1 left" / "Full" / "Over · 4 of 3". */
  short: string;
};

/**
 * Every capacity word on the dashboard and timetable comes from here (end-user
 * round 3, 30 Sep 2026: "Full" for a class of 3 holding 4, "Full spots",
 * "1 spaces left", "ALMOST FULL" in capitals). A class past its capacity says
 * so — "Over capacity · 4 of 3" — rather than reading as merely full.
 * Returns null when the class has no capacity limit.
 */
export function capacityLabel(capacity: number | null | undefined, taken: number): CapacityLabel | null {
  const s = capacityState(capacity, taken);
  if (s.spotsLeft == null || capacity == null) return null;
  const used = Math.max(0, taken);
  if (used > capacity) {
    return {
      badge: "Over capacity",
      tone: "danger",
      primary: "Over capacity",
      secondary: `${used} of ${capacity}`,
      short: `Over · ${used} of ${capacity}`,
    };
  }
  if (s.full) {
    return { badge: "Full", tone: "danger", primary: "Full", secondary: `${used} of ${capacity}`, short: "Full" };
  }
  return {
    badge: s.almostFull ? "Almost full" : null,
    tone: s.almostFull ? "warning" : "muted",
    primary: spacesLeftText(s.spotsLeft),
    secondary: `of ${capacity}`,
    short: `${s.spotsLeft} left`,
  };
}
