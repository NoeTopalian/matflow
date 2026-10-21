/**
 * T7 (Sean note 5): the one database read the class allowance is judged on.
 *
 * Counted rows (product decision, 20 Oct 2026: confirmed attendance consumes
 * one session; nothing else does):
 *  - attendance records for this member that are not imports
 *    (checkInMethod <> 'import' AND importJobId IS NULL);
 *  - on sessions that are not cancelled;
 *  - not paid for by a class pack (no ClassPackRedemption row points at the
 *    record): a class-pack redemption does not count against the plan
 *    allowance;
 *  - inside the period, judged in TypeScript (lib/class-allowance.ts) from the
 *    wall-clock slots this returns. A booking is not an attendance row and
 *    counts nothing; a refused check-in writes nothing, so it counts nothing;
 *    an unmarked or undone visit is a deleted row, so it counts nothing.
 *
 * ONE statement, run AFTER the Member row lock (lib/checkin.ts). Under READ
 * COMMITTED each statement reads its own snapshot, taken when it starts:
 *  - starting after the lock means every earlier check-in for this member has
 *    committed and is seen (the lock is held to commit);
 *  - the tier's allowance and the visits come from the SAME snapshot, so a
 *    limit cut and an unmark committing between two separate reads can never
 *    combine into an admission no serial order allows (R-ALLOW rule (b),
 *    planning evidence §8c);
 *  - no FOR SHARE / FOR UPDATE clause here (rule (c)): a locking clause would
 *    re-check rows at newer versions and mix snapshots.
 */
import type { Prisma } from "@prisma/client";
import {
  allowanceUsageText,
  currentPeriodUsage,
  nowMinute,
  slotMinute,
  tierAllowance,
  type AllowanceBasis,
  type AllowanceVerdict,
  type ClassAllowance,
  type IsoDate,
} from "@/lib/class-allowance";
import { usableTimezone } from "@/lib/class-time";

export type AllowanceSnapshot = {
  /** The member's tier allowance under the reader rule; null = Unlimited (or no tier). */
  allowance: ClassAllowance | null;
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
  alreadyIn: boolean | null;
  visits: unknown;
};

const DAY_MS = 86_400_000;

/**
 * The marker range to fetch around a session. The longest period any plan can
 * have is 8 weeks (CLASS_LIMIT_WEEKS_MAX), so the period containing the
 * session starts at most 8 weeks before it and ends at most 8 weeks after;
 * a day of slack either side covers the different marker spellings (00:00Z,
 * 23:00Z the day before, 16:00Z).
 */
export function fetchRange(centre: Date, weeks: number): { from: Date; to: Date } {
  const span = weeks * 7 * DAY_MS;
  return {
    from: new Date(centre.getTime() - span - 2 * DAY_MS),
    to: new Date(centre.getTime() + span + 2 * DAY_MS),
  };
}

/** The widest period any plan can have (CLASS_LIMIT_WEEKS_MAX), used before the tier is known. */
const WIDEST_WEEKS = 8;

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

/**
 * Statement C. `centre` is the session's date marker (or now, for the member
 * portal); `currentInstanceId` is the session being judged (excluded from the
 * visits and reported as `alreadyIn`), or null. Returns null when the member
 * is not in this club.
 */
export async function readAllowanceSnapshot(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; memberId: string; centre: Date; currentInstanceId: string | null },
): Promise<AllowanceSnapshot | null> {
  const { from, to } = fetchRange(args.centre, WIDEST_WEEKS);
  // ISO strings cast to `timestamp`: ClassInstance.date is a timestamp WITHOUT
  // zone holding a UTC wall clock (the Prisma convention); the cast ignores the
  // trailing Z, so the comparison is wall clock to wall clock.
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const current = args.currentInstanceId ?? "";
  const rows = await tx.$queryRaw<Row[]>`
    SELECT t."classLimit", t."classLimitBasis", t."classLimitWeeks", t."classLimitAnchor", t."maxClassesPerWeek",
           EXISTS (
             SELECT 1 FROM "AttendanceRecord" a0
              WHERE a0."tenantId" = m."tenantId" AND a0."memberId" = m."id" AND a0."classInstanceId" = ${current}
           ) AS "alreadyIn",
           COALESCE((
             SELECT json_agg(json_build_object(
                      'd', (EXTRACT(EPOCH FROM ci."date") * 1000)::float8,
                      's', ci."startTime"))
               FROM "AttendanceRecord" a
               JOIN "ClassInstance" ci ON ci."id" = a."classInstanceId"
              WHERE a."tenantId" = m."tenantId"
                AND a."memberId" = m."id"
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
      FROM "Member" m
      LEFT JOIN "MembershipTier" t ON t."id" = m."membershipTierId" AND t."tenantId" = m."tenantId"
     WHERE m."id" = ${args.memberId} AND m."tenantId" = ${args.tenantId}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    allowance: tierAllowance({
      classLimit: row.classLimit ?? null,
      classLimitBasis: row.classLimitBasis ?? null,
      classLimitWeeks: row.classLimitWeeks ?? null,
      classLimitAnchor: row.classLimitAnchor ?? null,
      maxClassesPerWeek: row.maxClassesPerWeek ?? null,
    }),
    alreadyIn: row.alreadyIn === true,
    visits: parseVisits(row.visits),
  };
}

export type AllowanceUsage = {
  used: number;
  limit: number;
  basis: AllowanceBasis;
  weeks?: number;
  /** The current period as calendar dates (end exclusive) and the date it resets. */
  period: AllowanceVerdict["period"];
  resetsOn: IsoDate;
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
  const snap = await readAllowanceSnapshot(tx, {
    tenantId: args.tenantId,
    memberId: args.memberId,
    centre: now,
    currentInstanceId: null,
  });
  if (!snap?.allowance) return null;
  const v = currentPeriodUsage(snap.allowance, nowMinute(now, usableTimezone(tenant?.timezone)), snap.visits);
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
