import { withTenantContext } from "@/lib/prisma-tenant";

/**
 * Per-staff conversion analytics (M1) + the per-step funnel (Reports UX cycle,
 * 2026-09-23).
 *
 * Answers the question Sean actually asks: "these coaches ran N trials,
 * converted M — here's each coach's %", and now the follow-up: WHERE do the
 * rest go? Every trial a coach ran ends up in exactly one of three places —
 * converted, lost (cancelled before ever joining), or still deciding — and
 * every conversion is either still active or has since churned. The numbers
 * come only from real attribution columns (Member.trialRunById /
 * creditedToUserId) and the MemberStatusEvent trail — never fabricated, and
 * honest about what it cannot yet say (see the three guards below).
 *
 * Three guards keep the percentages from lying:
 *   1. min-N — a rate over fewer than MIN_TRIALS_FOR_RATE trials is noise, so
 *      we return `null` ("N/A, too few") rather than a headline 100% off one
 *      taster. The same threshold applies to the retention rate's denominator.
 *   2. feature-epoch — attribution only started being recorded on a date; the
 *      caller labels the window "since <epochStart>" so the hundreds of members
 *      who predate the feature (and carry no attribution) don't drag every
 *      coach's rate toward 0%.
 *   3. import exclusion — bulk-import status events are excluded from the
 *      conversion AND lost sets upstream (the queries filter `reason != import`),
 *      because a roster import is not a coach converting or losing a taster.
 */

/** Below this many trials (or conversions), a rate is statistically meaningless. */
export const MIN_TRIALS_FOR_RATE = 3;

export interface StaffConversionRow {
  userId: string;
  name: string;
  /** Members whose trial this staff member ran (Member.trialRunById = them). */
  trialsRun: number;
  /** Members this staff member gets sign-up credit for (creditedToUserId = them). */
  signUps: number;
  /** Of their trials, how many later reached `active` (import events excluded). */
  conversions: number;
  /** conversions / trialsRun as a percentage to one decimal, or `null` when too few. */
  conversionRate: number | null;
  /** Of their trials: cancelled before ever becoming active (taster → cancelled). */
  lost: number;
  /** Of their trials: neither converted nor lost yet — still deciding. */
  undecided: number;
  /** Of their conversions: currently `active`. */
  retained: number;
  /** Of their conversions: no longer active — churned after joining. */
  churned: number;
  /** retained / conversions as a percentage to one decimal, or `null` when too few conversions. */
  retentionRate: number | null;
}

/**
 * One funnel, whoever it is for: the three steps (trials → converted → still
 * active) and the two drop-offs between them, plus the undecided remainder.
 * Invariants the unit test pins: `converted + lost + undecided === trials` and
 * `retained + churned === converted`.
 */
export interface FunnelSteps {
  trials: number;
  converted: number;
  retained: number;
  lost: number;
  undecided: number;
  churned: number;
  conversionRate: number | null;
  retentionRate: number | null;
}

export interface AttributionData {
  rows: StaffConversionRow[];
  /** The rows summed — the club-wide funnel over every trial that has a coach attached. */
  overall: FunnelSteps;
  /** ISO timestamp of the first attribution event, or null if none yet. */
  epochStart: string | null;
  /** Echoed so the client renders the same threshold the math used. */
  minTrials: number;
}

/**
 * numerator / denominator as a percentage, one decimal place. Returns `null`
 * (the min-N guard) when the denominator is below MIN_TRIALS_FOR_RATE — the
 * caller must render "N/A" rather than a number for a null.
 */
export function computeRate(denominator: number, numerator: number): number | null {
  if (denominator < MIN_TRIALS_FOR_RATE) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** conversions / trialsRun — kept as a named function; the attribution tests pin it. */
export function computeConversionRate(trialsRun: number, conversions: number): number | null {
  return computeRate(trialsRun, conversions);
}

/**
 * Pure aggregation — no DB. Kept separate from the query so the guard logic is
 * unit-testable with plain arrays. Only staff with some activity (a trial run
 * or a sign-up) appear; a coach who has done neither is not a zero-row, they
 * are simply not in the funnel. Sorted by trials run, then sign-ups, desc.
 *
 * Each trial member lands in exactly one bucket, in this priority: converted
 * (a real `→ active` event) beats lost (a `taster → cancelled` event) — a
 * member who joined, left, and is now cancelled is a conversion that CHURNED,
 * not a lost trial. Anyone in neither set is still deciding.
 */
export function buildStaffConversionRows(params: {
  staff: { id: string; name: string }[];
  trialMembers: { id: string; trialRunById: string | null; status?: string | null }[];
  signUpMembers: { creditedToUserId: string | null }[];
  /** Member ids that reached `active` via a non-import status event. */
  convertedMemberIds: Set<string>;
  /** Member ids with a non-import `taster → cancelled|inactive` event (lost before joining). */
  lostMemberIds?: Set<string>;
  /**
   * Member ids that arrived by roster import. Guard 3 applied symmetrically:
   * an imported member can never be a conversion, so they must not be a trial
   * either — otherwise back-filling "who ran this person's trial" on a migrated
   * roster drags every coach's rate down and files paying members under
   * "no decision recorded".
   */
  importedMemberIds?: Set<string>;
}): StaffConversionRow[] {
  const { staff, trialMembers, signUpMembers, convertedMemberIds } = params;
  const lostMemberIds = params.lostMemberIds ?? new Set<string>();
  const importedMemberIds = params.importedMemberIds ?? new Set<string>();

  const signUpsByUser = new Map<string, number>();
  for (const member of signUpMembers) {
    if (!member.creditedToUserId) continue;
    signUpsByUser.set(member.creditedToUserId, (signUpsByUser.get(member.creditedToUserId) ?? 0) + 1);
  }

  type Tally = { trials: number; conversions: number; lost: number; retained: number; churned: number };
  const tallyByUser = new Map<string, Tally>();
  const tallyFor = (userId: string): Tally => {
    let t = tallyByUser.get(userId);
    if (!t) {
      t = { trials: 0, conversions: 0, lost: 0, retained: 0, churned: 0 };
      tallyByUser.set(userId, t);
    }
    return t;
  };

  for (const member of trialMembers) {
    if (!member.trialRunById) continue;
    if (importedMemberIds.has(member.id)) continue;
    const t = tallyFor(member.trialRunById);
    t.trials += 1;
    if (convertedMemberIds.has(member.id)) {
      t.conversions += 1;
      if (member.status === "active") t.retained += 1;
      else t.churned += 1;
    } else if (
      lostMemberIds.has(member.id) ||
      // Staff have two ways to retire a taster — cancel or set inactive — and
      // both mean the trial is over without a join. Read the CURRENT status
      // too, so a taster retired by any path counts as lost, never as a
      // decision still open.
      member.status === "cancelled" ||
      member.status === "inactive"
    ) {
      t.lost += 1;
    }
  }

  const rows: StaffConversionRow[] = [];
  for (const user of staff) {
    const t = tallyByUser.get(user.id);
    const trialsRun = t?.trials ?? 0;
    const signUps = signUpsByUser.get(user.id) ?? 0;
    if (trialsRun === 0 && signUps === 0) continue;
    const conversions = t?.conversions ?? 0;
    const lost = t?.lost ?? 0;
    const retained = t?.retained ?? 0;
    const churned = t?.churned ?? 0;
    rows.push({
      userId: user.id,
      name: user.name,
      trialsRun,
      signUps,
      conversions,
      conversionRate: computeConversionRate(trialsRun, conversions),
      lost,
      undecided: trialsRun - conversions - lost,
      retained,
      churned,
      retentionRate: computeRate(conversions, retained),
    });
  }

  rows.sort((a, b) => b.trialsRun - a.trialsRun || b.signUps - a.signUps || a.name.localeCompare(b.name, "en-GB"));
  return rows;
}

/** The rows summed into one club-wide funnel, rates re-derived from the sums (never averaged). */
export function buildFunnel(rows: StaffConversionRow[]): FunnelSteps {
  let trials = 0, converted = 0, retained = 0, lost = 0, undecided = 0, churned = 0;
  for (const row of rows) {
    trials += row.trialsRun;
    converted += row.conversions;
    retained += row.retained;
    lost += row.lost;
    undecided += row.undecided;
    churned += row.churned;
  }
  return {
    trials,
    converted,
    retained,
    lost,
    undecided,
    churned,
    conversionRate: computeRate(trials, converted),
    retentionRate: computeRate(converted, retained),
  };
}

/**
 * Tenant-scoped fetch + aggregate for the attribution dashboard AND the Reports
 * funnel. Every read is filtered on tenantId (RLS is the backstop, not the
 * primary defence).
 */
export async function getAttributionData(tenantId: string): Promise<AttributionData> {
  return withTenantContext(tenantId, async (tx) => {
    const [staff, trialMembers, signUpMembers, convertedEvents, lostEvents, importedEvents, epochEvent] = await Promise.all([
      tx.user.findMany({
        where: { tenantId },
        select: { id: true, name: true },
      }),
      // `status` is the member's CURRENT state — it decides retained vs churned
      // for a conversion. The event trail decides converted vs lost.
      tx.member.findMany({
        where: { tenantId, trialRunById: { not: null } },
        select: { id: true, trialRunById: true, status: true },
      }),
      tx.member.findMany({
        where: { tenantId, creditedToUserId: { not: null } },
        select: { creditedToUserId: true },
      }),
      // The conversion set: members who reached `active` through a real
      // transition. import events are excluded here so a bulk import never
      // reads as a coach's conversion (guard 3).
      tx.memberStatusEvent.findMany({
        where: { tenantId, toStatus: "active", reason: { not: "import" } },
        select: { memberId: true },
      }),
      // The lost set: a trial retired (cancelled OR set inactive) without ever
      // becoming active. Same import exclusion, for the same reason.
      tx.memberStatusEvent.findMany({
        where: { tenantId, fromStatus: "taster", toStatus: { in: ["cancelled", "inactive"] }, reason: { not: "import" } },
        select: { memberId: true },
      }),
      // The imported set: anyone with a roster-import event is not a trial
      // (guard 3, both directions).
      tx.memberStatusEvent.findMany({
        where: { tenantId, reason: "import" },
        select: { memberId: true },
      }),
      // The feature epoch: the earliest non-import attribution event. The window
      // label ("since <this>") is what stops pre-feature members reading as 0%.
      tx.memberStatusEvent.findFirst({
        where: { tenantId, reason: { not: "import" } },
        orderBy: { occurredAt: "asc" },
        select: { occurredAt: true },
      }),
    ]);

    const convertedMemberIds = new Set(convertedEvents.map((event) => event.memberId));
    const lostMemberIds = new Set(lostEvents.map((event) => event.memberId));
    const importedMemberIds = new Set(importedEvents.map((event) => event.memberId));
    const rows = buildStaffConversionRows({
      staff,
      trialMembers,
      signUpMembers,
      convertedMemberIds,
      lostMemberIds,
      importedMemberIds,
    });

    return {
      rows,
      overall: buildFunnel(rows),
      epochStart: epochEvent?.occurredAt.toISOString() ?? null,
      minTrials: MIN_TRIALS_FOR_RATE,
    };
  });
}
