import type { Prisma } from "@prisma/client";
import { usableTimezone } from "./class-time";
import { TRAINING_MEMBER } from "./member-population";
import {
  buildMembership,
  compareEvents,
  isImportOpening,
  MEMBERSHIP_WINDOW_MONTHS,
  type MembershipSeries,
  type MovementEvent,
} from "./membership-movement";
import { planTenantBackfill, STATUS_BACKFILL_SOURCE_ACTION } from "./status-backfill";

type TxClient = Prisma.TransactionClient;

/**
 * T8c: the reads behind `ReportsData.membership`. Runs inside the caller's
 * withTenantContext; every query carries `tenantId` (RLS is the backstop).
 * Reads only. One findMany of events, no take cap: the series is replayed in
 * JS (lib/membership-movement.ts).
 *
 * Where history before the first recorded event comes from (owner decision
 * Q6, 17 Oct 2026; marked "estimated from your TeamUp history" on screen):
 * 1. Back-filled events (T8b, sourceAction import_backfill) when the club has
 *    them: they are events, replayed like any other, and flagged estimated.
 * 2. Otherwise the TeamUp import ledger (ImportedMembership), turned into the
 *    same dated transitions in memory by the T8b planner. Nothing is written.
 * 3. A member with no ledger rows whose history starts with an import create
 *    event, or with no events at all: Member.joinedAt (active from then) and,
 *    for a member who had left by then, Member.cancelledAt. Nothing is
 *    invented: a member who left with no cancellation date, or went inactive,
 *    gets no earlier history.
 * A ledger member the planner could not date (an undated end or start) gets
 * no earlier history either; they are counted from the import day and the
 * report says how many.
 */
export interface MembershipReport extends MembershipSeries {
  /** Where pre-boundary history came from: back-filled events, the import ledger in memory, or neither. */
  historySource: "backfill" | "ledger" | "none";
  /** Imported members with TeamUp rows but no datable history: counted from the import day. */
  undatedHistory: number;
  /** Members whose earlier history was taken from their join (and cancellation) date. */
  fromJoinDates: number;
}

export function emptyMembershipReport(): MembershipReport {
  return {
    timeZone: "Europe/London",
    boundary: null,
    window: { from: "", to: "", months: MEMBERSHIP_WINDOW_MONTHS },
    openingHeadcount: 0,
    headcountByMonth: [],
    movementsByMonth: [],
    totals: { new: 0, rejoined: 0, lost: 0, lostCancelled: 0, lostCompleted: 0, net: 0, imported: 0, otherIn: 0, otherOut: 0 },
    reconciled: 0,
    historySource: "none",
    undatedHistory: 0,
    fromJoinDates: 0,
  };
}

export interface MemberDates {
  id: string;
  status: string;
  joinedAt: Date;
  cancelledAt: Date | null;
}

/**
 * Earlier history from join and cancellation dates, for ONE member who has no
 * ledger rows. `recorded` is that member's recorded events (oldest first).
 * Returns nothing unless the member has no events, or their first event is an
 * import create dated after their join date.
 */
export function joinDateHistory(member: MemberDates, recorded: readonly MovementEvent[], now: Date): MovementEvent[] {
  const first = recorded[0];
  if (first && !isImportOpening(first)) return [];
  const cutoff = first ? first.occurredAt.getTime() : now.getTime() + 1;
  const joined = member.joinedAt.getTime();
  if (!(joined < cutoff)) return [];
  const statusThen = first ? first.toStatus : member.status;
  const ev = (suffix: string, toStatus: string, at: number): MovementEvent => ({
    id: `joined:${member.id}:${suffix}`,
    memberId: member.id,
    toStatus,
    occurredAt: new Date(at),
    createdAt: new Date(at),
    estimated: true,
  });
  if (statusThen === "active") return [ev("start", "active", joined)];
  if (statusThen === "cancelled" && member.cancelledAt) {
    const left = Math.max(member.cancelledAt.getTime(), joined + 1);
    if (left < cutoff) return [ev("start", "active", joined), ev("end", "cancelled", left)];
  }
  return [];
}

export async function loadMembershipReport(
  tx: TxClient,
  tenantId: string,
  { now, months = MEMBERSHIP_WINDOW_MONTHS }: { now: Date; months?: number },
): Promise<MembershipReport> {
  if (!tenantId) throw new Error("loadMembershipReport requires a tenantId");
  // Sequential, not Promise.all: one interactive transaction is one connection.
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  const timeZone = usableTimezone(tenant?.timezone);
  const members = await tx.member.findMany({
    where: { tenantId, ...TRAINING_MEMBER },
    select: { id: true, status: true, joinedAt: true, cancelledAt: true },
  });
  const rows = await tx.memberStatusEvent.findMany({
    where: { tenantId, member: { tenantId, ...TRAINING_MEMBER } },
    select: { id: true, memberId: true, fromStatus: true, toStatus: true, reason: true, sourceAction: true, occurredAt: true, createdAt: true },
  });
  const ledgerMembers = await tx.importedMembership.findMany({
    where: { tenantId, memberId: { not: null }, disposition: "member_history" },
    select: { memberId: true },
    distinct: ["memberId"],
  });

  const training = new Set(members.map((m) => m.id));
  const events: MovementEvent[] = rows.map((e) =>
    e.sourceAction === STATUS_BACKFILL_SOURCE_ACTION ? { ...e, estimated: true } : e,
  );
  const hasBackfill = events.some((e) => e.sourceAction === STATUS_BACKFILL_SOURCE_ACTION);
  const ledgerIds = new Set(ledgerMembers.map((r) => r.memberId).filter((id): id is string => !!id && training.has(id)));

  // 2. The ledger in memory, only when the back-fill has not been applied.
  let historySource: MembershipReport["historySource"] = hasBackfill ? "backfill" : "none";
  if (!hasBackfill && ledgerIds.size > 0) {
    const plan = await planTenantBackfill(tx, tenantId);
    plan.inputs.forEach((input, i) => {
      if (!training.has(input.memberId)) return;
      events.push({
        id: `ledger:${String(i).padStart(6, "0")}`,
        memberId: input.memberId,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus,
        reason: "import",
        sourceAction: STATUS_BACKFILL_SOURCE_ACTION,
        occurredAt: input.occurredAt,
        createdAt: input.occurredAt,
        estimated: true,
        completedCourse: input.toStatus === "inactive",
      });
    });
    if (plan.inputs.length > 0) historySource = "ledger";
  }

  const byMember = new Map<string, MovementEvent[]>();
  for (const e of events) {
    const list = byMember.get(e.memberId);
    if (list) list.push(e);
    else byMember.set(e.memberId, [e]);
  }

  // 3. Join and cancellation dates, for members with no ledger rows.
  let undatedHistory = 0;
  let fromJoinDates = 0;
  for (const m of members) {
    const recorded = (byMember.get(m.id) ?? []).sort(compareEvents);
    if (recorded.some((e) => e.sourceAction === STATUS_BACKFILL_SOURCE_ACTION)) continue;
    if (ledgerIds.has(m.id)) {
      if (recorded[0] && isImportOpening(recorded[0])) undatedHistory += 1;
      continue;
    }
    const extra = joinDateHistory(m, recorded, now);
    if (extra.length > 0) {
      fromJoinDates += 1;
      events.push(...extra);
    }
  }

  // The boundary: the first event written when it happened (not back-filled, not reconstructed).
  let boundary: Date | null = null;
  for (const e of rows) {
    if (e.sourceAction === STATUS_BACKFILL_SOURCE_ACTION) continue;
    if (!boundary || e.occurredAt < boundary) boundary = e.occurredAt;
  }

  const series = buildMembership({
    events,
    live: members.map((m) => ({ id: m.id, status: m.status })),
    now,
    timeZone,
    months,
    boundary,
  });
  return { ...series, historySource, undatedHistory, fromJoinDates };
}
