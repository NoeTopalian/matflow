"use client";

import { useEffect, useOptimistic, useRef, useTransition, type ElementType, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
// Shared cell escaper WITH the formula-injection guard — the local copy this
// file carried quoted delimiters but did not neutralise a leading =/+/-/@, so a
// member named "=cmd()" exported as a live formula. See lib/csv.ts.
import { csvDocument } from "@/lib/csv";
import { formatDateTime, formatTime } from "@/lib/date";
import { paymentHealthLine } from "@/lib/billing";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  Cell,
  PieChart,
  Pie,
  CartesianGrid,
  ReferenceArea,
} from "recharts";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Calendar,
  ChevronRight,
  CreditCard,
  Download,
  Info,
  QrCode,
  RefreshCcw,
  ShieldCheck,
  Trophy,
  TrendingDown,
  TrendingUp,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import type { ReportsData, AttendanceRateMode } from "@/lib/reports";
import { FAILED_TO_RECONCILE_COPY, OTHER_OWING_COPY, PAYER_COPY, POPULATION_COPY, payerGuardianNote } from "@/lib/member-population";
import type { AttributionData } from "@/lib/attribution";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import NetNewMembersCard from "./NetNewMembersCard";
import { MEMBERSHIP_COPY, combinedBasis, emptyTally, estimatedCaption, type MembershipBasis } from "@/lib/membership-movement";
import type { MembershipReport } from "@/lib/membership-report";
import { clubMonthWindow } from "@/lib/club-month";
import { periodChange, periodWords, windowLabelOf, type ReportRange } from "@/lib/report-period";
import PeriodSelector, { periodSearchParams, type PeriodChoice } from "./PeriodSelector";
import { basisNote } from "@/lib/net-new-series";
import { bucketNote, comparisonGap, noCoverage, noRecordsNote, partialNote } from "@/lib/attendance-coverage";
import {
  EmptyChart,
  RatioValue,
  SectionTitle,
  formatNumber,
  formatPct,
  formatRatio,
  formatSigned,
  ratioCounts,
  wholePct,
  type TooltipPayload,
} from "./reports-primitives";
import ConversionFunnel, { coachShare, dropShare } from "@/components/dashboard/ConversionFunnel";
import {
  changeCounts,
  formatChange,
  formatGuardedRatio as funnelRate,
  formatGuardedRatioNote as funnelRateNote,
  MONTH_SO_FAR,
  shareOf,
  WEEK_SO_FAR,
  type ChangePeriods,
} from "@/lib/percent";
import DonutChart, { DonutLegend, type DonutSlice } from "@/components/dashboard/charts/DonutChart";
import Sparkline from "@/components/dashboard/charts/Sparkline";
import InitiativesPanel from "@/components/dashboard/InitiativesPanel";
import MonthlyReportView from "@/components/dashboard/MonthlyReportView";

/** The estimate line for a period figure compared with the run before it (the New tile and its CSV row). */
export function periodPairEstimateNote(data: Pick<ReportsData, "membership" | "range" | "periodMovement">): string | null {
  const caption = estimatedCaption(data.membership);
  const pm = data.periodMovement;
  const w = periodWords(data.range);
  const parts: string[] = [];
  const now = estimateLabel(pm.basis, caption);
  const before = estimateLabel(pm.previousBasis, caption);
  if (now) parts.push(`${w.during} ${now.charAt(0).toLowerCase()}${now.slice(1)}`);
  if (before) parts.push(`${w.before} ${before.charAt(0).toLowerCase()}${before.slice(1)}`);
  if (parts.length === 0) return null;
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The CSV's statement of the period, and in which zone its months run. */
export function rangeCsvDetail(range: Pick<ReportRange, "timeZone" | "isCurrent">): string {
  return `Whole months, midnight to midnight in the club's time zone (${range.timeZone})${range.isCurrent ? ", to today" : ""}`;
}

/** D9: "Inactive or left, marked overdue, not chased", with the guardian count when any. Screen and CSV share it. */
export function otherOwingDetail(guardians: number): string {
  return withGuardians(OTHER_OWING_COPY.short, guardians);
}

/** "Inactive or left · check before treating as owed", with the guardian count when any. Screen and CSV share it. */
export function failedToReconcileDetail(guardians: number): string {
  return withGuardians(FAILED_TO_RECONCILE_COPY.short, guardians);
}

function withGuardians(text: string, guardians: number): string {
  if (guardians <= 0) return text;
  return `${text} · ${guardians === 1 ? "includes 1 parent or guardian" : `includes ${guardians.toLocaleString("en-GB")} parents or guardians`}`;
}

/**
 * The words for a figure that is not wholly recorded: "Partly estimated", or
 * what a wholly estimated month came from ("Estimated from your TeamUp
 * history"). Null when it is recorded, or there is no data. Every movement
 * figure on screen and in the CSV goes through this (24 Oct 2026).
 */
export function estimateLabel(basis: MembershipBasis | undefined, caption: string): string | null {
  if (basis === "estimated") return basisNote("estimated", caption);
  if (basis === "mixed") return basisNote("mixed");
  return null;
}

/** The basis of the current club month and the one before it ("none" when absent). */
export function thisAndLastMonthBasis(m: Pick<MembershipReport, "movementsByMonth">): { current: MembershipBasis; previous: MembershipBasis } {
  const i = m.movementsByMonth.findIndex((r) => r.isCurrentMonth);
  return {
    current: i >= 0 ? m.movementsByMonth[i].basis : "none",
    previous: i > 0 ? m.movementsByMonth[i - 1].basis : "none",
  };
}

/**
 * The estimate line for a this-month figure compared with last month (the
 * "New this month" tile and its CSV row): either month may be estimated, and
 * the comparison is only as firm as the weaker of the two.
 */
export function monthPairEstimateNote(m: Pick<MembershipReport, "movementsByMonth" | "historySource" | "fromJoinDates">): string | null {
  const caption = estimatedCaption(m);
  const { current, previous } = thisAndLastMonthBasis(m);
  const parts: string[] = [];
  const now = estimateLabel(current, caption);
  const before = estimateLabel(previous, caption);
  if (now) parts.push(`this month ${now.charAt(0).toLowerCase()}${now.slice(1)}`);
  if (before) parts.push(`last month ${before.charAt(0).toLowerCase()}${before.slice(1)}`);
  if (parts.length === 0) return null;
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const HERO_PALETTE = ["#67BA90", "#EB3163", "#C9F990", "#8E1F57", "#224541", "#F59E0B", "#38BDF8"];

interface Props {
  data: ReportsData;
  /** The conversion funnel's data — the same fetch /dashboard/attribution uses. */
  attribution: AttributionData;
  primaryColor: string;
}

/**
 * Which numbers the class/age filters scope. Shown as an (i) beside those two
 * controls — ALWAYS present, so it never appears/disappears and moves the row
 * (it used to be a conditional paragraph, and every click reflowed the bar).
 */
const SCOPE_NOTE =
  "Class and age filters scope attendance, check-ins, top classes, the rate above and the owner insights. Growth, churn, retention, payments and the conversion funnel stay club-wide.";

function ScopeInfo() {
  // Focusable (tabIndex) so a keyboard user reaches the note; the global
  // :focus-visible ring applies. Phones have no hover — the same note is also
  // rendered as a visible line under the controls below the sm breakpoint.
  return (
    <span
      className="inline-flex rounded-[var(--r-sm)]"
      title={SCOPE_NOTE}
      role="img"
      aria-label={SCOPE_NOTE}
      tabIndex={0}
    >
      <Info className="w-4 h-4 shrink-0" style={{ color: "var(--tx-3)" }} aria-hidden="true" />
    </span>
  );
}

function hex(h: string, a: number) {
  const clean = h.replace("#", "");
  const valid = /^[0-9a-fA-F]{6}$/.test(clean) ? clean : "3b82f6";
  const n = parseInt(valid, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** A class's fill rate with the places behind it (T2b), the denominator named: "45% (90 of 200 places)", or "no capacity set". */
function formatFill(cls: { fillRate: number | null; count: number; capacityTotal?: number }) {
  if (cls.fillRate === null || !cls.capacityTotal) return "no capacity set";
  return `${formatPct(cls.fillRate, cls.capacityTotal)} (${formatNumber(cls.count)} of ${formatNumber(cls.capacityTotal)} places)`;
}

/**
 * The customisable attendance-rate DEFINITION (Track G): "checkins-per-member"
 * is a raw average (e.g. "3.2"), the other two modes are percentages of a
 * denominator. `null` means the mode's denominator was honestly zero for
 * this tenant/window (no active members, or no class has capacity set) —
 * rendered as "—", never a fabricated 0 (UI-RULES §7).
 */
function formatAttendanceRateValue(mode: AttendanceRateMode, value: number | null) {
  if (value === null) return "—";
  return mode === "checkins-per-member" ? value.toLocaleString("en-GB") : `${value}%`;
}

/**
 * The counts behind the rate readout (T2b): "(31 of 312)" for the two
 * percentage modes, "(420 check-ins ÷ 131 members)" for the per-member
 * average. Empty when the rate is undefined ("—" says it all).
 */
function attendanceRateCounts(rate: ReportsData["attendanceRate"]) {
  if (rate.value === null || !rate.denominator) return "";
  if (rate.mode === "checkins-per-member") {
    return `(${formatNumber(rate.numerator)} check-ins ÷ ${formatNumber(rate.denominator)} members)`;
  }
  return ratioCounts(rate.numerator, rate.denominator);
}

/**
 * Figures every surface (screen and CSV) derives from the same data, so the
 * two can never print different numbers for one metric (T2b acceptance 3).
 */
function derivedShares(data: ReportsData) {
  const { summary, checkInMethods } = data;
  const totalMethodCount = checkInMethods.reduce((sum, row) => sum + row.count, 0);
  const selfServiceCount = checkInMethods
    .filter((row) => row.method === "self" || row.method === "qr")
    .reduce((sum, row) => sum + row.count, 0);
  return {
    totalMethodCount,
    selfServiceCount,
    selfServicePct: wholePct(selfServiceCount, totalMethodCount),
    // Q4 A-2: the active share is over CURRENT members (active, inactive,
    // tasters), never over everyone who ever joined.
    activeSharePct: wholePct(summary.activeMembers, summary.currentMembers),
  };
}

/**
 * What the "Active members" number counts (Q4 A-1): the shared population
 * copy plus the on-hold count it includes, so the tile and the CSV row
 * describe one number the same way. Each count that is a share of a named
 * population carries its percentage (owner decision, 27 Oct 2026, 23:30):
 * "Includes 12 on hold · 9% of 130 active · 87% of 150 current members".
 * An empty population has no percentage.
 */
export function activeMembersDetail(summary: Pick<ReportsData["summary"], "activeMembers" | "activeOnHoldMembers" | "currentMembers">): string {
  const onHold = summary.activeOnHoldMembers ?? 0;
  return [
    `Includes ${formatNumber(onHold)} on hold`,
    shareOf(onHold, summary.activeMembers, "active"),
    shareOf(summary.activeMembers, summary.currentMembers, "current members") ?? `${formatNumber(summary.currentMembers)} current members`,
    POPULATION_COPY.active.excludes,
  ].filter(Boolean).join(" · ");
}

/**
 * One status row that holds every current member: its share is 100% by
 * construction, so the screen and CSV give the count, not an artificial
 * "100% (n of n)" (owner decision, 27 Oct 2026, 23:30).
 */
function isWholeOfCurrent(rows: ReportsData["currentMembersByStatus"], currentMembers: number): boolean {
  return rows.length === 1 && rows[0].count === currentMembers;
}

/** "12 inactive to review · 8% of 150 current members": the Member attention insight. */
export function inactiveToReview(inactive: number, currentMembers: number): string {
  if (inactive <= 0) return "No inactive members";
  return [`${formatNumber(inactive)} inactive to review`, shareOf(inactive, currentMembers, "current members")].filter(Boolean).join(" · ");
}

/**
 * How the page's attendance figures read under the club's attendance coverage
 * (owner rule, 28 Oct 2026: missing coverage is never a claim that nobody
 * attended; lib/attendance-coverage). The screen and the CSV both read it, so
 * the two say the same thing. Without `attendanceCoverage` (a fixture built
 * before it existed) every span reads as covered, as the page always did.
 *
 *   - `missing`: the period has no records — its figures are "—" with this note;
 *   - `partial`: "Records start 3 Mar 2026" — the period starts before them;
 *   - `thisWeekMissing` / `thisWeekPartial`: the same for this week (Monday to now);
 *   - `weekGap`: this week is counted but last week is not (fully) covered —
 *     no percentage change, this text instead.
 */
export function attendanceCoverageView(data: Pick<ReportsData, "attendanceCoverage">) {
  const c = data.attendanceCoverage;
  if (!c) return { missing: null, partial: null, thisWeekMissing: null, thisWeekPartial: null, weekGap: null };
  const thisWeekMissing = noCoverage(c.thisWeek) ? noRecordsNote(c, c.thisWeek) : null;
  return {
    missing: noCoverage(c.period) ? noRecordsNote(c, c.period) : null,
    partial: partialNote(c, c.period),
    thisWeekMissing,
    thisWeekPartial: partialNote(c, c.thisWeek),
    weekGap: thisWeekMissing ? null : comparisonGap(c.lastWeek),
  };
}

/**
 * The attendance chart's rows (28 Oct 2026): `value` is null for a bar the
 * club's records do not cover, so it is drawn as no data rather than a zero
 * bar, and `note` is what the tooltip and the CSV say about an uncovered or
 * partly covered bar ("No records (MatFlow's records start 3 Mar 2026)",
 * "Partly covered (records start 3 Mar 2026)").
 */
export function attendanceChartRows(data: Pick<ReportsData, "weeklyAttendance" | "attendanceCoverage">) {
  const c = data.attendanceCoverage;
  return data.weeklyAttendance.map((row) => ({
    ...row,
    value: c && noCoverage(row.coverage) ? null : row.count,
    note: c ? bucketNote(c, row.coverage) : null,
  }));
}

/** The top classes the class-mix donut shares check-ins across. */
export function classComposition(topClasses: ReportsData["topClasses"]) {
  const top = topClasses.slice(0, 6);
  const total = top.reduce((sum, cls) => sum + cls.count, 0);
  return { top, total, label: `top ${top.length} ${top.length === 1 ? "class" : "classes"}` };
}

/**
 * The Members drill-through for a "this month" tile. It carries the report's
 * club-zone month (review L4), so the rows listed are the month the tile
 * counted — never one recomputed in the browser's zone, and never the next
 * month if the calendar turned while the cached report was on screen.
 */
export type MonthDrillFilter = "new-this-month" | "rejoined-this-month" | "lost-this-month" | "tasters-this-month" | "churned-this-month";

export function monthDrillHref(filter: MonthDrillFilter, period: ReportsData["period"] | undefined, range?: Pick<ReportRange, "fromMonth" | "toMonth">): string {
  const params = new URLSearchParams({ filter });
  // A period of several months lists the members of the whole run (the Members
  // page reads from/to as one window); one month keeps the `month` link.
  if (range && range.fromMonth !== range.toMonth) {
    params.set("from", range.fromMonth);
    params.set("to", range.toMonth);
  } else if (range) {
    params.set("month", range.toMonth);
  } else if (period?.monthKey) {
    params.set("month", period.monthKey);
  }
  return `/dashboard/members?${params.toString()}`;
}

/** The CSV's statement of which month "this month" is, and in which zone. */
export function periodCsvDetail(period: ReportsData["period"]): string {
  return `"This month" runs midnight to midnight in the club's time zone (${period.timeZone})`;
}

/**
 * What Payment recovery counts (round-3 review L3): every ACCOUNT with a
 * failed payment in the last 90 days, whatever its status (cancelled
 * included) and account type, and "recovered" is the stored status paid
 * (lib/reports.ts). Not a payer total, so it does not say "payers".
 */
export const RECOVERY_SCOPE = "Accounts with a failed payment in the period now marked paid (any status, parents and guardians included)";

/**
 * D11 (23 Oct 2026): ONE movement definition (lib/membership-movement.ts) for
 * the tiles, the charts, the tally line, the CSV and the drill-throughs. The
 * current club month's tally, or an empty one when the month has no data.
 */
export function currentMonthMovement(m: Pick<MembershipReport, "movementsByMonth">): MembershipReport["totals"] {
  const current = m.movementsByMonth.find((r) => r.isCurrentMonth && r.basis !== "none");
  return current ?? emptyTally();
}

/** "New 1 · Rejoined 1 · Tasters added 1 · Left 2 · Net 0": the Joined tile's lines and its CSV detail. */
export function joinedTileDetail(t: MembershipReport["totals"]): string {
  return `New ${formatNumber(t.new)} · Rejoined ${formatNumber(t.rejoined)} · Tasters added ${formatNumber(t.tasterAdded ?? 0)} · Left ${formatNumber(t.lost)} · Net ${formatSigned(t.net)}`;
}

/** The "New this month" tile's scope, in the movement words. */
export const NEW_SCOPE = "First ever start. Rejoins, tasters and imports are counted apart";
/**
 * Churn (owner decision, 27 Oct 2026, superseding the opening-cohort rate of
 * 26 Oct): the total cancellations in the period, as a count. No percentage:
 * its denominator is not approved. The tile is titled "Churn", the word the
 * owner and Sean use; its value line names the unit ("4 cancellations in the
 * last 3 months"), so "Churn (cancellations)" would say it twice. The CSV has
 * no value words, so its row names the unit: "Churn (cancellations) …".
 */
export const CHURN_TITLE = "Churn";
/** What the churn count includes and leaves out, on the tile and in the CSV. */
export const CHURN_COUNTED =
  "Every cancellation in the period, including people who joined during it. Finished prepaid courses are not churn (they are in Left). Club-wide";

/** "cancellations in the last 3 months": the words after the churn count. */
export function churnUnitText(cancelled: number, words: Pick<ReturnType<typeof periodWords>, "during">): string {
  return `${cancelled === 1 ? "cancellation" : "cancellations"} ${words.during}`;
}

/** "4 cancellations in the last 3 months": the churn tile's value line. */
export function churnValueText(cancelled: number, words: Pick<ReturnType<typeof periodWords>, "during">): string {
  return `${formatNumber(cancelled)} ${churnUnitText(cancelled, words)}`;
}

/**
 * Delta as display text, or null when nothing moved. A percentage always
 * carries the two figures it compares (required by Sean's note relayed 14 Oct
 * and the owner instruction of 24 Oct 2026): "+13% (45 vs 40)". The
 * percentage is lib/percent's `formatChange` (multiply first), so 229 vs 200
 * reads "+15%" here and in Analysis alike.
 *
 * `periods` names the two sides when the current one is not over yet (this
 * week since Monday against all of last week): "-90% (12 so far this week vs
 * 120 all last week)". With no previous figure there is no percentage, but
 * the counts stay (owner decision, 27 Oct 2026, 23:30): "— (12 so far this
 * week vs 0 all last week)". It used to read a bare "+12".
 */
export function trendDelta(current: number, previous: number, periods?: ChangePeriods) {
  if (current === previous) return null;
  return formatChange(current, previous, periods);
}

/** `trendDelta` for a line that always shows: "No change (40 so far this week vs 40 all last week)" when nothing moved. */
function trendText(current: number, previous: number, periods?: ChangePeriods) {
  return trendDelta(current, previous, periods) ?? `No change ${changeCounts(current, previous, periods)}`;
}

/**
 * The CSV's change cell: "Change -90% (12 so far this week vs 120 all last
 * week)". The word "Change" leads so the cell never starts with "+" or "-",
 * which the CSV's formula guard (lib/csv.ts) would prefix with a quote.
 */
export function changeCsvDetail(current: number, previous: number, periods: ChangePeriods): string {
  const delta = trendDelta(current, previous, periods);
  return delta === null ? trendText(current, previous, periods) : `Change ${delta}`;
}

function trendTone(current: number, previous: number) {
  if (current > previous) return "up";
  if (current < previous) return "down";
  return "flat";
}

function funnelCsvRows(attribution: AttributionData): (string | number | null)[][] {
  const { overall, rows, epochStart, minTrials } = attribution;
  // The funnel's own text (ConversionFunnel funnelRate, dropShare and
  // coachShare), so the file and the screen agree: "12.5% (5 of 40)",
  // "N/A · too few (1 of 2)", "—", and the drop-offs "52% (24 of 46) of trials".
  const scope = `Club-wide${epochStart ? ` · counting trials from ${epochStart.slice(0, 10)}` : ""} · rates need ${minTrials}+ trials`;
  const withScope = (share: string | null) => (share ? `${share} · ${scope}` : scope);
  if (overall.trials === 0) return [["Conversion funnel", "Trials run", 0, "No trials recorded yet"]];
  return [
    ["Conversion funnel", "Trials run", overall.trials, scope],
    ["Conversion funnel", "Lost before joining", overall.lost, withScope(dropShare(overall.lost, overall.trials, minTrials, "trials"))],
    ["Conversion funnel", "No decision recorded", overall.undecided, withScope(dropShare(overall.undecided, overall.trials, minTrials, "trials"))],
    ["Conversion funnel", "Converted", overall.converted, funnelRateNote(overall.conversionRate, overall.converted, overall.trials, "of trials")],
    ["Conversion funnel", "No longer active", overall.churned, withScope(dropShare(overall.churned, overall.converted, minTrials, "converted"))],
    ["Conversion funnel", "Still active", overall.retained, funnelRateNote(overall.retentionRate, overall.retained, overall.converted, "of converted")],
    ...rows
      .filter((row) => row.trialsRun > 0)
      .map((row) => [
        "Conversion by coach",
        row.name,
        row.trialsRun,
        `converted ${funnelRate(row.conversionRate, row.conversions, row.trialsRun)} · still active ${funnelRate(row.retentionRate, row.retained, row.conversions)} · lost ${coachShare(row.lost, row.trialsRun, minTrials)} · no decision ${coachShare(row.undecided, row.trialsRun, minTrials)}`,
      ]),
  ];
}

function validGeneratedAt(generatedAt: string): Date | null {
  const d = new Date(generatedAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * "As of 14:05" on screen and the CSV's "Generated at" row read the same
 * instant through the same en-GB formatter, in the browser's zone, so the
 * file states the time the owner saw (T2c).
 */
export function generatedAtTime(generatedAt: string): string {
  const d = validGeneratedAt(generatedAt);
  return d ? formatTime(d) : "—";
}

/**
 * The CSV file name, dated from `generatedAt` (the moment the figures were
 * computed) — not the browser's "now", which could be a different day for a
 * page left open overnight. Local calendar date, matching the "Generated at"
 * row inside the file.
 */
export function reportsCsvFilename(generatedAt: string): string {
  const d = validGeneratedAt(generatedAt) ?? new Date();
  const ymd = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
  return `matflow-reports-${ymd}.csv`;
}

/**
 * T8c: the movement tally for the window, one row per month (new, rejoined,
 * lost with its split, net) and the active-member headcount at each month
 * end — the same figures the Net New Members card draws, with each month's
 * basis (what it was estimated from) so an estimate never reads as a record.
 * Months that ended before the club's earliest event have no data and are
 * left out, as on the card. Net is a number cell, so a negative month stays a
 * number.
 */
export function membershipCsvRows(m: MembershipReport): (string | number | null)[][] {
  if (m.movementsByMonth.length === 0) return [];
  const t = m.totals;
  const caption = estimatedCaption(m);
  const split = (r: MembershipReport["totals"]) =>
    `New ${r.new} · Rejoined ${r.rejoined} · Left ${r.lost} (cancelled ${r.lostCancelled}, completed course ${r.lostCompleted}) · Tasters added ${r.tasterAdded ?? 0}`;
  return [
    [
      "Membership movement",
      `${m.window.from} – ${m.window.to}`,
      t.net,
      [`${split(t)} · ${MEMBERSHIP_COPY.definition} ${MEMBERSHIP_COPY.deletion}`, estimateLabel(combinedBasis(m.movementsByMonth.map((r) => r.basis)), caption)].filter(Boolean).join(" · "),
    ],
    ...m.movementsByMonth.filter((r) => r.basis !== "none").map((r) => [
      "Membership movement by month",
      r.label,
      r.net,
      [
        split(r),
        r.imported > 0 ? `Brought over by an import without dated history ${r.imported}` : null,
        r.otherIn > 0 || r.otherOut > 0 ? `Other changes in ${r.otherIn}, out ${r.otherOut}` : null,
        basisNote(r.basis, caption),
      ].filter(Boolean).join(" · "),
    ]),
    ...m.headcountByMonth.filter((h) => h.basis !== "none").map((h) => [
      "Active members at month end",
      h.label,
      h.headcount,
      [h.isCurrentMonth ? "Today, equals Active members" : MEMBERSHIP_COPY.headcount, basisNote(h.basis, caption)].filter(Boolean).join(" · "),
    ]),
  ];
}

/**
 * The Reports CSV as text: BOM, CRLF, every cell through csvCell
 * (lib/csv.ts csvDocument). Pure, so the export is testable without a browser.
 * The first data row states when the figures were computed (T2c): the CSV is
 * built from the page's cached data, so without it a file could not say how
 * old its numbers are.
 */
export function reportsCsv(data: ReportsData, attribution: AttributionData): string {
  const range = data.range;
  const words = periodWords(range);
  const pm = data.periodMovement;
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const windowLabel = windowLabelOf(range);
  // Same scoping as the on-screen labels (ReportsView.scopedWindowLabel): the
  // class/age filters only narrow attendance-derived rows below, never the
  // membership/payment ones, so a downloaded CSV can't be misread as a
  // filtered export of numbers that were never filtered.
  const filterSuffix = [
    data.filters.className,
    data.filters.ageGroup === "adult" ? "Adults" : data.filters.ageGroup === "kids" ? "Kids" : null,
  ].filter(Boolean).join(" · ");
  const scopedWindowLabel = filterSuffix ? `${windowLabel} · ${filterSuffix}` : windowLabel;
  const { churn, retention } = data;
  const recovery = data.paymentHealth.recovery;
  const shares = derivedShares(data);
  const thisMonthEstimate = estimateLabel(pm.basis, estimatedCaption(data.membership));
  // Attendance coverage (28 Oct 2026), exactly as on screen: "—" and the note
  // for a period with no records, "Records start <date>" on a partly covered one.
  const cov = attendanceCoverageView(data);
  const attendanceLabel = [scopedWindowLabel, cov.partial].filter(Boolean).join(" · ");
  const missingLabel = cov.missing ? `${scopedWindowLabel} · ${cov.missing}` : null;
  const coverageBuckets = attendanceChartRows(data);
  const rows: (string | number | null)[][] = [
    ["Section", "Metric", "Value", "Detail"],
    ["Report", "Generated at", validGeneratedAt(data.generatedAt) ? formatDateTime(data.generatedAt) : "—", "Figures cached for up to 60 seconds"],
    ["Report", "Period", range.label, rangeCsvDetail(range)],
    ["Summary", "Total members", data.summary.totalMembers, "Every training member on record, including those who have left"],
    ["Summary", "Current members", data.summary.currentMembers, "Active and inactive members and tasters"],
    ["Summary", "Active members", data.summary.activeMembers, activeMembersDetail(data.summary)],
    // Attendance this week IS narrowed by the class/age filters (lib/reports.ts
    // attendanceScope), so its export row must say so — it was the one scoped
    // number leaving the page unlabelled (assessment lane 5).
    // The tiles' change text, part period named (owner decision, 27 Oct 2026,
    // 23:30); attendance this week is "Now", whatever the period.
    ["Summary", "Attendance this week", cov.thisWeekMissing ? "—" : data.summary.attendanceThisWeek, [
      "Now",
      cov.thisWeekMissing ?? cov.weekGap ?? changeCsvDetail(data.summary.attendanceThisWeek, data.summary.attendanceLastWeek, WEEK_SO_FAR),
      cov.thisWeekMissing ? null : cov.thisWeekPartial,
      filterSuffix,
    ].filter(Boolean).join(" · ")],
    ["Summary", `New members ${words.during}`, data.summary.newMembersThisMonth, [changeCsvDetail(data.summary.newMembersThisMonth, data.summary.newMembersLastMonth, periodChange(range)), NEW_SCOPE, periodPairEstimateNote(data)].filter(Boolean).join(" · ")],
    ["Summary", "Check-ins", cov.missing ? "—" : data.summary.totalCheckIns, missingLabel ?? attendanceLabel],
    // The rate definition the owner chose on screen, with its formula — the
    // headline of the filter bar, previously missing from the file.
    ["Summary", `Attendance rate — ${data.attendanceRate.label}`, cov.missing ? "—" : [formatAttendanceRateValue(data.attendanceRate.mode, data.attendanceRate.value), attendanceRateCounts(data.attendanceRate)].filter(Boolean).join(" "), `${data.attendanceRate.formula} · ${missingLabel ?? attendanceLabel}`],
    ["Summary", "Active classes", data.summary.totalActiveClasses, "Now · live timetable classes"],
    // Health rows (T2b): the same text the tiles print, so the file and the
    // screen agree. Club-wide — the class/age filters never scope them.
    // Churn: the count of cancellations, never a percentage (no denominator is approved).
    ["Health", `${CHURN_TITLE} (cancellations) ${words.during}`, churn.cancelled, withEstimate(CHURN_COUNTED, thisMonthEstimate)],
    // D11: the Joined tile, line for line, and the members behind each figure.
    ["Health", `Joined ${words.during} (new + rejoined)`, churn.joined, withEstimate(`${joinedTileDetail(pm.totals)} · ${MEMBERSHIP_COPY.definition}`, thisMonthEstimate)],
    ["Health", `New ${words.during}`, pm.totals.new, withEstimate("First ever start", thisMonthEstimate)],
    ["Health", `Rejoined ${words.during}`, pm.totals.rejoined, withEstimate("Started again after leaving", thisMonthEstimate)],
    ["Health", `Tasters added ${words.during}`, pm.totals.tasterAdded ?? 0, withEstimate("Not in Joined or Net", thisMonthEstimate)],
    ["Health", `Left ${words.during}`, pm.totals.lost, withEstimate("Cancelled, or finished a prepaid course", thisMonthEstimate)],
    ["Health", "Payment recovery", formatRatio(recovery.ratePct, recovery.recovered, recovery.failedMembers), RECOVERY_SCOPE],
    ["Payments", `Failed payments ${words.during}`, data.paymentHealth.failedInPeriod, "Charges that failed, any account"],
    // Review L2: payer totals, the Payments → Outstanding definition; the
    // detail says guardians who pay are counted, and how many.
    ["Payments", PAYER_COPY.label, data.paymentHealth.overdueCount, payerGuardianNote(data.paymentHealth.overdueGuardianCount ?? 0)],
    ["Payments", "Payers with no payment yet", data.paymentHealth.noPaymentYetCount, payerGuardianNote(data.paymentHealth.noPaymentYetGuardianCount ?? 0)],
    // D9: debts on inactive or cancelled accounts, beside the payers and
    // never inside them or a member total.
    ["Payments", OTHER_OWING_COPY.label, data.paymentHealth.otherOwingCount ?? 0, otherOwingDetail(data.paymentHealth.otherOwingGuardianCount ?? 0)],
    // Owner instruction of 24 Oct 2026: a failed charge is not a debt until it
    // is reconciled, so it is its own row and in no debt total.
    ["Payments", FAILED_TO_RECONCILE_COPY.label, data.paymentHealth.failedToReconcileCount ?? 0, failedToReconcileDetail(data.paymentHealth.failedToReconcileGuardianCount ?? 0)],
    ["Health", "6-month survival", formatRatio(retention.ratePct, retention.survived, retention.cohort), "Members who joined 6+ months ago, still active — not the inverse of churn"],
    ...membershipCsvRows(data.membership),
    // A bucket the records do not cover is "—" with its note, never 0 (28 Oct 2026).
    ...coverageBuckets.map((row) => (data.attendanceBucket === "month"
      ? ["Monthly attendance", row.week, row.value ?? "—", [row.isCurrentWeek ? "Current month" : null, row.note].filter(Boolean).join(" · ")]
      : ["Weekly attendance", row.week, row.value ?? "—", [row.isCurrentWeek ? "Current week" : null, row.inPeriod === false ? "Outside the period (shown for context)" : null, row.note].filter(Boolean).join(" · ")])),
    ...data.monthlySignups.map((row) => [
      "Joined by month (new + rejoined)",
      row.month,
      row.count,
      [row.isCurrentMonth ? "Current month" : null, row.inPeriod === false ? "Outside the period (shown for context)" : null, estimateLabel(row.basis, estimatedCaption(data.membership))].filter(Boolean).join(" · "),
    ]),
    ...(() => {
      if (missingLabel) return [["Class composition", "All classes", "—", missingLabel]];
      const mix = classComposition(data.topClasses);
      // One class is the whole by construction: no artificial 100%, as on the legend.
      return mix.top.map((row) => [
        "Class composition",
        row.name,
        row.count,
        mix.top.length === 1
          ? `All check-ins across the ${mix.label} · ${attendanceLabel}`
          : `${formatRatio(wholePct(row.count, mix.total), row.count, mix.total)} of check-ins across the ${mix.label} · ${attendanceLabel}`,
      ]);
    })(),
    ...(missingLabel
      ? [["Top classes", "All classes", "—", missingLabel]]
      : data.topClasses.map((row) => [
          "Top classes",
          row.name,
          row.count,
          `${attendanceLabel}, ${row.averageAttendance}/session, fill rate ${formatFill(row)}`,
        ])),
    // Q4 A-2 split: shares over current members; those who have left are a
    // count with no percentage — exactly as the status card shows them.
    ...data.currentMembersByStatus.map((row) => [
      "Current members by status",
      row.label,
      row.count,
      isWholeOfCurrent(data.currentMembersByStatus, data.summary.currentMembers) ? "All current members" : formatRatio(row.percentage, row.count, data.summary.currentMembers),
    ]),
    ["Left the club", "Cancelled members", data.summary.cancelledMembers, "Not part of current members, so no percentage"],
    ...(missingLabel
      ? [["Check-in methods", "All methods", "—", missingLabel]]
      : data.checkInMethods.map((row) => [
          "Check-in methods",
          row.label,
          row.count,
          `${data.checkInMethods.length === 1 ? "All check-ins" : formatRatio(row.percentage, row.count, shares.totalMethodCount)} · ${attendanceLabel}`,
        ])),
    ["Owner insights", "Self-service check-in", cov.missing ? "—" : formatRatio(shares.selfServicePct, shares.selfServiceCount, shares.totalMethodCount), `Self or QR · ${missingLabel ?? attendanceLabel}`],
    ["Owner insights", "Active share of current members", formatRatio(shares.activeSharePct, data.summary.activeMembers, data.summary.currentMembers), "Active members ÷ current members"],
    // The conversion funnel, club-wide then per coach — the same numbers and
    // the same honesty guards as the screen (a rate under the trial minimum
    // exports as "N/A · too few (1 of 2)", an empty base as "—").
    ...funnelCsvRows(attribution),
  ];

  return csvDocument(rows);
}

/** A CSV detail with its estimate label appended, when there is one. */
function withEstimate(detail: string, estimate: string | null): string {
  return estimate ? `${detail} · ${estimate}` : detail;
}

function exportCsv(data: ReportsData, attribution: AttributionData) {
  const blob = new Blob([reportsCsv(data, attribution)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = reportsCsvFilename(data.generatedAt);
  anchor.click();
  URL.revokeObjectURL(url);
}

// Card: the components/ui primitive (UI-RULES §1.5 / §5 — ONE card treatment,
// --r-md radius, hairline border, no shadow). This file used to carry its own
// 18px-radius, 45px-glow copy; the funnel card beneath the tiles uses the
// primitive, and the two side by side were the tell.

function TrendBadge({
  current,
  previous,
  periods,
  gap,
}: {
  current: number;
  previous: number;
  /** The current period is not over: the figures say "so far this week vs all last week". */
  periods?: ChangePeriods;
  /**
   * The base is not (fully) covered by the club's attendance records (28 Oct
   * 2026): no percentage change, this neutral text instead — "— (no records
   * for the period before)".
   */
  gap?: string | null;
}) {
  if (gap) {
    return (
      <span data-testid="trend-badge" className="inline-flex items-start rounded-[var(--r-sm)] px-2 py-1 text-[11px] max-w-full bg-[var(--sf-2)] text-tx-2">
        {gap}
      </span>
    );
  }
  const delta = trendDelta(current, previous, periods);
  // Nothing moved: say nothing. A pill announcing "no change" costs more room than it earns.
  if (delta === null) return null;

  const up = trendTone(current, previous) === "up";
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  // Tokens, not literals (UI-RULES §2), and intent colour as TEXT uses the
  // `-ink` tokens, never the hue: the raw green measured 2.27:1 on its tint.
  // Both inks on an 8% tint measure ≥4.58:1 (assessment lane 3, 2026-09-23).
  const ink = up ? "var(--hue-success-ink)" : "var(--hue-warning-ink)";
  const tint = up ? "var(--hue-success)" : "var(--hue-warning)";
  // With periods named the text is longer ("-90% (12 so far this week vs 120
  // all last week)"), so it may wrap inside the tile rather than be clipped
  // at its edge; the rounded rectangle holds two lines where a pill would not.
  return (
    <span
      data-testid="trend-badge"
      className="inline-flex items-start gap-1 rounded-[var(--r-sm)] px-2 py-1 text-[11px] max-w-full"
      style={{ color: ink, background: `color-mix(in srgb, ${tint} 8%, transparent)` }}
    >
      <Icon className="w-3 h-3 shrink-0 mt-px" />
      <span className="font-semibold tabular-nums">{delta}</span>
    </span>
  );
}

/**
 * D11: the Joined tile. One combined figure, explicitly labelled
 * "Joined this month (new + rejoined)", with New, Rejoined, Tasters added and
 * Left each on its own line and each a drill-through to exactly the members
 * that figure counted, for the report's club month. Net and the definition
 * underneath, in the words the Net New Members card uses.
 */
function JoinedThisMonthTile({
  joined,
  t,
  period,
  range,
  words,
  estimate = null,
}: {
  joined: number;
  t: MembershipReport["totals"];
  period: ReportsData["period"] | undefined;
  range: ReportRange;
  words: ReturnType<typeof periodWords>;
  /** "Partly estimated" (or what an estimate came from) when the period is not wholly recorded. */
  estimate?: string | null;
}) {
  const lines: { label: string; value: number; filter: MonthDrillFilter }[] = [
    { label: "New", value: t.new, filter: "new-this-month" },
    { label: "Rejoined", value: t.rejoined, filter: "rejoined-this-month" },
    { label: "Tasters added", value: t.tasterAdded ?? 0, filter: "tasters-this-month" },
    { label: "Left", value: t.lost, filter: "lost-this-month" },
  ];
  return (
    <Card className="!p-4" data-testid="reports-joined-tile">
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: "color-mix(in srgb, var(--color-primary) 13%, transparent)" }}
      >
        <UserPlus className="w-5 h-5" style={{ color: "var(--color-primary)" }} />
      </div>
      <p className="mt-5 text-2xl font-bold leading-tight text-tx-1" data-testid="reports-joined-value">{formatNumber(joined)}</p>
      <p className="text-xs font-medium mt-1 text-tx-3">Joined {words.during} (new + rejoined)</p>
      <ul className="mt-2 space-y-0.5 text-[11px]">
        {lines.map((line) => (
          <li key={line.filter}>
            <Link
              href={monthDrillHref(line.filter, period, range)}
              className="flex items-center justify-between gap-2 rounded px-1 -mx-1 py-0.5 text-tx-2 transition-colors hover:bg-[var(--sf-2)]"
              data-testid={`reports-joined-${line.filter}`}
            >
              <span>{line.label}</span>
              <span className="flex items-center gap-1 font-semibold tabular-nums text-tx-1">
                {formatNumber(line.value)}
                <ChevronRight className="w-3 h-3 shrink-0 text-tx-3" aria-hidden="true" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-tx-2" data-testid="reports-joined-net">
        Net {formatSigned(t.net)} {words.during} (new + rejoined − left)
      </p>
      {estimate && (
        <p className="mt-1 text-[11px] text-tx-3" data-testid="reports-joined-estimate">
          {estimate}: some of {words.possessive} moves are reconstructed, not recorded at the time.
        </p>
      )}
    </Card>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  primaryColor,
  trend,
  compactValue = false,
  href,
  hrefLabel,
}: {
  icon: ElementType;
  label: string;
  value: ReactNode;
  detail?: string;
  primaryColor: string;
  trend?: { current: number; previous: number; periods?: ChangePeriods; gap?: string | null };
  compactValue?: boolean;
  /** Drill-through target — the member rows behind this tile (Track A). */
  href?: string;
  /** Accessible name for the drill-through link; defaults to `label`. */
  hrefLabel?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-3">
        {/* The LIVE brand token, not the `primaryColor` prop: the prop comes
            from the session JWT and lags a Settings → Branding save by up to
            the token's refresh window, so tiles showed the old colour while
            buttons and the funnel had already switched (assessment lane 5). */}
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "color-mix(in srgb, var(--color-primary) 13%, transparent)" }}
        >
          <Icon className="w-5 h-5" style={{ color: "var(--color-primary)" }} />
        </div>
        {href && <ChevronRight className="w-4 h-4 shrink-0" style={{ color: "var(--tx-3)" }} aria-hidden="true" />}
      </div>
      <div className="mt-5 min-w-0">
        {/* A long name (the busiest class) wraps to two lines rather than being
            cut mid-word; the reserved height keeps one- and two-line tiles
            level across the row. */}
        <p
          className={`${compactValue ? "text-lg line-clamp-2 min-h-[2.5rem]" : "text-2xl"} font-bold leading-tight`}
          style={{ color: "var(--tx-1)" }}
          title={typeof value === "string" ? value : undefined}
        >
          {value}
        </p>
        <p className="text-xs font-medium mt-1" style={{ color: "var(--tx-3)" }}>{label}</p>
        {detail && <p className="text-[11px] mt-2" style={{ color: "var(--tx-2)" }}>{detail}</p>}
        {/* The trend pill gets its own line. It used to share the top row with
            the icon and chevron, where "−69% vs last week" had ~185px of
            content in a ~200px tile and was clipped at the edge. */}
        {/* The pill line reserves its height even when there is no change to
            report (TrendBadge renders nothing then), so a tile never grows or
            shrinks between filters and the rows beneath never shift. */}
        {trend && (
          <div className="mt-2 min-w-0 min-h-[26px]">
            <TrendBadge current={trend.current} previous={trend.previous} periods={trend.periods} gap={trend.gap} />
          </div>
        )}
      </div>
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        aria-label={`${hrefLabel ?? label} — see the members behind this number`}
        className="block rounded-2xl"
      >
        <Card data-testid="metric-card" className="h-full min-h-[126px] flex flex-col transition-colors hover:border-bd-hover">
          {body}
        </Card>
      </Link>
    );
  }

  return (
    <Card data-testid="metric-card" className="h-full min-h-[126px] flex flex-col">
      {body}
    </Card>
  );
}

/**
 * A month dot on the Joined chart: filled when the month was recorded at the
 * time, hollow when it is estimated or partly estimated, so an estimate never
 * reads as a record (the note under the chart names those months).
 */
function BasisDot(props: { cx?: number; cy?: number; color: string; payload?: { basis?: MembershipBasis } }) {
  const { cx, cy, color, payload } = props;
  if (cx === undefined || cy === undefined) return null;
  const estimated = payload?.basis === "estimated" || payload?.basis === "mixed";
  return estimated ? (
    <circle cx={cx} cy={cy} r={4} fill="var(--sf-0)" stroke={color} strokeWidth={2} strokeDasharray="2 2" />
  ) : (
    <circle cx={cx} cy={cy} r={4} fill={color} strokeWidth={0} />
  );
}

/**
 * The line under the Joined chart naming the months that are not wholly
 * recorded, or null when every month is: "Estimated from your TeamUp history:
 * May 26, Jun 26. Partly estimated: Jul 26."
 */
export function joinedEstimateNote(rows: readonly { month: string; basis?: MembershipBasis }[], caption: string): string | null {
  const estimated = rows.filter((r) => r.basis === "estimated").map((r) => r.month);
  const mixed = rows.filter((r) => r.basis === "mixed").map((r) => r.month);
  const parts: string[] = [];
  if (estimated.length > 0) parts.push(`${caption}: ${estimated.join(", ")}.`);
  if (mixed.length > 0) parts.push(`Partly estimated: ${mixed.join(", ")}.`);
  return parts.length > 0 ? `${parts.join(" ")} Hollow dots are not wholly recorded at the time.` : null;
}

function ChartTooltip({
  active,
  payload,
  label,
  suffix,
  noteFor,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
  suffix: string;
  /** A line under the value for this point (e.g. "Partly estimated"), or null. */
  noteFor?: (point: unknown) => string | null;
}) {
  if (!active || !payload?.length) return null;
  // A point with no value is no data (a bar before the club's attendance
  // records start, 28 Oct 2026): it reads "No records", never "0".
  const raw = payload[0].value;
  const value = raw === null || raw === undefined ? null : Number(raw);
  const note = noteFor ? noteFor((payload[0] as { payload?: unknown }).payload ?? {}) : null;
  return (
    <div
      className="rounded-xl border px-3 py-2 text-sm shadow-xl"
      style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)" }}
    >
      <p className="text-xs mb-1" style={{ color: "var(--tx-3)" }}>{label}</p>
      <p className="font-semibold" style={{ color: "var(--tx-1)" }}>
        {value === null ? "No records" : `${formatNumber(value)} ${suffix}`}
      </p>
      {note && <p className="text-xs text-tx-3">{note}</p>}
    </div>
  );
}

function ProgressRow({
  label,
  value,
  detail,
  pct,
  color,
}: {
  label: string;
  value: string;
  detail?: string;
  pct: number;
  color: string;
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate" style={{ color: "var(--tx-1)" }}>{label}</p>
          {detail && <p className="text-[11px] mt-0.5" style={{ color: "var(--tx-3)" }}>{detail}</p>}
        </div>
        <span className="text-xs font-semibold shrink-0" style={{ color: "var(--tx-2)" }}>{value}</span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--bd-default)" }}>
        <div className="h-full rounded-full" style={{ width: `${Math.max(3, Math.min(100, pct))}%`, background: color }} />
      </div>
    </div>
  );
}

function InsightRow({
  icon: Icon,
  label,
  value,
  detail,
  color,
  wrapValue = false,
}: {
  icon: ElementType;
  label: string;
  value: string;
  detail: string;
  color: string;
  /** Let a long value (a change with its periods named) wrap rather than be cut off. */
  wrapValue?: boolean;
}) {
  return (
    <div className="flex gap-3 py-3 border-b last:border-b-0" style={{ borderColor: "var(--bd-default)" }}>
      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: hex(color, 0.12) }}>
        <Icon className="w-4 h-4" style={{ color }} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--tx-3)" }}>{label}</p>
        <p className={`text-sm font-semibold mt-0.5 ${wrapValue ? "break-words" : "truncate"}`} style={{ color: "var(--tx-1)" }}>{value}</p>
        <p className="text-xs mt-0.5" style={{ color: "var(--tx-2)" }}>{detail}</p>
      </div>
    </div>
  );
}

export default function ReportsView({ data, attribution, primaryColor }: Props) {
  const {
    summary,
    weeklyAttendance,
    monthlySignups,
    currentMembersByStatus,
    checkInMethods,
    topClasses,
    churn,
    retention,
    retentionRate,
    membership,
    paymentHealth,
    period,
    classOptions,
    filters,
    attendanceRate,
    attendanceRateModes,
  } = data;
  const healthLine = paymentHealthLine(paymentHealth);
  const range = data.range;
  const words = periodWords(range);
  const pm = data.periodMovement;
  const byMonth = data.attendanceBucket === "month";
  // The latest month a custom run may end in: this month, in the club's zone.
  const latestMonth = clubMonthWindow(new Date(), range.timeZone).monthKey;
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // Every weeks/class/age-group control below drives a URL searchParam so the
  // SERVER page re-queries via lib/reports.ts — no client refetch, no
  // stale-while-revalidate flash, and a bad/old value degrades honestly
  // (see app/dashboard/reports/page.tsx and lib/reports.ts) rather than
  // silently filtering client-side against data that was never fetched for
  // the new scope.
  //
  // `replace` inside a transition (Reports UX cycle, 2026-09-23): the old
  // `router.push` made every filter click a full navigation — a history entry
  // per click, and the segment's loading.tsx skeleton swapped in and out, so
  // the whole page visibly jumped. A transition keeps the current page on
  // screen (dimmed via `isPending`) until the new data is ready, and replace
  // keeps Back meaning "leave Reports", not "undo one filter".
  // While the transition is pending the server props still describe the OLD
  // scope, and a controlled native select snaps back to its prop the moment
  // onChange fires — so for the whole refetch the controls contradicted the
  // click ("All classes" shown after choosing a class). useOptimistic shows
  // the clicked value for exactly the life of the transition and reverts to
  // the server value the moment the new page lands — no effect, no cleanup.
  type ParamKey = "classId" | "ageGroup" | "rate";
  type Shown = { period: string; from: string; to: string; classId: string; ageGroup: string | null; rate: string };
  const serverShown: Shown = {
    period: range.key,
    from: range.fromMonth,
    to: range.toMonth,
    classId: filters.classId ?? "",
    ageGroup: filters.ageGroup ?? null,
    rate: attendanceRate.mode,
  };
  const [shown, showOptimistically] = useOptimistic(
    serverShown,
    (state: Shown, update: Partial<Shown>) => ({ ...state, ...update }),
  );

  // Two clicks in quick succession used to lose the first: `useSearchParams`
  // still described the OLD url while the first navigation was pending, so
  // the second setParam built from it and dropped the first change
  // (assessment lane 1). Build from the last url this component REQUESTED
  // instead; it re-syncs to the server url whenever that lands.
  const requestedParams = useRef(new URLSearchParams(searchParams.toString()));
  useEffect(() => {
    requestedParams.current = new URLSearchParams(searchParams.toString());
  }, [searchParams]);

  function setParam(key: ParamKey, value: string | null) {
    const params = new URLSearchParams(requestedParams.current.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    requestedParams.current = params;
    const update: Partial<Shown> =
      key === "ageGroup" ? { ageGroup: value } :
      key === "classId" ? { classId: value ?? "" } :
      { rate: value ?? serverShown.rate };
    startTransition(() => {
      showOptimistically(update);
      router.replace(`/dashboard/reports?${params.toString()}`);
    });
  }

  // The period: a preset, or a custom run of months (lib/report-period). The
  // old `weeks` parameter is dropped once a period is chosen.
  function setPeriod(next: PeriodChoice) {
    const params = periodSearchParams(requestedParams.current, next);
    requestedParams.current = params;
    startTransition(() => {
      // The choice carries its months, so From/To change with the select at once (review finding 9).
      showOptimistically({ period: next.period, from: next.from, to: next.to });
      router.replace(`/dashboard/reports?${params.toString()}`);
    });
  }

  // Every period figure on this page covers the chosen months, not all time
  // (audit memory-storage 2026-08-16 P1-12) — label them so.
  const windowLabel = windowLabelOf(range);
  // Class/age-group filters only narrow the attendance-derived sections
  // (lib/reports.ts documents the exact list on ReportsData.filters) — this
  // suffix is appended ONLY to those captions, never to growth/churn/
  // retention/payment ones, so a filtered view never reads as if it changed
  // numbers it didn't.
  const filterSuffix = [
    filters.className,
    filters.ageGroup === "adult" ? "Adults" : filters.ageGroup === "kids" ? "Kids" : null,
  ].filter(Boolean).join(" · ");
  const scopedWindowLabel = filterSuffix ? `${windowLabel} · ${filterSuffix}` : windowLabel;
  // Attendance coverage (owner rule, 28 Oct 2026): with no records for the
  // period the attendance figures are "—" with `cov.missing` as their note;
  // a period that starts before the records names where they start.
  const cov = attendanceCoverageView(data);
  const attendanceLabel = [scopedWindowLabel, cov.partial].filter(Boolean).join(" · ");
  const chartRows = attendanceChartRows(data);
  const noDataRows = chartRows.filter((r) => r.value === null);
  // Computed once, used in two places (icon + its background tint) below —
  // avoids doubling the hex-literal count for the same ternary (UI-RULES §2
  // ratchet counts literals, not concepts).
  const retentionColor = (retentionRate ?? 70) >= 80 ? "#22c55e" : (retentionRate ?? 70) >= 60 ? "#f59e0b" : "#ef4444";
  const bestClass = cov.missing ? undefined : topClasses[0];
  const maxTopClass = Math.max(...topClasses.map((row) => row.count), 1);
  const { totalMethodCount, selfServiceCount, selfServicePct, activeSharePct } = derivedShares(data);
  // Q4 A-2 (split): "need review" is inactive members only. Cancelled members
  // have left the club; they appear as "Left the club: N", not as people to
  // review alongside the current ones.
  const attentionMembers = summary.inactiveMembers;
  const topMethod = checkInMethods[0];
  const recovery = paymentHealth.recovery;

  const weeklyTickFormatter = (value: string, index: number) =>
    weeklyAttendance.length > 8 && index % 2 !== 0 ? "" : value;

  const classMix = classComposition(topClasses);
  const classCompositionSlices: DonutSlice[] = classMix.top.map((cls, i) => ({
    label: cls.name,
    value: cls.count,
    color: HERO_PALETTE[i % HERO_PALETTE.length],
  }));
  const totalClassCheckins = classMix.total;

  // The sparkline draws only the weeks the records cover: a gap is not a zero.
  const trendPoints = chartRows.filter((row) => row.value !== null).map((row) => ({ label: row.week, value: row.value as number }));

  return (
    // aria-busy on the whole page while a filter refetch is in flight — the
    // tiles and captions about to change are busy, not only the readout.
    <div className="space-y-5" aria-busy={isPending || undefined}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--tx-1)" }}>Reports</h1>
          <p className="text-sm mt-0.5" style={{ color: "var(--tx-3)" }}>
            Current owner snapshot, attendance trends, and class performance.
          </p>
        </div>
        <Button variant="secondary" className="self-start sm:self-auto" onClick={() => exportCsv(data, attribution)}>
          <Download className="w-4 h-4" aria-hidden="true" />
          Export CSV
        </Button>
      </div>

      {/* Report controls: weeks window, class filter, adult/kids toggle.
          Each one drives a URL searchParam (see setParam above) so the
          server page re-queries — see lib/reports.ts for exactly which
          sections the class/age filters scope. */}
      {/* ZERO LAYOUT SHIFT, BY CONSTRUCTION (Reports UX cycle, 2026-09-23).
          Two always-present rows — the controls, then the readout — where every
          control has a FIXED width (UI-RULES §5a: never resized by text length),
          so picking a longer class, another age group or a different rate
          definition changes the numbers and nothing else. The old flex
          `justify-between` row moved on every click: the readout's text grew
          with the mode, the selects grew with the selected option (max-w, not
          w), and a conditional note came and went. (A side-by-side grid was
          tried first: the four controls need ~980px, so the Rate control
          wrapped alone beside an empty readout column at every desktop width.) */}
      <Card data-testid="reports-filters" padding="tight">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {/* The period (Noe, 26 Oct 2026): a preset, or a custom run of
                whole months. From/To are always shown, holding the period's
                months, so choosing never moves the row; editing either picks
                "Custom months". Every period card below follows it. */}
            <PeriodSelector shown={shown} latestMonth={latestMonth} timeZone={range.timeZone} onSelect={setPeriod} />

            <label className="flex items-center gap-2 text-xs font-medium" style={{ color: "var(--tx-3)" }}>
              <span className="inline-flex items-center gap-1">Class<ScopeInfo /></span>
              <Select
                aria-label="Filter by class"
                className="w-[180px]"
                value={shown.classId}
                onChange={(e) => setParam("classId", e.target.value || null)}
              >
                <option value="">All classes</option>
                {classOptions.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </label>

            <div className="flex items-center gap-2 text-xs font-medium" style={{ color: "var(--tx-3)" }}>
              <span className="inline-flex items-center gap-1">Age group<ScopeInfo /></span>
              {/* 36px tall to line up with the selects (32px compact buttons +
                  2px padding each side); inner radius = outer − padding. */}
              <div
                className="inline-flex h-9 items-center rounded-[var(--r-md)] border border-bd-default p-0.5"
                role="group"
                aria-label="Age group"
              >
                {([
                  { value: null, label: "All" },
                  { value: "adult" as const, label: "Adults" },
                  { value: "kids" as const, label: "Kids" },
                ]).map((opt) => (
                  <Button
                    key={opt.label}
                    type="button"
                    size="compact"
                    className="rounded-[calc(var(--r-md)-2px)]"
                    variant={shown.ageGroup === opt.value ? "primary" : "ghost"}
                    aria-pressed={shown.ageGroup === opt.value}
                    onClick={() => setParam("ageGroup", opt.value)}
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Attendance-rate DEFINITION (Track G): the owner picks which
                one metric "the attendance rate" means, rather than a fixed
                implicit average. `title` gives the active formula as a
                native one-line tooltip — honesty is the selling point. */}
            <label
              className="flex items-center gap-2 text-xs font-medium"
              style={{ color: "var(--tx-3)" }}
              title={attendanceRate.formula}
            >
              Rate
              {/* Sized to the longest definition ("Check-ins per active member",
                  192.5px at 14px/500) plus padding — a fixed width must fit its
                  known option set or it clips its own default on first paint. */}
              <Select
                aria-label="Attendance-rate definition"
                className="w-[250px]"
                value={shown.rate}
                onChange={(e) => setParam("rate", e.target.value)}
              >
                {attendanceRateModes.map((m) => (
                  <option key={m.mode} value={m.mode} title={m.formula}>{m.label}</option>
                ))}
              </Select>
            </label>
          </div>

          {/* The active definition's number — `title` carries the formula as a
              native tooltip so the honesty of the number is one hover away
              (Track G). Its own row under a hairline; the number sits in a
              fixed 4-character slot and the label truncates, so its geometry
              never depends on which definition is selected. It no longer
              restates the window/age filters — they are the controls above it. */}
          <div
            data-testid="rate-readout"
            className="flex items-baseline gap-2 min-w-0 border-t border-bd-default pt-3"
            title={attendanceRate.formula}
            aria-busy={isPending || undefined}
            style={{ opacity: isPending ? 0.6 : 1, transition: "opacity var(--dur-fast) var(--ease-out)" }}
          >
            <span
              className="inline-block min-w-[4ch] text-left text-lg font-bold tabular-nums"
              style={{ color: "var(--tx-1)" }}
            >
              {formatAttendanceRateValue(attendanceRate.mode, cov.missing ? null : attendanceRate.value)}
            </span>
            {/* The counts behind the number (T2b) — kept beside it, never
                truncated; the label after it gives way first. None when the
                period has no attendance records: there is nothing to count. */}
            {!cov.missing && attendanceRateCounts(attendanceRate) && (
              <span
                data-testid="rate-readout-counts"
                className="shrink-0 text-xs tabular-nums whitespace-nowrap"
                style={{ color: "var(--tx-2)" }}
              >
                {attendanceRateCounts(attendanceRate)}
              </span>
            )}
            <span className="text-xs truncate" style={{ color: "var(--tx-3)" }} title={attendanceRate.label}>
              {attendanceRate.label}
            </span>
            {/* Why the rate is "—", or that it counts only part of the period (28 Oct 2026). */}
            {(cov.missing ?? cov.partial) && (
              <span data-testid="rate-readout-note" className="text-xs truncate text-tx-3" title={cov.missing ?? cov.partial ?? undefined}>
                {cov.missing ?? cov.partial}
              </span>
            )}
            {/* Freshness. The report is served from a 60-second per-club cache
                (lib/reports.ts), so the page says when the figures were
                computed instead of implying they are live (UI-RULES §7).
                Always present, fixed slot at the row's end — nothing moves.
                Hydration: server and browser may sit in different zones, so
                the browser's rendering wins without a warning. */}
            <span
              className="ml-auto shrink-0 text-[11px] tabular-nums whitespace-nowrap"
              style={{ color: "var(--tx-4)" }}
              data-testid="reports-generated-at"
              suppressHydrationWarning
              title="Figures are recomputed at most once a minute per club"
            >
              As of {generatedAtTime(data.generatedAt)}
            </span>
          </div>

          {/* On a phone there is no hover, so the (i) note is a visible line —
              always present below sm, never toggled, so the bar still never moves. */}
          <p className="sm:hidden text-[11px] leading-snug" style={{ color: "var(--tx-3)" }}>
            {SCOPE_NOTE}
          </p>
        </div>
      </Card>

      {/* Hero chart row — donut (attendance composition) + sparkline (12-week trend) */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4">
        <Card>
          {/* Shares are over the check-ins of the classes shown (the top six at
              most), not over every check-in; the subtitle and centre say so. */}
          <SectionTitle title="Class composition" subtitle={`Share of check-ins across the ${classMix.label} — ${attendanceLabel}`} icon={Trophy} />
          {/* Chart and its empty state share a minimum height so a filter that
              empties one card does not move everything beneath it (lane 1).
              No records is said as such; a covered period with no check-ins is a real zero. */}
          {cov.missing ? (
            <EmptyChart label={cov.missing} />
          ) : totalClassCheckins === 0 ? (
            <EmptyChart label="No check-ins in this period" />
          ) : (
            <div className="flex flex-col sm:flex-row items-center gap-5 min-h-[180px]">
              <DonutChart
                data={classCompositionSlices}
                size={200}
                thickness={28}
                centerLabel={`Check-ins, ${classMix.label}`}
                centerValue={formatNumber(totalClassCheckins)}
              />
              <div className="flex-1 min-w-0 w-full">
                <DonutLegend data={classCompositionSlices} />
              </div>
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle title="Check-in trend" subtitle={`${byMonth ? "Monthly" : "Weekly"} attendance — ${scopedWindowLabel}`} icon={Activity} />
          {/* No records for the period: "—" in words, never a 0 headline
              (28 Oct 2026). A covered period with no check-ins keeps its 0. */}
          {cov.missing ? (
            <EmptyChart label={cov.missing} />
          ) : weeklyAttendance.length === 0 ? (
            <EmptyChart label="No attendance data yet" />
          ) : (
            <div className="flex flex-col gap-3 min-h-[180px]">
              {/* The headline is the period's check-ins (the chart's subject);
                  the badge is this week against last, said as such (now). */}
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-3xl font-bold tabular-nums" style={{ color: "var(--tx-1)" }} data-testid="reports-trend-total">
                  {formatNumber(summary.totalCheckIns)}
                </span>
                <span className="text-xs text-tx-3">check-ins {words.during}</span>
                {cov.partial && (
                  <span className="text-xs text-tx-3" data-testid="reports-trend-coverage">{cov.partial}</span>
                )}
                {/* Monday to now against the whole of last week, worded as on
                    the Attendance this week tile (now, whatever the period). */}
                {!cov.thisWeekMissing && (
                  <TrendBadge
                    current={summary.attendanceThisWeek}
                    previous={summary.attendanceLastWeek}
                    periods={WEEK_SO_FAR}
                    gap={cov.weekGap}
                  />
                )}
              </div>
              <div className="w-full overflow-hidden [&>svg]:w-full [&>svg]:h-auto">
                <Sparkline data={trendPoints} width={520} height={150} />
              </div>
            </div>
          )}
        </Card>
      </div>

      <MonthlyReportView primaryColor={primaryColor} />

      <InitiativesPanel primaryColor={primaryColor} />

      {/* Three tiles per row from lg (two calm rows). Six columns never fit:
          inside the dashboard's 1152px container they gave each tile ~180-200px
          — too narrow for a value, a label and a trend pill. The value block is
          anchored to the top of every tile (no justify-between) so the headline
          numbers sit on one line across the row whether or not a tile has a
          trend pill beneath. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-stretch">
        <MetricCard
          icon={Users}
          label="Active members"
          value={formatNumber(summary.activeMembers)}
          detail={`Now · ${activeMembersDetail(summary)}`}
          primaryColor={primaryColor}
          href="/dashboard/members?filter=active"
        />
        <MetricCard
          icon={Activity}
          label="Attendance this week"
          value={cov.thisWeekMissing ? "—" : formatNumber(summary.attendanceThisWeek)}
          detail={
            cov.thisWeekMissing
              ? `Now · ${cov.thisWeekMissing}`
              : ["Now · check-ins since Monday", cov.thisWeekPartial, filterSuffix].filter(Boolean).join(" · ")
          }
          primaryColor={primaryColor}
          // Monday to now against the whole of last week (lib/reports): the
          // badge says so, or a Monday morning reads as a collapse. Against a
          // week without records there is no percentage (28 Oct 2026).
          trend={cov.thisWeekMissing ? undefined : { current: summary.attendanceThisWeek, previous: summary.attendanceLastWeek, periods: WEEK_SO_FAR, gap: cov.weekGap }}
        />
        <MetricCard
          icon={UserPlus}
          label={`New ${words.during}`}
          value={formatNumber(summary.newMembersThisMonth)}
          detail={[NEW_SCOPE, periodPairEstimateNote(data)].filter(Boolean).join(" · ")}
          primaryColor={primaryColor}
          // The period against the equal period before it; a period that ends
          // today is "so far", the one before it whole.
          trend={{ current: summary.newMembersThisMonth, previous: summary.newMembersLastMonth, periods: periodChange(range) }}
          href={monthDrillHref("new-this-month", period, range)}
        />
        <MetricCard
          icon={BarChart3}
          label="Check-ins"
          value={cov.missing ? "—" : formatNumber(summary.totalCheckIns)}
          detail={cov.missing ?? attendanceLabel}
          primaryColor={primaryColor}
        />
        <MetricCard
          icon={Calendar}
          label="Active classes"
          value={formatNumber(summary.totalActiveClasses)}
          detail="Now · live timetable classes"
          primaryColor={primaryColor}
        />
        <MetricCard
          icon={Trophy}
          label="Busiest class"
          value={cov.missing ? "—" : bestClass?.name ?? "No class data"}
          detail={cov.missing ?? (bestClass ? `${formatNumber(bestClass.count)} check-ins · ${attendanceLabel}` : "No check-ins in this period")}
          primaryColor={primaryColor}
          compactValue
        />
      </div>

      {/* Conversions, up here where Sean looks first: the club-wide funnel and
          each coach's, with the drop-off at every step. Club-wide by design —
          the filters above never scope it (ScopeInfo says so). */}
      <ConversionFunnel data={attribution} linkRows />

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.55fr)_360px] gap-4">
        <Card>
          <SectionTitle
            title={byMonth ? "Attendance by month" : "Weekly Attendance"}
            subtitle={[
              attendanceLabel,
              weeklyAttendance.some((r) => r.isCurrentWeek) ? `current ${byMonth ? "month" : "week"} highlighted` : null,
              weeklyAttendance.some((r) => r.inPeriod === false) ? "earlier weeks faint for context" : null,
              !cov.missing && noDataRows.length > 0 ? `${byMonth ? "months" : "weeks"} before the records start shaded as no data` : null,
            ].filter(Boolean).join(", ")}
            icon={Activity}
          />
          {/* No records for the whole period: said in words. Otherwise bars
              before the records start are drawn as no data — shaded, no bar,
              "No records" in the tooltip — and a covered zero is a zero bar
              (28 Oct 2026). */}
          {cov.missing ? (
            <EmptyChart label={cov.missing} />
          ) : weeklyAttendance.length === 0 ? (
            <EmptyChart label="No attendance data yet" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartRows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--bd-default)" />
                <XAxis
                  dataKey="week"
                  tick={{ fill: "var(--tx-3)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={weeklyTickFormatter}
                />
                <YAxis
                  tick={{ fill: "var(--tx-3)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                {noDataRows.length > 0 && (
                  <ReferenceArea
                    x1={noDataRows[0].week}
                    x2={noDataRows[noDataRows.length - 1].week}
                    fill="var(--tx-4)"
                    fillOpacity={0.12}
                    ifOverflow="extendDomain"
                    label={{ value: "No records", position: "insideTop", fill: "var(--tx-3)", fontSize: 11 }}
                  />
                )}
                <Tooltip content={<ChartTooltip suffix="check-ins" noteFor={(p) => (p as { note?: string | null }).note ?? null} />} cursor={{ fill: "var(--sf-2)" }} />
                <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={34}>
                  {chartRows.map((row) => (
                    <Cell
                      key={row.week}
                      fill={row.isCurrentWeek ? primaryColor : hex(primaryColor, row.inPeriod === false ? 0.16 : 0.42)}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card>
          <SectionTitle title="Owner Insights" subtitle="What changed and what deserves attention" icon={TrendingUp} />
          <div>
            <InsightRow
              icon={Activity}
              label="Attendance pulse"
              value={
                cov.thisWeekMissing
                  ? "—"
                  : cov.weekGap
                    ? `${formatNumber(summary.attendanceThisWeek)} so far this week ${cov.weekGap}`
                    : trendText(summary.attendanceThisWeek, summary.attendanceLastWeek, WEEK_SO_FAR)
              }
              wrapValue
              detail={cov.thisWeekMissing ?? "This week counts from Monday; last week is the whole week"}
              color={trendTone(summary.attendanceThisWeek, summary.attendanceLastWeek) === "down" ? "#f59e0b" : "#22c55e"}
            />
            <InsightRow
              icon={Trophy}
              label="Class leader"
              value={cov.missing ? "—" : bestClass?.name ?? "No leader yet"}
              detail={cov.missing ?? (bestClass ? `${bestClass.averageAttendance} avg per attended session` : "No check-ins in this period")}
              color={primaryColor}
            />
            <InsightRow
              icon={QrCode}
              label="Self-service check-in"
              value={cov.missing ? "—" : selfServicePct === null ? "No check-ins in this period" : `${formatRatio(selfServicePct, selfServiceCount, totalMethodCount)} self or QR`}
              detail={cov.missing ?? (topMethod ? `${topMethod.label} is the top method` : "No method data yet")}
              color="#6366f1"
            />
            <InsightRow
              icon={attentionMembers > 0 ? AlertTriangle : ShieldCheck}
              label="Member attention"
              value={inactiveToReview(attentionMembers, summary.currentMembers)}
              wrapValue
              detail={
                summary.currentMembers > 0
                  ? `${formatRatio(activeSharePct, summary.activeMembers, summary.currentMembers)} of current members are active`
                  : "No current members yet"
              }
              color={attentionMembers > 0 ? "#f59e0b" : "#22c55e"}
            />
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <SectionTitle
            title="Joined"
            subtitle={monthlySignups.some((r) => r.inPeriod === false)
              ? `Joined (new + rejoined) per month · ${range.label} shaded, earlier months for context`
              : `Joined (new + rejoined) per month · ${range.label}`}
            icon={UserPlus}
          />
          {monthlySignups.every((row) => row.count === 0) ? (
            <EmptyChart label="No joins yet" />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={monthlySignups} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--bd-default)" />
                <XAxis
                  dataKey="month"
                  tick={{ fill: "var(--tx-3)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "var(--tx-3)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip content={<ChartTooltip suffix="joined (new + rejoined)" noteFor={(p) => estimateLabel((p as { basis?: MembershipBasis }).basis, estimatedCaption(membership))} />} />
                {monthlySignups.some((r) => r.inPeriod === false) && monthlySignups.some((r) => r.inPeriod) && (
                  <ReferenceArea
                    x1={monthlySignups.find((r) => r.inPeriod)!.month}
                    x2={[...monthlySignups].reverse().find((r) => r.inPeriod)!.month}
                    fill="var(--color-primary)"
                    fillOpacity={0.08}
                    ifOverflow="extendDomain"
                  />
                )}
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke={primaryColor}
                  strokeWidth={2.5}
                  dot={<BasisDot color={primaryColor} />}
                  activeDot={{ r: 6, fill: primaryColor }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
          {joinedEstimateNote(monthlySignups, estimatedCaption(membership)) && (
            <p className="mt-2 text-xs text-tx-3" data-testid="reports-joined-chart-estimate">
              {joinedEstimateNote(monthlySignups, estimatedCaption(membership))}
            </p>
          )}
        </Card>

        <Card>
          <SectionTitle title="Top Classes" subtitle={`Check-ins, average attendance, and fill rate — ${attendanceLabel}`} icon={Trophy} />
          {cov.missing ? (
            <EmptyChart label={cov.missing} />
          ) : topClasses.length === 0 ? (
            <EmptyChart label="No check-ins in this period" />
          ) : (
            <div className="space-y-4">
              {topClasses.map((cls, index) => (
                <ProgressRow
                  key={cls.name}
                  label={cls.name}
                  value={formatNumber(cls.count)}
                  detail={`${cls.averageAttendance}/session · fill ${formatFill(cls)}`}
                  pct={Math.round((cls.count / maxTopClass) * 100)}
                  color={index === 0 ? primaryColor : hex(primaryColor, 0.62 - index * 0.08)}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          {/* Q4 A-2, split status card (T2b): shares over CURRENT members
              only, adding to 100% ± rounding. Members who have left are a
              count of their own with no percentage — a cancelled slice is
              never a share of the people still on the books. */}
          <SectionTitle
            title="Current members by status"
            subtitle="Share of current members: active, inactive and tasters. Excludes guardians."
            icon={Users}
          />
          {summary.currentMembers === 0 ? (
            <EmptyChart label="No current members yet" />
          ) : (
            <div className={`grid gap-5 ${currentMembersByStatus.length > 1 ? "sm:grid-cols-[130px_1fr]" : ""}`}>
              {currentMembersByStatus.length > 1 && (
                <ResponsiveContainer width="100%" height={130}>
                  <PieChart>
                    <Pie
                      data={currentMembersByStatus}
                      dataKey="count"
                      nameKey="label"
                      cx="50%"
                      cy="50%"
                      innerRadius={38}
                      outerRadius={58}
                      strokeWidth={0}
                    >
                      {currentMembersByStatus.map((entry, index) => (
                        <Cell key={entry.status} fill={statusColor(entry.status, index)} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              )}
              <div className="space-y-3">
                {currentMembersByStatus.length === 1 && (
                  <div className="flex items-center gap-2 rounded-xl px-3 py-2 border" style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}>
                    <ShieldCheck className="w-4 h-4" style={{ color: "#22c55e" }} />
                    <span className="text-sm">All current members are {currentMembersByStatus[0].label.toLowerCase()}.</span>
                  </div>
                )}
                {/* One status is the whole by construction: its count, not an
                    artificial "100% (n of n)"; the line above says "all". */}
                {currentMembersByStatus.map((entry, index) => (
                  <ProgressRow
                    key={entry.status}
                    label={entry.label}
                    value={isWholeOfCurrent(currentMembersByStatus, summary.currentMembers) ? formatNumber(entry.count) : formatRatio(entry.percentage, entry.count, summary.currentMembers)}
                    pct={entry.percentage}
                    color={statusColor(entry.status, index)}
                  />
                ))}
              </div>
            </div>
          )}
          <p
            data-testid="left-the-club"
            className="mt-4 border-t border-bd-default pt-3 text-sm"
            style={{ color: "var(--tx-2)" }}
          >
            Left the club: <span className="font-semibold tabular-nums" style={{ color: "var(--tx-1)" }}>{formatNumber(summary.cancelledMembers)}</span>
            <span className="text-xs" style={{ color: "var(--tx-3)" }}> · cancelled members, not part of the shares above</span>
          </p>
        </Card>

        <Card>
          <SectionTitle title="Check-In Methods" subtitle={`How attendance was recorded — ${attendanceLabel}`} icon={QrCode} />
          {cov.missing ? (
            <EmptyChart label={cov.missing} />
          ) : totalMethodCount === 0 ? (
            <EmptyChart label="No check-ins in this period" />
          ) : (
            <div className="space-y-4">
              {checkInMethods.map((method) => (
                <ProgressRow
                  key={method.method}
                  label={method.label}
                  // One method is the whole by construction: its count, no artificial 100%.
                  value={checkInMethods.length === 1 ? formatNumber(method.count) : formatRatio(method.percentage, method.count, totalMethodCount)}
                  pct={method.percentage}
                  color={methodColor(method.method)}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Health Metrics ─────────────────────────────────────────────────────── */}
      <div>
        <div className="mb-3">
          <h2 className="font-semibold text-base" style={{ color: "var(--tx-1)" }}>Health Metrics</h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
            Member lifecycle and payment health at a glance.
          </p>
        </div>

        {/* KPI row — churn, joined beside it, then payment recovery.
            Retention still does NOT sit here: it read as "1 - churn" at a
            glance, which it is not (different cohort and window), so it
            keeps its own card below (Track A churn-honesty fix). Joined is
            the other side of churn's ledger for the SAME month — Q6 (agent
            default adopted 17 Oct 2026; not an owner decision) puts it
            immediately beside churn, overriding the old "no neighbour" note
            for this tile only.
            Churn is a count of cancellations (owner decision, 27 Oct 2026),
            never a percentage until a denominator is approved. Every rate
            prints its counts, "x% (n of m)"; an empty base is "—". */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-3">
          <MetricCard
            icon={UserMinus}
            label={CHURN_TITLE}
            value={
              <>
                {formatNumber(churn.cancelled)}{" "}
                <span className="text-base font-semibold">
                  {churnUnitText(churn.cancelled, words)}
                </span>
              </>
            }
            detail={withEstimate(CHURN_COUNTED, estimateLabel(pm.basis, estimatedCaption(membership)))}
            primaryColor={primaryColor}
            // The churn slice lists the people behind the count: everyone
            // with a cancelled move in the period, joiners included.
            href={monthDrillHref("churned-this-month", period, range)}
            hrefLabel={`${CHURN_TITLE}: ${churnValueText(churn.cancelled, words)}`}
          />
          <JoinedThisMonthTile
            joined={churn.joined}
            t={pm.totals}
            period={period}
            range={range}
            words={words}
            estimate={estimateLabel(pm.basis, estimatedCaption(membership))}
          />
          <MetricCard
            icon={RefreshCcw}
            label="Payment recovery rate"
            value={<RatioValue pct={recovery.ratePct} n={recovery.recovered} base={recovery.failedMembers} />}
            detail={recovery.failedMembers > 0 ? RECOVERY_SCOPE : "No failed payments in the period"}
            primaryColor={primaryColor}
          />
        </div>

        <Card className="!p-4 mb-4 flex items-start gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: hex(retentionColor, 0.13) }}
          >
            <TrendingDown className="w-4 h-4" style={{ color: retentionColor }} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>
              6-month survival: {formatRatio(retention.ratePct, retention.survived, retention.cohort)}
            </p>
            <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
              Of members who joined 6+ months ago, still active today. A different measure from the churn count above — not its inverse.
            </p>
          </div>
        </Card>

        {/* Net-new chart runs the full width (Noe, 25 Sep: "from the left side of
            the screen to the right"), with its own view switch; Payment Health
            sits under it with its four figures side by side. */}
        <NetNewMembersCard membership={membership} />
        <div className="grid grid-cols-1 gap-4">
          <Card>
            <SectionTitle title="Payment Health" subtitle={`Overdue now · failures ${words.during}`} icon={CreditCard} />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6">
              <Link
                href="/dashboard/members?filter=overdue"
                aria-label={`${PAYER_COPY.label} — see the payers behind this number`}
                className="flex items-center justify-between gap-3 py-3 -mx-1 px-1 rounded-lg transition-colors hover:bg-[var(--sf-2)]"
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center" style={{ background: hex("#ef4444", 0.12) }}>
                    <AlertTriangle className="w-4 h-4" style={{ color: "#ef4444" }} />
                  </div>
                  <div className="min-w-0">
                    {/* Review L2: a payer total, guardians who pay included. */}
                    <p className="text-sm font-medium text-tx-1">{PAYER_COPY.label}</p>
                    <p className="text-[11px] text-tx-3" data-testid="reports-payers-overdue-detail">
                      {payerGuardianNote(paymentHealth.overdueGuardianCount ?? 0)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className="text-xl font-bold tabular-nums"
                    style={{ color: paymentHealth.overdueCount > 0 ? "#ef4444" : "#22c55e" }}
                  >
                    {formatNumber(paymentHealth.overdueCount)}
                  </span>
                  <ChevronRight className="w-4 h-4 shrink-0" style={{ color: "var(--tx-3)" }} aria-hidden="true" />
                </div>
              </Link>
              <div className="flex items-center justify-between gap-3 py-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: hex("#f59e0b", 0.12) }}>
                    <CreditCard className="w-4 h-4" style={{ color: "#f59e0b" }} />
                  </div>
                  <p className="text-sm font-medium" style={{ color: "var(--tx-1)" }}>Failed {words.during}</p>
                </div>
                <span
                  className="text-xl font-bold tabular-nums"
                  style={{ color: paymentHealth.failedInPeriod > 0 ? "#f59e0b" : "#22c55e" }}
                  data-testid="reports-failed-in-period"
                >
                  {formatNumber(paymentHealth.failedInPeriod)}
                </span>
              </div>
              {/* D9: debts on inactive or cancelled accounts. Not chased and
                  not in Payers overdue, but never hidden; the drill-through
                  names them on the Members page. */}
              <Link
                href="/dashboard/members?filter=other-owing"
                aria-label={`${OTHER_OWING_COPY.label} — see the accounts behind this number`}
                data-testid="reports-other-owing"
                className="flex items-center justify-between gap-3 py-3 -mx-1 px-1 rounded-lg transition-colors hover:bg-[var(--sf-2)]"
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center" style={{ background: "var(--sf-2)" }}>
                    <CreditCard className="w-4 h-4" style={{ color: "var(--tx-3)" }} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-tx-1">{OTHER_OWING_COPY.label}</p>
                    <p className="text-[11px] text-tx-3" data-testid="reports-other-owing-detail">
                      {otherOwingDetail(paymentHealth.otherOwingGuardianCount ?? 0)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xl font-bold tabular-nums text-tx-1">{formatNumber(paymentHealth.otherOwingCount ?? 0)}</span>
                  <ChevronRight className="w-4 h-4 shrink-0" style={{ color: "var(--tx-3)" }} aria-hidden="true" />
                </div>
              </Link>
              {/* Owner instruction of 24 Oct 2026: a failed charge on an
                  inactive or cancelled account is not a debt until someone has
                  checked it — its own line, in no debt total. */}
              <Link
                href="/dashboard/members?filter=failed-to-reconcile"
                aria-label={`${FAILED_TO_RECONCILE_COPY.label} — see the accounts behind this number`}
                data-testid="reports-failed-to-reconcile"
                className="flex items-center justify-between gap-3 py-3 -mx-1 px-1 rounded-lg transition-colors hover:bg-[var(--sf-2)]"
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center" style={{ background: "var(--sf-2)" }}>
                    <CreditCard className="w-4 h-4" style={{ color: "var(--tx-3)" }} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-tx-1">{FAILED_TO_RECONCILE_COPY.label}</p>
                    <p className="text-[11px] text-tx-3" data-testid="reports-failed-to-reconcile-detail">
                      {failedToReconcileDetail(paymentHealth.failedToReconcileGuardianCount ?? 0)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xl font-bold tabular-nums text-tx-1">{formatNumber(paymentHealth.failedToReconcileCount ?? 0)}</span>
                  <ChevronRight className="w-4 h-4 shrink-0" style={{ color: "var(--tx-3)" }} aria-hidden="true" />
                </div>
              </Link>
              {healthLine?.tone === "good" && (
                <div className="flex items-center gap-2 rounded-xl px-3 py-2 border sm:col-span-2 lg:col-span-4" style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}>
                  <ShieldCheck className="w-4 h-4" style={{ color: "#22c55e" }} />
                  <span className="text-sm">{healthLine.text}</span>
                </div>
              )}
              {healthLine?.tone === "owed" && (
                <Link
                  href="/dashboard/payments"
                  className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 border sm:col-span-2 lg:col-span-4 transition-colors hover:bg-[var(--sf-2)]"
                  style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
                >
                  <span className="flex items-center gap-2">
                    <CreditCard className="w-4 h-4" style={{ color: "var(--hue-warning-ink)" }} />
                    <span className="text-sm">{healthLine.text}</span>
                  </span>
                  <span className="text-sm font-medium" style={{ color: "var(--tx-1)" }}>See who owes</span>
                </Link>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function statusColor(status: string, index: number) {
  const map: Record<string, string> = {
    active: "#22c55e",
    inactive: "#f59e0b",
    cancelled: "#ef4444",
    taster: "#38bdf8",
  };
  return map[status] ?? ["#8b5cf6", "#14b8a6", "#f97316"][index % 3];
}

function methodColor(method: string) {
  const map: Record<string, string> = {
    qr: "#6366f1",
    admin: "#f59e0b",
    self: "#10b981",
    auto: "#8b5cf6",
  };
  return map[method] ?? "#6b7280";
}
