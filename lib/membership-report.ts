import type { Prisma } from "@prisma/client";
import { usableTimezone } from "./class-time";
import { TRAINING_MEMBER } from "./member-population";
import { clubMonthWindowForKey } from "./club-month";
import {
  buildMembership,
  combinedBasis,
  compareEvents,
  estimatedCaption,
  isImportOpening,
  MEMBERSHIP_WINDOW_MONTHS,
  moversAndBasisInWindow,
  type BuildMembershipInput,
  type MembershipBasis,
  type MembershipSeries,
  type MovementBucket,
  type MovementEvent,
  type MovementTally,
} from "./membership-movement";
import { planTenantBackfill, STATUS_BACKFILL_SOURCE_ACTION } from "./status-backfill";

type TxClient = Prisma.TransactionClient;

/**
 * T8c: the reads behind `ReportsData.membership`. Runs inside the caller's
 * withTenantContext; every query carries `tenantId` (RLS is the backstop).
 * Reads only. One findMany of events, no take cap: the series is replayed in
 * JS (lib/membership-movement.ts).
 *
 * Where history before the first recorded event comes from (Q6: agent
 * default adopted 17 Oct 2026; not an owner decision; marked "estimated" on
 * screen, with what it came from: estimatedCaption in
 * lib/membership-movement.ts):
 * 1. Back-filled events (T8b, sourceAction import_backfill) for the members
 *    who have them: they are events, replayed like any other, and flagged
 *    estimated.
 * 2. For ledger members with no back-filled events (the back-fill not yet
 *    applied, or a member from a later create import), the TeamUp import
 *    ledger (ImportedMembership), turned into the same dated transitions in
 *    memory by the T8b planner, which skips back-filled members itself.
 *    Nothing is written.
 * 3. A member with no ledger rows whose history starts with an import create
 *    event, or with no events at all: Member.joinedAt (active from then) and,
 *    for a member who had left by then, Member.cancelledAt. A member whose
 *    first event is a real transition (fromStatus set: they existed before
 *    the event log) is given that fromStatus as their earlier state, so the
 *    transition is classified as the loss or rejoin it was. Nothing is
 *    invented: a member who left with no cancellation date, or went inactive,
 *    gets no earlier dates.
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
    openingChurned: 0,
    headcountByMonth: [],
    movementsByMonth: [],
    totals: { new: 0, rejoined: 0, lost: 0, lostCancelled: 0, lostCompleted: 0, net: 0, imported: 0, otherIn: 0, otherOut: 0, tasterAdded: 0 },
    reconciled: 0,
    firstDataAt: null,
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
 * - No events, or a first event that is an import create: active from the
 *   join date (and cancelled at cancelledAt for a member who had left).
 * - A first event that is a real transition (fromStatus set; the member
 *   predates the event log): that fromStatus, from the join date (or 1 ms
 *   before the event when the join date is not earlier), so the transition
 *   reads as the loss or rejoin it was rather than as a first appearance.
 * - A first event with no fromStatus that is not an import (a creation):
 *   nothing; that event is the start.
 * - D11: a join date on the import day (within IMPORT_DAY_MS before the
 *   import create) is the import stamping "now" on a member whose file gave
 *   no join date, not a join: nothing, so the import create stays the
 *   opening balance ("imported") and the import manufactures no new joins.
 */
export const IMPORT_DAY_MS = 24 * 60 * 60 * 1000;

export function joinDateHistory(member: MemberDates, recorded: readonly MovementEvent[], now: Date): MovementEvent[] {
  const first = recorded[0];
  const joined = member.joinedAt.getTime();
  const ev = (suffix: string, toStatus: string, at: number): MovementEvent => ({
    id: `joined:${member.id}:${suffix}`,
    memberId: member.id,
    toStatus,
    occurredAt: new Date(at),
    createdAt: new Date(at),
    estimated: true,
  });
  if (first && !isImportOpening(first)) {
    if (!first.fromStatus) return [];
    const firstAt = first.occurredAt.getTime();
    return [ev("prior", first.fromStatus, joined < firstAt ? joined : firstAt - 1)];
  }
  const cutoff = first ? first.occurredAt.getTime() : now.getTime() + 1;
  if (!(joined < cutoff)) return [];
  if (first && cutoff - joined < IMPORT_DAY_MS) return [];
  const statusThen = first ? first.toStatus : member.status;
  if (statusThen === "active") return [ev("start", "active", joined)];
  if (statusThen === "cancelled" && member.cancelledAt) {
    const left = Math.max(member.cancelledAt.getTime(), joined + 1);
    if (left < cutoff) return [ev("start", "active", joined), ev("end", "cancelled", left)];
  }
  return [];
}

/** The replay input and where its history came from: what the report and the Members drill-throughs share. */
export interface MembershipInput {
  input: Omit<BuildMembershipInput, "months">;
  historySource: MembershipReport["historySource"];
  undatedHistory: number;
  fromJoinDates: number;
}

export async function loadMembershipReport(
  tx: TxClient,
  tenantId: string,
  { now, months = MEMBERSHIP_WINDOW_MONTHS }: { now: Date; months?: number },
): Promise<MembershipReport> {
  const loaded = await loadMembershipInput(tx, tenantId, now);
  const series = buildMembership({ ...loaded.input, months });
  return { ...series, historySource: loaded.historySource, undatedHistory: loaded.undatedHistory, fromJoinDates: loaded.fromJoinDates };
}

/** The movement figures for a statistics page's whole period (lib/report-period). */
export interface PeriodMembership {
  /** Moves inside the period: joined (new + rejoined), left, net, tasters. */
  totals: MovementTally;
  /**
   * Active members just before the period opened: the churn base (churn =
   * left in the period ÷ this; Noe, 26 Oct 2026, the normal definition).
   * Null when the club has no history from before the period, so the base is
   * unknown — the page shows "—", never a churn worked out against 0.
   */
  openingHeadcount: number | null;
  /** Churn's numerator: of those `openingHeadcount` members, how many left in the period (each once). */
  churned: number;
  /** Whether the period's moves were recorded at the time or are (partly) estimated. */
  basis: MembershipBasis;
  /** The same figures for the equal run of months straight before (comparisons); null when that run has no data. */
  previous: { totals: MovementTally; basis: MembershipBasis } | null;
}

/**
 * A statistics page's membership figures for its period: the monthly series
 * over the chart's months (at least as long as the period, ending with it)
 * and the period's own totals and opening headcount. One read, two replays of
 * the same events, so the chart, the tiles and the churn base cannot disagree.
 */
export async function loadMembershipForPeriod(
  tx: TxClient,
  tenantId: string,
  { now, endMonth, months, chartMonths, previousEndMonth }: { now: Date; endMonth: string; months: number; chartMonths: number; previousEndMonth: string },
): Promise<{ report: MembershipReport; period: PeriodMembership }> {
  const loaded = await loadMembershipInput(tx, tenantId, now);
  // The Net New Members card keeps its 12 months at least (MEMBERSHIP_WINDOW_MONTHS); a longer period lengthens it.
  const series = buildMembership({ ...loaded.input, months: Math.max(chartMonths, months, MEMBERSHIP_WINDOW_MONTHS), endMonth });
  const own = buildMembership({ ...loaded.input, months, endMonth });
  const before = buildMembership({ ...loaded.input, months, endMonth: previousEndMonth });
  const beforeBasis = combinedBasis(before.movementsByMonth.map((m) => m.basis));
  // The period opens at club midnight on the 1st of its first month. Its
  // opening headcount means something only when the club's earliest event
  // came before that instant; otherwise there is no base to divide by.
  const firstMonth = own.headcountByMonth[0]?.month;
  const opensAt = firstMonth ? new Date(clubMonthWindowForKey(firstMonth, own.timeZone)!.monthStart).getTime() : null;
  const hasHistory = opensAt !== null && own.firstDataAt !== null && new Date(own.firstDataAt).getTime() < opensAt;
  return {
    report: { ...series, historySource: loaded.historySource, undatedHistory: loaded.undatedHistory, fromJoinDates: loaded.fromJoinDates },
    period: {
      totals: own.totals,
      openingHeadcount: hasHistory ? own.openingHeadcount : null,
      churned: hasHistory ? own.openingChurned : 0,
      basis: combinedBasis(own.movementsByMonth.map((m) => m.basis)),
      previous: beforeBasis === "none" ? null : { totals: before.totals, basis: beforeBasis },
    },
  };
}

/**
 * D11: the members behind each movement figure for one club month — the
 * Members drill-throughs (new-, rejoined-, lost- and tasters-this-month). The
 * same reads and replay as loadMembershipReport, so the rows listed are
 * exactly the members the Reports tile and chart counted for that month.
 */
export async function loadMonthMovers(
  tx: TxClient,
  tenantId: string,
  now: Date,
  window: { start: Date; at: Date },
): Promise<Record<MovementBucket, string[]>> {
  return (await loadMonthMovement(tx, tenantId, now, window)).movers;
}

/**
 * loadMonthMovers plus whether that month's moves are recorded or (partly)
 * estimated, and what an estimate came from (estimatedCaption), so a past
 * month's drill-through is labelled exactly as the Reports chart labels it.
 */
export async function loadMonthMovement(
  tx: TxClient,
  tenantId: string,
  now: Date,
  window: { start: Date; at: Date },
): Promise<{ movers: Record<MovementBucket, string[]>; basis: MembershipBasis; caption: string }> {
  const loaded = await loadMembershipInput(tx, tenantId, now);
  const { movers, basis } = moversAndBasisInWindow(loaded.input, window);
  return { movers, basis, caption: estimatedCaption(loaded) };
}

/**
 * D11 "Joined" (new + rejoined) for each window, from one read and replay:
 * the figure Analysis and the AI monthly report show, so neither counts an
 * import (whose `joinedAt` defaults to the import time) as a join, and both
 * agree with the Reports "Joined this month" tile for the same window.
 */
export async function loadJoinedInWindows(
  tx: TxClient,
  tenantId: string,
  now: Date,
  windows: readonly { start: Date; at: Date }[],
): Promise<{ joined: number; basis: MembershipBasis; caption: string }[]> {
  const loaded = await loadMembershipInput(tx, tenantId, now);
  const caption = estimatedCaption(loaded);
  return windows.map((w) => {
    // Joins counted as moves, as the Reports Joined tile counts them (review 26 Oct: distinct people
    // made Analysis lower than Reports when someone rejoined twice in one period).
    const { joinedMoves, basis } = moversAndBasisInWindow(loaded.input, w);
    return { joined: joinedMoves, basis, caption };
  });
}

export async function loadMembershipInput(tx: TxClient, tenantId: string, now: Date): Promise<MembershipInput> {
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
  const backfilledIds = new Set(events.filter((e) => e.sourceAction === STATUS_BACKFILL_SOURCE_ACTION).map((e) => e.memberId));
  const ledgerIds = new Set(ledgerMembers.map((r) => r.memberId).filter((id): id is string => !!id && training.has(id)));

  // 2. The ledger in memory, for training ledger members with no back-filled
  // events (the planner itself leaves out members who have them).
  let historySource: MembershipReport["historySource"] = backfilledIds.size > 0 ? "backfill" : "none";
  let undated = new Set<string>();
  if ([...ledgerIds].some((id) => !backfilledIds.has(id))) {
    const plan = await planTenantBackfill(tx, tenantId);
    undated = new Set(plan.undatedMemberIds);
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
    if (plan.inputs.length > 0 && historySource === "none") historySource = "ledger";
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
      // Only members the planner could not date for want of a date; members
      // left out for other reasons (erased, nothing before the first event) are not.
      if (undated.has(m.id)) undatedHistory += 1;
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

  return {
    input: { events, live: members.map((m) => ({ id: m.id, status: m.status })), now, timeZone, boundary },
    historySource,
    undatedHistory,
    fromJoinDates,
  };
}
