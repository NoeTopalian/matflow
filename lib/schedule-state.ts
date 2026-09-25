/**
 * Pure timetable geometry and time semantics, shared by the member day view
 * (app/member/schedule) and the staff timetable (components/dashboard/
 * TimetableManager). No React, no Date reads of its own: every function takes
 * minutes since midnight and returns plain data, so the same maths is unit
 * tested at a frozen clock and rendered identically on both shells.
 *
 * ## Time semantics
 *
 * A session occupies the half-open interval `[startMin, endMin)`: it is LIVE at
 * exactly its start minute and ENDED at exactly its end minute. Two sessions
 * where one ends as the other starts do NOT overlap. A session whose end is at
 * or before its start crosses midnight and is read as ending the next day
 * (`endMin + 1440`) — `spanMinutes` does that normalisation once, at the edge.
 *
 * Cancellation is decided FIRST: a cancelled session is "cancelled" whatever
 * the clock says, and it never counts as the next session to start.
 *
 * "Next" is the earliest not-yet-started, not-cancelled session of TODAY;
 * when several share that start minute they are all "next" (a tie is shown as
 * a tie, not resolved by list order). Sessions on other days are "upcoming".
 *
 * Whose clock: both shells compute `nowMin` from the VIEWER's device clock —
 * the member's phone in the club, the owner's laptop at the desk. Nothing
 * currently carries `Tenant.timezone` to either screen; when it does, the
 * caller converts and this file does not change.
 *
 * ## Lane packing
 *
 * `packLanes` groups sessions into clusters of transitively overlapping
 * intervals and assigns each session a lane inside its cluster so that no two
 * overlapping sessions share a lane. A cluster wider than `maxLanes` is marked
 * `dense`: the caller renders it as one expandable group instead of slivers
 * nobody can read or tap. Rendered collision (do two boxes on screen
 * intersect?) is asserted separately in the browser lanes; this file only
 * decides the interval maths.
 */

export type SessionState = "cancelled" | "live" | "ended" | "next" | "upcoming";

export interface SessionSpan {
  /** Minutes since midnight, inclusive. */
  startMin: number;
  /** Minutes since midnight, exclusive. May exceed 1440 for an overnight session. */
  endMin: number;
  cancelled?: boolean;
}

const DAY = 24 * 60;

/** `"18:30"` → 1110. Malformed input reads as 0 rather than NaN. */
export function timeToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const hours = Number.isFinite(h) ? h : 0;
  const mins = Number.isFinite(m) ? m : 0;
  return hours * 60 + mins;
}

/**
 * The `[start, end)` span of a session from its wall-clock strings. An end at
 * or before the start crosses midnight and is pushed into the next day.
 */
export function spanMinutes(startTime: string, endTime: string): { startMin: number; endMin: number } {
  const startMin = timeToMin(startTime);
  let endMin = timeToMin(endTime);
  if (endMin <= startMin) endMin += DAY;
  return { startMin, endMin };
}

/** Temporal state of ONE session against the clock; never "next" (that needs the day). */
export function sessionState(span: SessionSpan, nowMin: number): "cancelled" | "live" | "ended" | "upcoming" {
  if (span.cancelled) return "cancelled";
  if (nowMin >= span.endMin) return "ended";
  if (nowMin >= span.startMin) return "live";
  return "upcoming";
}

/**
 * States for every session of one day. `isToday` false ⇒ every non-cancelled
 * session is "upcoming" (another day has no live, ended or next). Order of the
 * result matches the input.
 */
export function sessionStates(sessions: SessionSpan[], nowMin: number, isToday: boolean): SessionState[] {
  if (!isToday) return sessions.map((s) => (s.cancelled ? "cancelled" : "upcoming"));
  const base = sessions.map((s) => sessionState(s, nowMin));
  let nextStart = Number.POSITIVE_INFINITY;
  sessions.forEach((s, i) => {
    if (base[i] === "upcoming" && s.startMin < nextStart) nextStart = s.startMin;
  });
  return base.map((state, i) =>
    state === "upcoming" && sessions[i].startMin === nextStart ? "next" : state,
  );
}

/** 0..1 of the session elapsed; 0 before it starts, 1 once it has ended. */
export function sessionProgress(span: SessionSpan, nowMin: number): number {
  const length = span.endMin - span.startMin;
  if (length <= 0) return nowMin >= span.endMin ? 1 : 0;
  return Math.min(1, Math.max(0, (nowMin - span.startMin) / length));
}

/** Plain words for the state, for pills and accessible names. */
export function sessionStateLabel(state: SessionState): string {
  switch (state) {
    case "cancelled":
      return "Cancelled";
    case "live":
      return "Live";
    case "ended":
      return "Ended";
    case "next":
      return "Next";
    default:
      return "Upcoming";
  }
}

export interface LanePlacement {
  /** Zero-based column inside the cluster. */
  lane: number;
  /** Number of columns the cluster needs. */
  lanes: number;
  /** Index into `packLanes().clusters`. */
  cluster: number;
}

export interface LaneCluster {
  /** Indexes into the input array, in start order. */
  members: number[];
  startMin: number;
  endMin: number;
  lanes: number;
  /** More columns than `maxLanes`: render as one expandable group. */
  dense: boolean;
}

export interface PackedLanes {
  /** One entry per input session, same order. */
  placements: LanePlacement[];
  clusters: LaneCluster[];
}

const overlaps = (a: SessionSpan, b: SessionSpan) => a.startMin < b.endMin && b.startMin < a.endMin;

/**
 * Cluster transitively overlapping sessions and assign lanes so no two
 * overlapping sessions share one. Deterministic: sessions are placed in start
 * order, longer first on a tie, then input order; each takes the lowest lane
 * that is free at its start.
 */
export function packLanes(sessions: SessionSpan[], opts: { maxLanes?: number } = {}): PackedLanes {
  const maxLanes = opts.maxLanes ?? 3;
  const order = sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.startMin - b.s.startMin || b.s.endMin - b.s.startMin - (a.s.endMin - a.s.startMin) || a.i - b.i);

  const placements: LanePlacement[] = sessions.map(() => ({ lane: 0, lanes: 1, cluster: -1 }));
  const clusters: LaneCluster[] = [];

  // Sweep in start order: a session that starts before the open cluster's
  // running end joins it (transitive overlap); otherwise it opens a new one.
  let open: { members: number[]; laneEnds: number[]; startMin: number; endMin: number } | null = null;
  const close = () => {
    if (!open) return;
    const lanes = open.laneEnds.length;
    const index = clusters.length;
    clusters.push({
      members: open.members,
      startMin: open.startMin,
      endMin: open.endMin,
      lanes,
      dense: lanes > maxLanes,
    });
    for (const m of open.members) {
      placements[m].lanes = lanes;
      placements[m].cluster = index;
    }
    open = null;
  };

  for (const { s, i } of order) {
    if (open && s.startMin < open.endMin) {
      let lane = open.laneEnds.findIndex((end) => end <= s.startMin);
      if (lane === -1) {
        lane = open.laneEnds.length;
        open.laneEnds.push(s.endMin);
      } else {
        open.laneEnds[lane] = s.endMin;
      }
      placements[i].lane = lane;
      open.members.push(i);
      open.endMin = Math.max(open.endMin, s.endMin);
    } else {
      close();
      open = { members: [i], laneEnds: [s.endMin], startMin: s.startMin, endMin: s.endMin };
      placements[i].lane = 0;
    }
  }
  close();

  // Belt and braces: the sweep guarantees this, and a future edit must not
  // silently break it — two overlapping sessions never share a lane.
  for (const c of clusters) {
    for (let x = 0; x < c.members.length; x++) {
      for (let y = x + 1; y < c.members.length; y++) {
        const a = c.members[x];
        const b = c.members[y];
        if (placements[a].lane === placements[b].lane && overlaps(sessions[a], sessions[b])) {
          throw new Error(`packLanes placed overlapping sessions ${a} and ${b} in one lane`);
        }
      }
    }
  }

  return { placements, clusters };
}
