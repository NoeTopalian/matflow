/**
 * Statement C: what the check-in engine reads, under the Member lock it
 * already holds, to judge the plan allowance — two plain reads, no locking
 * clause (rule (c): a locking clause would re-check rows at newer versions):
 *   C1 the tier's allowance columns, the member's billing columns and whether
 *      the member is already in the judged session;
 *   C2 the member's counted visits inside the judged session's own period,
 *      bounded by that period (an annual billing period is read in full).
 * Between C1 and C2 only writers that do not lock the Member row can commit —
 * a tier edit, an unmark, a class cancellation. Each reads nothing a
 * check-in writes, so every interleaving is equivalent to a serial order
 * (unmark, then this check-in, then the edit); a competing check-in, an undo
 * batch, a deletion or the webhook's period write all wait on the Member
 * lock. Counted rows: not imports, not cancelled sessions, not class-pack
 * redemptions, not the judged session. The member portal reads the same way
 * for "now".
 */
import type { Prisma } from "@prisma/client";
import {
  allowanceUsageText,
  currentPeriodUsage,
  nowMinute,
  slotMinute,
  BillingPeriodUnknown,
  periodContaining,
  tierAllowance,
  withMemberBillingPeriod,
  type AllowanceBasis,
  type AllowanceVerdict,
  type ClassAllowance,
  type IsoDate,
} from "@/lib/class-allowance";
import { usableTimezone } from "@/lib/class-time";

export type AllowanceSnapshot = {
  /**
   * The member's allowance under the reader rule, with a "billing" allowance
   * already resolved to this member's own period; null = Unlimited (or no
   * tier), OR a billing allowance whose period is unknown (then
   * `periodUnknown` is set and the limit is in `periodUnknownLimit`).
   */
  allowance: ClassAllowance | null;
  /** The plan counts per billing period but this member has no recorded period: cannot be counted. */
  periodUnknown: boolean;
  periodUnknownLimit: number | null;
  /** The member already has a record for the session being judged. */
  alreadyIn: boolean;
  /** Counted visits, as wall-clock minutes (lib/class-allowance.ts slotMinute). */
  visits: number[];
};

type Row = {
  classLimit: number | null;
  classLimitBasis: string | null;
  classLimitWeeks: number | null;
  classLimitAnchor: Date | string | null;
  maxClassesPerWeek: number | null;
  billingCycle: string | null;
  stripeSubscriptionId: string | null;
  nextDueAt: Date | null;
  billingPeriodStart: Date | null;
  billingPeriodEnd: Date | null;
  alreadyIn: boolean | null;
};

const MINUTES_PER_DAY = 1440;

/**
 * Statement C, in two reads under the Member lock the caller already holds:
 *  C1 — the tier's allowance columns, the member's billing columns and
 *       whether the member is already in the judged session;
 *  C2 — the member's counted visits inside the judged session's own period
 *       (plus a day either side for the marker spellings), which is known
 *       only after C1 resolved the period. An Unlimited plan skips C2.
 * A period of any length (an annual billing period included) is counted in
 * full: the range is the period's, never a fixed window. `session` is the
 * judged session's wall-clock minute (or now, for the member portal);
 * `currentInstanceId` is the session being judged (excluded from the visits
 * and reported as `alreadyIn`), or null. Returns null when the member is not
 * in this club.
 */
function parseVisits(raw: unknown): number[] {
  const list = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(list)) return [];
  const out: number[] = [];
  for (const v of list) {
    const d = (v as { d?: unknown })?.d;
    const s = (v as { s?: unknown })?.s;
    const ms = typeof d === "number" ? d : typeof d === "string" ? Number(d) : NaN;
    if (!Number.isFinite(ms) || typeof s !== "string") continue;
    out.push(slotMinute({ date: new Date(ms), startTime: s }));
  }
  return out;
}

export async function readAllowanceSnapshot(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; memberId: string; session: number; currentInstanceId: string | null; timeZone: string },
): Promise<AllowanceSnapshot | null> {
  const current = args.currentInstanceId ?? "";
  const rows = await tx.$queryRaw<Row[]>`
    SELECT t."classLimit", t."classLimitBasis", t."classLimitWeeks", t."classLimitAnchor", t."maxClassesPerWeek",
           t."billingCycle", m."stripeSubscriptionId", m."nextDueAt", m."billingPeriodStart", m."billingPeriodEnd",
           EXISTS (
             SELECT 1 FROM "AttendanceRecord" a0
              WHERE a0."tenantId" = m."tenantId" AND a0."memberId" = m."id" AND a0."classInstanceId" = ${current}
           ) AS "alreadyIn"
      FROM "Member" m
      LEFT JOIN "MembershipTier" t ON t."id" = m."membershipTierId" AND t."tenantId" = m."tenantId"
     WHERE m."id" = ${args.memberId} AND m."tenantId" = ${args.tenantId}
  `;
  const row = rows[0];
  if (!row) return null;
  const tier = tierAllowance({
    classLimit: row.classLimit ?? null,
    classLimitBasis: row.classLimitBasis ?? null,
    classLimitWeeks: row.classLimitWeeks ?? null,
    classLimitAnchor: row.classLimitAnchor ?? null,
    maxClassesPerWeek: row.maxClassesPerWeek ?? null,
  });
  // A "billing" allowance is this member's own period, by who bills them.
  const allowance = withMemberBillingPeriod(tier, {
    stripeSubscriptionId: row.stripeSubscriptionId ?? null,
    billingPeriodStart: row.billingPeriodStart ?? null,
    billingPeriodEnd: row.billingPeriodEnd ?? null,
    nextDueAt: row.nextDueAt ?? null,
    billingCycle: row.billingCycle ?? null,
  }, args.timeZone);
  const periodUnknown = tier?.basis === "billing" && allowance === null;
  const alreadyIn = row.alreadyIn === true;
  if (!allowance) {
    return { allowance: null, periodUnknown, periodUnknownLimit: periodUnknown ? tier!.limit : null, alreadyIn, visits: [] };
  }
  let period: { start: number; end: number };
  try {
    period = periodContaining(allowance, args.session);
  } catch (e) {
    if (!(e instanceof BillingPeriodUnknown)) throw e;
    return { allowance: null, periodUnknown: true, periodUnknownLimit: allowance.limit, alreadyIn, visits: [] };
  }
  // ISO strings cast to `timestamp`: ClassInstance.date is a timestamp WITHOUT
  // zone holding a UTC wall clock (the Prisma convention); the cast ignores the
  // trailing Z, so the comparison is wall clock to wall clock. A day of slack
  // either side covers the different marker spellings (00:00Z, 23:00Z the day
  // before, 16:00Z); the period itself decides what counts.
  const fromIso = new Date((period.start - MINUTES_PER_DAY) * 60_000).toISOString();
  const toIso = new Date((period.end + MINUTES_PER_DAY) * 60_000).toISOString();
  const visitRows = await tx.$queryRaw<Array<{ visits: unknown }>>`
    SELECT COALESCE((
             SELECT json_agg(json_build_object(
                      'd', (EXTRACT(EPOCH FROM ci."date") * 1000)::float8,
                      's', ci."startTime"))
               FROM "AttendanceRecord" a
               JOIN "ClassInstance" ci ON ci."id" = a."classInstanceId"
              WHERE a."tenantId" = ${args.tenantId}
                AND a."memberId" = ${args.memberId}
                AND a."checkInMethod" <> 'import'
                AND a."importJobId" IS NULL
                AND ci."isCancelled" = false
                AND ci."id" <> ${current}
                AND ci."date" >= ${fromIso}::timestamp
                AND ci."date" <= ${toIso}::timestamp
                AND NOT EXISTS (
                  SELECT 1 FROM "ClassPackRedemption" r WHERE r."attendanceRecordId" = a."id"
                )
           ), '[]'::json) AS "visits"
  `;
  return {
    allowance,
    periodUnknown: false,
    periodUnknownLimit: null,
    alreadyIn,
    visits: parseVisits(visitRows[0]?.visits),
  };
}

export type AllowanceUsage = {
  used: number;
  limit: number;
  basis: AllowanceBasis;
  weeks?: number;
  /** The current period as calendar dates (end exclusive) and the date it resets; absent when the period is unknown. */
  period?: AllowanceVerdict["period"];
  resetsOn?: IsoDate;
  /** The plan counts per billing period and this member has no recorded period. */
  periodUnknown?: true;
  /** "2 of 4 classes used this 4-week period — resets Tuesday 17 November". */
  text: string;
};

/**
 * The member portal line (plan card and schedule): classes counted in the
 * period containing now, by the same rows the check-in counts. Null for an
 * Unlimited plan, no plan, or a member not in this club.
 */
export async function memberAllowanceUsage(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; memberId: string; now?: Date },
): Promise<AllowanceUsage | null> {
  const now = args.now ?? new Date();
  const tenant = await tx.tenant.findUnique({ where: { id: args.tenantId }, select: { timezone: true } });
  const zone = usableTimezone(tenant?.timezone);
  const snap = await readAllowanceSnapshot(tx, {
    tenantId: args.tenantId,
    memberId: args.memberId,
    session: nowMinute(now, zone),
    currentInstanceId: null,
    timeZone: zone,
  });
  if (!snap) return null;
  if (snap.periodUnknown && snap.periodUnknownLimit !== null) {
    const facts = { used: 0, limit: snap.periodUnknownLimit, basis: "billing" as const, periodUnknown: true as const };
    return { ...facts, text: allowanceUsageText(facts) };
  }
  if (!snap.allowance) return null;
  const v = currentPeriodUsage(snap.allowance, nowMinute(now, zone), snap.visits);
  return {
    used: v.used,
    limit: v.limit,
    basis: v.basis,
    ...(v.weeks !== undefined ? { weeks: v.weeks } : {}),
    period: v.period,
    resetsOn: v.resetsOn,
    text: allowanceUsageText(v),
  };
}
