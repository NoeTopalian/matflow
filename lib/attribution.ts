import { withTenantContext } from "@/lib/prisma-tenant";

/**
 * Per-staff conversion analytics (M1).
 *
 * Answers the question Sean actually asks: "these coaches ran N trials,
 * converted M — here's each coach's %". The numbers come only from real
 * attribution columns (Member.trialRunById / creditedToUserId) and the
 * MemberStatusEvent funnel — never fabricated, and honest about what it cannot
 * yet say (see the three guards below).
 *
 * Three guards keep the percentage from lying:
 *   1. min-N — a rate over fewer than MIN_TRIALS_FOR_RATE trials is noise, so
 *      we return `null` ("N/A, too few") rather than a headline 100% off one
 *      taster.
 *   2. feature-epoch — attribution only started being recorded on a date; the
 *      caller labels the window "since <epochStart>" so the hundreds of members
 *      who predate the feature (and carry no attribution) don't drag every
 *      coach's rate toward 0%.
 *   3. import exclusion — bulk-import status events are excluded from the
 *      conversion set upstream (the query filters `reason != import`), because
 *      a roster import is not a coach converting a taster.
 */

/** Below this many trials, a conversion rate is statistically meaningless. */
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
}

export interface AttributionData {
  rows: StaffConversionRow[];
  /** ISO timestamp of the first attribution event, or null if none yet. */
  epochStart: string | null;
  /** Echoed so the client renders the same threshold the math used. */
  minTrials: number;
}

/**
 * conversions / trialsRun as a percentage, one decimal place. Returns `null`
 * (the min-N guard) when there are fewer than MIN_TRIALS_FOR_RATE trials — the
 * caller must render "N/A" rather than a number for a null.
 */
export function computeConversionRate(trialsRun: number, conversions: number): number | null {
  if (trialsRun < MIN_TRIALS_FOR_RATE) return null;
  return Math.round((conversions / trialsRun) * 1000) / 10;
}

/**
 * Pure aggregation — no DB. Kept separate from the query so the guard logic is
 * unit-testable with plain arrays. Only staff with some activity (a trial run
 * or a sign-up) appear; a coach who has done neither is not a zero-row, they
 * are simply not in the funnel. Sorted by trials run, then sign-ups, desc.
 */
export function buildStaffConversionRows(params: {
  staff: { id: string; name: string }[];
  trialMembers: { id: string; trialRunById: string | null }[];
  signUpMembers: { creditedToUserId: string | null }[];
  /** Member ids that reached `active` via a non-import status event. */
  convertedMemberIds: Set<string>;
}): StaffConversionRow[] {
  const { staff, trialMembers, signUpMembers, convertedMemberIds } = params;

  const signUpsByUser = new Map<string, number>();
  for (const member of signUpMembers) {
    if (!member.creditedToUserId) continue;
    signUpsByUser.set(member.creditedToUserId, (signUpsByUser.get(member.creditedToUserId) ?? 0) + 1);
  }

  const trialsByUser = new Map<string, number>();
  const conversionsByUser = new Map<string, number>();
  for (const member of trialMembers) {
    if (!member.trialRunById) continue;
    trialsByUser.set(member.trialRunById, (trialsByUser.get(member.trialRunById) ?? 0) + 1);
    if (convertedMemberIds.has(member.id)) {
      conversionsByUser.set(member.trialRunById, (conversionsByUser.get(member.trialRunById) ?? 0) + 1);
    }
  }

  const rows: StaffConversionRow[] = [];
  for (const user of staff) {
    const trialsRun = trialsByUser.get(user.id) ?? 0;
    const signUps = signUpsByUser.get(user.id) ?? 0;
    if (trialsRun === 0 && signUps === 0) continue;
    const conversions = conversionsByUser.get(user.id) ?? 0;
    rows.push({
      userId: user.id,
      name: user.name,
      trialsRun,
      signUps,
      conversions,
      conversionRate: computeConversionRate(trialsRun, conversions),
    });
  }

  rows.sort((a, b) => b.trialsRun - a.trialsRun || b.signUps - a.signUps || a.name.localeCompare(b.name, "en-GB"));
  return rows;
}

/**
 * Tenant-scoped fetch + aggregate for the attribution dashboard. Every read is
 * filtered on tenantId (RLS is the backstop, not the primary defence).
 */
export async function getAttributionData(tenantId: string): Promise<AttributionData> {
  return withTenantContext(tenantId, async (tx) => {
    const [staff, trialMembers, signUpMembers, convertedEvents, epochEvent] = await Promise.all([
      tx.user.findMany({
        where: { tenantId },
        select: { id: true, name: true },
      }),
      tx.member.findMany({
        where: { tenantId, trialRunById: { not: null } },
        select: { id: true, trialRunById: true },
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
      // The feature epoch: the earliest non-import attribution event. The window
      // label ("since <this>") is what stops pre-feature members reading as 0%.
      tx.memberStatusEvent.findFirst({
        where: { tenantId, reason: { not: "import" } },
        orderBy: { occurredAt: "asc" },
        select: { occurredAt: true },
      }),
    ]);

    const convertedMemberIds = new Set(convertedEvents.map((event) => event.memberId));
    const rows = buildStaffConversionRows({ staff, trialMembers, signUpMembers, convertedMemberIds });

    return {
      rows,
      epochStart: epochEvent?.occurredAt.toISOString() ?? null,
      minTrials: MIN_TRIALS_FOR_RATE,
    };
  });
}
