/**
 * The reads behind lib/booking-eligibility.ts (D2 booking preservation). Every
 * function runs in the CALLER's transaction and filters on tenantId (RLS is
 * the backstop). In a write path they run after the Class row lock, so the
 * rules and the bookings they judge are the ones the write replaces.
 */
import type { Prisma } from "@prisma/client";
import { logAudit } from "@/lib/audit-log";
import {
  RECENT_DAYS,
  accessRefusals,
  bookedRefusals,
  groupNotBooked,
  highestRankOrder,
  newlyRefusedByTrigger,
  outsidePreviewPopulation,
  type AccessFacts,
  type AccessTrigger,
  type ClassAccessRules,
  type RestrictionPreview,
} from "@/lib/booking-eligibility";

type Tx = Prisma.TransactionClient;

export type BookedFacts = { facts: AccessFacts; name: string };

const FACTS_SELECT = {
  name: true,
  membershipTierId: true,
  membershipTier: { select: { name: true } },
  memberRanks: { select: { rankSystem: { select: { order: true } } } },
} as const;

type FactsRow = {
  name?: string | null;
  membershipTierId?: string | null;
  membershipTier?: { name: string | null } | null;
  memberRanks?: Array<{ rankSystem: { order: number } | null }> | null;
};

function factsOf(memberId: string, m: FactsRow | null | undefined): BookedFacts {
  const orders = (m?.memberRanks ?? []).flatMap((r) => (r.rankSystem ? [r.rankSystem] : []));
  return {
    name: m?.name ?? "",
    facts: {
      memberId,
      membershipTierId: m?.membershipTierId ?? null,
      tierName: m?.membershipTier?.name ?? null,
      rankOrder: highestRankOrder(orders),
    },
  };
}

/** The members booked on a class, with what the doors judge them on. ClassSubscription has no tenantId: scoped through the member. */
export async function readBookedFacts(tx: Tx, tenantId: string, classId: string): Promise<BookedFacts[]> {
  const subs = await tx.classSubscription.findMany({
    where: { classId, member: { tenantId } },
    select: { memberId: true, member: { select: FACTS_SELECT } },
  });
  return subs.map((s) => factsOf(s.memberId, s.member as FactsRow));
}

/** id → order for this club's ranks (soft-deleted ranks included: the door's relation does not filter them). */
export async function readRankOrders(tx: Tx, tenantId: string, ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, number>> {
  const wanted = [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))];
  if (wanted.length === 0) return new Map();
  const rows = await tx.rankSystem.findMany({ where: { id: { in: wanted }, tenantId }, select: { id: true, order: true } });
  return new Map(rows.map((r) => [r.id, r.order]));
}

/** The squad list of a class (member ids). */
export async function readRosterIds(tx: Tx, tenantId: string, classId: string): Promise<string[]> {
  const rows = await tx.classRoster.findMany({ where: { tenantId, classId }, select: { memberId: true } });
  return rows.map((r) => r.memberId).sort();
}

/** The membership list of a class (tier ids). */
export async function readTierIds(tx: Tx, tenantId: string, classId: string): Promise<string[]> {
  const rows = await tx.classMembershipTier.findMany({ where: { tenantId, classId }, select: { tierId: true } });
  return rows.map((r) => r.tierId).sort();
}

/** A class's whole access rules as they stand in this transaction. */
export async function readClassRules(
  tx: Tx,
  tenantId: string,
  cls: { id: string; requiredRankId: string | null; maxRankId: string | null },
): Promise<ClassAccessRules> {
  const [rosterMemberIds, allowedTierIds, orders] = [
    await readRosterIds(tx, tenantId, cls.id),
    await readTierIds(tx, tenantId, cls.id),
    await readRankOrders(tx, tenantId, [cls.requiredRankId, cls.maxRankId]),
  ];
  return {
    rosterMemberIds,
    allowedTierIds,
    requiredRankOrder: cls.requiredRankId ? (orders.get(cls.requiredRankId) ?? null) : null,
    maxRankOrder: cls.maxRankId ? (orders.get(cls.maxRankId) ?? null) : null,
  };
}

/**
 * The class form's preview (dry run only): every booked member the rules
 * turn away after the edit, and every member who is NOT booked whom the edit
 * newly turns away (admitted under `before`, refused under `after`), grouped
 * by reason. Guardian / payer accounts and members who are not training are
 * left out (outsidePreviewPopulation). `classId` null = a class being created.
 */
export async function restrictionPreview(
  tx: Tx,
  tenantId: string,
  args: { classId: string | null; before: ClassAccessRules; after: ClassAccessRules },
): Promise<{ preview: RestrictionPreview; byTrigger: Record<AccessTrigger, string[]> }> {
  const booked = args.classId ? await readBookedFacts(tx, tenantId, args.classId) : [];
  const bookedIds = new Set(booked.map((b) => b.facts.memberId));
  const restrictive =
    args.after.rosterMemberIds.length > 0 ||
    args.after.allowedTierIds.length > 0 ||
    args.after.requiredRankOrder !== null ||
    args.after.maxRankOrder !== null;

  let notBooked: RestrictionPreview["notBooked"] = [];
  let notBookedTotal = 0;
  if (restrictive) {
    const members = await tx.member.findMany({
      where: { tenantId },
      select: { id: true, accountType: true, status: true, externalRef: true, ...FACTS_SELECT },
    });
    const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);
    const active = await tx.attendanceRecord.groupBy({
      by: ["memberId"],
      where: { tenantId, checkInTime: { gte: since } },
    });
    const activeIds = new Set(active.map((a) => a.memberId));
    const thisClass = args.classId
      ? await tx.attendanceRecord.groupBy({
          by: ["memberId"],
          where: { tenantId, checkInTime: { gte: since }, classInstance: { classId: args.classId } },
        })
      : [];
    const thisClassIds = new Set(thisClass.map((a) => a.memberId));
    const rows = [];
    for (const m of members) {
      if (bookedIds.has(m.id) || outsidePreviewPopulation(m)) continue;
      const { facts, name } = factsOf(m.id, m as FactsRow);
      if (accessRefusals(args.before, facts).length > 0) continue; // already turned away: not news
      const reasons = accessRefusals(args.after, facts);
      if (reasons.length === 0) continue;
      rows.push({ facts, name, reasons, attendedThisClass: thisClassIds.has(m.id), recentlyActive: activeIds.has(m.id) });
    }
    const grouped = groupNotBooked(rows);
    notBooked = grouped.groups;
    notBookedTotal = grouped.total;
  }
  return {
    preview: { bookingsKept: true, booked: bookedRefusals(args.before, args.after, booked), notBooked, notBookedTotal },
    byTrigger: newlyRefusedByTrigger(args.before, args.after, booked),
  };
}

/** The audit action for a booking an access change kept although the rules now turn its member away. */
export const BOOKINGS_KEPT_ACTION = "class.bookings.kept_ineligible";

/**
 * D2: record, in the caller's transaction (durable — the row commits or rolls
 * back with the change), the members whose booking a rule change now turns
 * away, one row per trigger. The bookings themselves are kept.
 */
export async function recordKeptBookings(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string | null;
    classId: string;
    /** What changed: "class.updated", "class.roster.remove", "member.rank.demote". */
    cause: string;
    byTrigger: Partial<Record<AccessTrigger, string[]>>;
    req?: Request;
    extra?: Record<string, unknown>;
  },
): Promise<Partial<Record<AccessTrigger, string[]>>> {
  const written: Partial<Record<AccessTrigger, string[]>> = {};
  for (const trigger of ["squad", "rank", "membership"] as const) {
    const memberIds = args.byTrigger[trigger] ?? [];
    if (memberIds.length === 0) continue;
    await logAudit({
      tx,
      tenantId: args.tenantId,
      userId: args.userId,
      action: BOOKINGS_KEPT_ACTION,
      entityType: "Class",
      entityId: args.classId,
      metadata: { classId: args.classId, trigger, cause: args.cause, memberIds, bookingsKept: true, ...(args.extra ?? {}) },
      req: args.req,
    });
    written[trigger] = memberIds;
  }
  return written;
}

/** Re-exported so a write path needs one import for the rule maths it records. */
export { newlyRefusedByTrigger };
