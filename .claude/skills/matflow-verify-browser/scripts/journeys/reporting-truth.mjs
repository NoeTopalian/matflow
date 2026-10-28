// Journey: reporting truth (PR #37, sean/batch-a-reporting-truth — Sean's notes 2 and 6).
// One population definition behind every member count (lib/member-population.ts): the Members page Active headline,
// the Reports "Active members" tile and the Settings status counts must agree; churn is the count of cancellations in
// the period, joiners included, with no percentage (owner decision, 27 Oct 2026, superseding the 26 Oct opening-cohort
// rate), with "Joined this month" beside it; other rates show their counts or "—"; the CSV carries the same numbers.
// Seeds a known population into the fixture club (on top of the fixture's own Member 1 and Member 2), computes the
// expected numbers from the same definitions in SQL, then checks the screens at desktop and 390 px.
// Needs `fixture.mjs create` and `server.mjs start` (server on the PR #37 build).
//   node journeys/reporting-truth.mjs
//
// Round 3 (23 Oct 2026, review M2) adds acceptance of 47f5015b..HEAD: payers, not members, owe money (a guardian on
// their own plan who is overdue is counted and named; their paid-up child is the member), "No payment yet" wins over
// overdue for a never-paid plan, a TeamUp-flagged overdue is a payer overdue, Payments → Outstanding says the same
// split, the truncation notice is absent on a small club, the Reports drill-through carries its club-zone month
// (`month=`; a past month reads "Joined in <Month YYYY>"), and the CSV names the month and the club's zone. "This
// month" is now the CLUB's month (Tenant.timezone, lib/club-month.ts), so the expected windows below are built in
// that zone; on a club whose zone matches this machine's the numbers are the ones earlier runs expected.
//
// D11 (23 Oct 2026, sean/batch-c-headcount 525ff016): "joined" is the movement definition (lib/membership-movement.ts
// header), not joinedAt. The Joined tile is "Joined this month (new + rejoined)" with New / Rejoined / Tasters added /
// Left lines and "Net ±N this month (new + rejoined − left)"; the drill-throughs are new-, rejoined-, lost- and
// tasters-this-month. The seed writes the MemberStatusEvent rows the app writes (create: null → status; edit:
// from → to; reason staff_edit), and the expected movement is computed below from those events and, for members with
// no events, from join and cancellation dates (lib/membership-report.ts joinDateHistory).
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("reporting-truth");
const tenantId = club.tenantId;
const errors = [];

// Month windows exactly as lib/reports.ts builds them since 47f5015b: the CLUB's calendar month (Tenant.timezone),
// half-open [start, next start), by the algorithm in lib/club-month.ts (zoneOffsetMs read twice for DST).
const now = new Date();
const clubZone = (await q(`select timezone from "Tenant" where id = $1`, [club.tenantId]))[0]?.timezone || "Europe/London";
const zoneOffsetMs = (instant, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant);
  const read = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(read("year"), read("month") - 1, read("day"), read("hour") % 24, read("minute"), read("second")) - instant.getTime();
};
const zonedYearMonth = (instant) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: clubZone, year: "numeric", month: "2-digit" }).formatToParts(instant);
  return { year: Number(parts.find((p) => p.type === "year").value), month: Number(parts.find((p) => p.type === "month").value) };
};
const clubMonthStart = (offset) => {
  const { year, month } = zonedYearMonth(now);
  const naive = Date.UTC(year, month - 1 + offset, 1);
  const first = zoneOffsetMs(new Date(naive), clubZone);
  return new Date(naive - zoneOffsetMs(new Date(naive - first), clubZone));
};
const monthKeyOf = (offset) => { const d = new Date(Date.UTC(zonedYearMonth(now).year, zonedYearMonth(now).month - 1 + offset, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
// lib/date.ts formatMonthYear: en-GB long month and year, named at mid-month UTC.
const monthLabelOf = (offset) => { const [y, m] = monthKeyOf(offset).split("-").map(Number); return new Date(Date.UTC(y, m - 1, 15, 12)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }); };
const monthStart = clubMonthStart(0);
const lastMonthStart = clubMonthStart(-1);
const sixMonthsAgo = clubMonthStart(-5); // lib/reports.ts chartMonths[0].monthStart
const OLD = new Date(now.getFullYear(), now.getMonth() - 8, 15, 12);      // before the 6-month cohort line
const EARLIER = new Date(now.getFullYear(), now.getMonth() - 2, 15, 12);  // cancelled, but not this month
const THIS_MONTH = now;
// A joiner who cancels inside this club month: starts two minutes ago (never before the month began), cancels 1 s later.
const JL_START = new Date(Math.max(monthStart.getTime() + 1000, now.getTime() - 120_000));
const JL_END = new Date(JL_START.getTime() + 1000);

// ── Seed ────────────────────────────────────────────────────────────────────
// Every row is one case of a definition. Emails are this journey's own, so a re-run replaces them (deterministic).
// `event`: the MemberStatusEvent the app writes for that row (app/api/members/route.ts:511 on create, fromStatus
// null; app/api/members/[id]/route.ts:496 on a status edit), reason staff_edit, changedBy the owner. Rows without one
// predate the event log, so the report rebuilds them from joinedAt / cancelledAt (joinDateHistory).
// `move`: what that event is under the movement definition (lib/membership-movement.ts memberMovements).
const SEED = [
  { key: "active-a", name: "RT Active A", status: "active", pay: "paid", type: "adult", joined: OLD },
  { key: "active-b", name: "RT Active B", status: "active", pay: "paid", type: "adult", joined: OLD },
  { key: "active-hold", name: "RT Active Hold", status: "active", pay: "paused", hold: "paid", type: "adult", joined: OLD },
  // Created in MatFlow this month: create event null → active, the first ever start = New.
  { key: "newcomer", name: "RT Newcomer", status: "active", pay: "paid", type: "adult", joined: THIS_MONTH, event: { from: null, to: "active", at: THIS_MONTH }, move: "new" },
  { key: "inactive", name: "RT Inactive", status: "inactive", pay: "paid", type: "adult", joined: OLD },
  // Created as a taster this month: first known state taster = Tasters added (not in Joined or Net).
  { key: "taster", name: "RT Taster", status: "taster", pay: "free", type: "adult", joined: THIS_MONTH, event: { from: null, to: "taster", at: THIS_MONTH }, move: "tasterAdded" },
  // Long-standing members cancelled this month by staff: active → cancelled = Left, and a cancellation (churn).
  { key: "left-a", name: "RT Left A", status: "cancelled", pay: "cancelled", type: "adult", joined: OLD, cancelled: THIS_MONTH, event: { from: "active", to: "cancelled", at: THIS_MONTH }, move: "lost" },
  { key: "left-b", name: "RT Left B", status: "cancelled", pay: "cancelled", type: "adult", joined: OLD, cancelled: THIS_MONTH, event: { from: "active", to: "cancelled", at: THIS_MONTH }, move: "lost" },
  // Owner decision, 27 Oct 2026: churn counts people who joined during the period and then cancelled. Created this
  // month (null → active = New) and cancelled this month (active → cancelled = Left, and a cancellation).
  { key: "joined-left", name: "RT Joined Left", status: "cancelled", pay: "cancelled", type: "adult", joined: JL_START, cancelled: JL_END,
    events: [{ from: null, to: "active", at: JL_START, move: "new" }, { from: "active", to: "cancelled", at: JL_END, move: "lost" }] },
  { key: "left-earlier", name: "RT Left Earlier", status: "cancelled", pay: "cancelled", type: "adult", joined: OLD, cancelled: EARLIER },
  // D11: a former member reactivated this month: cancelled → active = Rejoined. cancelledAt cleared, so not churn.
  { key: "rejoiner", name: "RT Rejoiner", status: "active", pay: "paid", type: "adult", joined: OLD, event: { from: "cancelled", to: "active", at: THIS_MONTH }, move: "rejoined" },
  // A guardian created this month WITH its create event: guardians are never in any movement figure.
  { key: "guardian", name: "RT Guardian", status: "active", pay: "paid", type: "parent", joined: THIS_MONTH, event: { from: null, to: "active", at: THIS_MONTH } },
  // Round 3 (review M2): money is owed by PAYERS. A guardian on their own plan, cash-billed, due date passed — a
  // payer overdue, counted and named as a guardian; their child on a kids' plan, paid up — the member, never owed.
  { key: "payer-guardian", name: "RT Payer Guardian", status: "active", pay: "paid", type: "parent", joined: OLD, dueDays: -10, plan: true },
  { key: "payer-kid", name: "RT Payer Kid", status: "active", pay: "paid", type: "kids", joined: OLD, dueDays: 20, plan: true, parent: "payer-guardian" },
  // A cash member on a plan who has never paid, first due date passed: "No payment yet", never overdue.
  { key: "cash-new", name: "RT Cash No Payment", status: "active", pay: "pending", type: "adult", joined: OLD, dueDays: -5, plan: true },
  // TeamUp collects this member's money and a TeamUp refresh flagged them overdue: a payer overdue.
  { key: "teamup-overdue", name: "RT TeamUp Overdue", status: "active", pay: "overdue", type: "adult", joined: OLD, billedBy: "teamup" },
  // D9 (lib/overdue.ts:149-221): inactive or cancelled accounts with a GENUINE debt — "Other accounts owing", never
  // chased, never a payer, never in a member total beyond their own status.
  // Set inactive, then Stripe marked the plan overdue (a failure after they went inactive): evidence "marked overdue".
  { key: "owe-inactive", name: "RT Owing Inactive", status: "inactive", pay: "overdue", type: "adult", joined: OLD, plan: true },
  // Left after their last charge failed: the latest settled payment is a failed charge: evidence "failed charge".
  { key: "owe-cancelled", name: "RT Owing Cancelled", status: "cancelled", pay: "cancelled", type: "adult", joined: OLD, cancelled: EARLIER, plan: true,
    payments: [{ status: "failed", at: new Date(EARLIER.getTime() - 86_400_000), amount: 5000 }] },
  // D10 (lib/overdue.ts:273-340): the Members badge names the evidence. cash-new above is "No payment recorded".
  // A Stripe charge failed three days ago and Stripe marked them overdue: "Payment failed".
  { key: "card-failed", name: "RT Card Failed", status: "active", pay: "overdue", type: "adult", joined: OLD, plan: true,
    payments: [{ status: "failed", at: new Date(now.getTime() - 3 * 86_400_000), amount: 5000 }] },
  // Paid a month ago, the next due date passed three days ago, nothing since: "Payment outstanding".
  { key: "paid-late", name: "RT Paid Before Late", status: "active", pay: "paid", type: "adult", joined: OLD, dueDays: -3, plan: true,
    payments: [{ status: "succeeded", at: new Date(now.getTime() - 33 * 86_400_000), amount: 5000 }] },
];
const PAYMENT_TAG = "RT journey"; // Payment.description on the journey's own rows, so a re-run removes them
// A row's status events in order: `events`, or its single `event` with the row's `move`.
const eventsOf = (r) => r.events ?? (r.event ? [{ ...r.event, move: r.move }] : []);
const dueAtOf = (r) => (r.dueDays !== undefined ? new Date(now.getTime() + r.dueDays * 86_400_000) : null);
const emailFor = (key) => `${club.slug}-rt-${key}@example.test`;

// The population definitions, once in SQL (lib/member-population.ts: TRAINING = accountType <> 'parent').
const POP_SQL = `select
  count(*) filter (where "accountType" <> 'parent')::int as training,
  count(*) filter (where "accountType" <> 'parent' and status = 'active')::int as active,
  count(*) filter (where "accountType" <> 'parent' and status <> 'cancelled')::int as current,
  count(*) filter (where "accountType" <> 'parent' and status = 'cancelled')::int as "left",
  count(*) filter (where "accountType" <> 'parent' and status = 'inactive')::int as inactive,
  count(*) filter (where "accountType" <> 'parent' and status = 'taster')::int as taster,
  count(*) filter (where "accountType" <> 'parent' and status = 'cancelled' and "cancelledAt" >= $2)::int as "cancelledThisMonth",
  count(*) filter (where "accountType" <> 'parent' and "joinedAt" >= $2)::int as joined,
  count(*) filter (where "accountType" <> 'parent' and status = 'active' and "paymentStatus" = 'paused')::int as "activeOnHold",
  count(*) filter (where "accountType" <> 'parent' and status <> 'cancelled' and "paymentStatus" = 'paused')::int as "currentOnHold",
  count(*) filter (where "accountType" = 'parent' and status <> 'cancelled')::int as guardians,
  count(*) filter (where "accountType" <> 'parent' and "joinedAt" < $3)::int as cohort,
  count(*) filter (where "accountType" <> 'parent' and status = 'active' and "joinedAt" < $3)::int as survived
from "Member" where "tenantId" = $1`;
// The columns are TIMESTAMP(3) WITHOUT TIME ZONE holding UTC (Prisma's convention). A JS Date sent through pg is
// serialised in local time with an offset that Postgres then ignores, so every instant goes as an ISO "Z" string.
const iso = (d) => d.toISOString();
const population = async () => (await q(POP_SQL, [tenantId, iso(monthStart), iso(sixMonthsAgo)]))[0];

// The same definitions as JS predicates, to add the seed's contribution to the baseline.
const training = (r) => r.type !== "parent";
const seedDelta = {
  training: SEED.filter(training).length,
  active: SEED.filter((r) => training(r) && r.status === "active").length,
  current: SEED.filter((r) => training(r) && r.status !== "cancelled").length,
  left: SEED.filter((r) => training(r) && r.status === "cancelled").length,
  inactive: SEED.filter((r) => training(r) && r.status === "inactive").length,
  taster: SEED.filter((r) => training(r) && r.status === "taster").length,
  cancelledThisMonth: SEED.filter((r) => training(r) && r.status === "cancelled" && r.cancelled >= monthStart).length,
  joined: SEED.filter((r) => training(r) && r.joined >= monthStart).length,
  activeOnHold: SEED.filter((r) => training(r) && r.status === "active" && r.pay === "paused").length,
  currentOnHold: SEED.filter((r) => training(r) && r.status !== "cancelled" && r.pay === "paused").length,
  guardians: SEED.filter((r) => !training(r) && r.status !== "cancelled").length,
  cohort: SEED.filter((r) => training(r) && r.joined < sixMonthsAgo).length,
  survived: SEED.filter((r) => training(r) && r.status === "active" && r.joined < sixMonthsAgo).length,
};

// The journey's payments first (Payment.memberId is ON DELETE SET NULL, so they would outlive their members), then
// children (kids rows point at their guardian), then the journey's own plan.
await q(`delete from "Payment" where "tenantId" = $1 and description = $2`, [tenantId, PAYMENT_TAG]);
await q(`delete from "Member" where "tenantId" = $1 and email like $2 and "parentMemberId" is not null`, [tenantId, `${club.slug}-rt-%@example.test`]);
await q(`delete from "Member" where "tenantId" = $1 and email like $2`, [tenantId, `${club.slug}-rt-%@example.test`]);
await q(`delete from "MembershipTier" where "tenantId" = $1 and name = $2`, [tenantId, "RT Plan"]);
const tierId = randomUUID();
await q(`insert into "MembershipTier" (id, "tenantId", name, "pricePence", "billingCycle", "updatedAt") values ($1, $2, 'RT Plan', 5000, 'monthly', now())`, [tierId, tenantId]);
const baseline = await population();
L.note("seed", "N1 fixture baseline before seeding (Member 1, Member 2 and anything earlier journeys left)", baseline);
// D11 baseline: the training members already in the club (the journey's own rows are gone; their events cascaded).
// Epoch milliseconds, because node-pg reads TIMESTAMP WITHOUT TIME ZONE as local time.
const baselineRows = await q(
  `select status, (extract(epoch from "joinedAt") * 1000)::float8 as joined, (extract(epoch from "cancelledAt") * 1000)::float8 as cancelled
     from "Member" where "tenantId" = $1 and "accountType" <> 'parent'`, [tenantId]);
const baselineHistory = (await q(
  `select (select count(*)::int from "MemberStatusEvent" e join "Member" m on m.id = e."memberId"
            where e."tenantId" = $1 and m."tenantId" = $1 and m."accountType" <> 'parent') as events,
          (select count(*)::int from "ImportedMembership" where "tenantId" = $1 and "memberId" is not null) as ledger`, [tenantId]))[0];
L.check("seed", "S3 the baseline members have no status events or import ledger rows, so their movement follows from join and cancellation dates alone",
  baselineHistory.events === 0 && baselineHistory.ledger === 0, baselineHistory);
const seededIds = {};
for (const r of SEED) {
  seededIds[r.key] = randomUUID();
  await q(
    `insert into "Member" (id, "tenantId", email, name, status, "paymentStatus", "holdPriorStatus", "accountType", "joinedAt", "cancelledAt",
                           "nextDueAt", "billedBy", "membershipTierId", "membershipType", "parentMemberId", "updatedAt")
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())`,
    [seededIds[r.key], tenantId, emailFor(r.key), r.name, r.status, r.pay, r.hold ?? null, r.type, iso(r.joined), r.cancelled ? iso(r.cancelled) : null,
      r.dueDays !== undefined ? iso(dueAtOf(r)) : null, r.billedBy ?? "matflow",
      r.plan ? tierId : null, r.plan ? "RT Plan" : null, r.parent ? seededIds[r.parent] : null],
  );
  for (const p of r.payments ?? []) {
    await q(
      `insert into "Payment" (id, "tenantId", "memberId", "amountPence", status, description, "paidAt", "failureReason", "createdAt")
       values ($1, $2, $3, $4, $5, $6, $7, null, $8)`,
      [randomUUID(), tenantId, seededIds[r.key], p.amount, p.status, PAYMENT_TAG, p.status === "succeeded" ? iso(p.at) : null, iso(p.at)],
    );
  }
  for (const e of eventsOf(r)) {
    await q(
      `insert into "MemberStatusEvent" (id, "tenantId", "memberId", "fromStatus", "toStatus", reason, "changedById", "occurredAt")
       values ($1, $2, $3, $4, $5, 'staff_edit', $6, $7)`,
      [randomUUID(), tenantId, seededIds[r.key], e.from, e.to, club.owner.id, iso(e.at)],
    );
  }
}
const seededAt = new Date();

// ── D11: the expected movement, computed independently ─────────────────────
// A training member with no events and no ledger rows (lib/membership-report.ts joinDateHistory + the reconciliation
// in lib/membership-movement.ts): active → New at joinedAt; cancelled with a cancellation date → New at joinedAt and
// Left at max(cancelledAt, joinedAt + 1 ms); inactive, taster or cancelled without a date → nothing (the
// reconciliation at "now" is a correction, never a join, a loss or a taster added).
// A loss rebuilt from a cancellation date is a cancellation (`cancel`), never a finished course.
const noEventMoves = (status, joined, cancelled) => {
  if (status === "active") return [{ kind: "new", at: joined }];
  if (status === "cancelled" && cancelled != null) return [{ kind: "new", at: joined }, { kind: "lost", at: Math.max(cancelled, joined + 1), cancel: true }];
  return [];
};
const moveWindows = { thisMonth: [monthStart.getTime(), Infinity], lastMonth: [lastMonthStart.getTime(), monthStart.getTime() - 1] };
// Churn (owner decision, 27 Oct 2026; lib/membership-movement.ts cancellationsOf): the cancellations in the window,
// as moves, joiners included — `cancelled` below. A finished prepaid course would be Left without `cancel`.
const tallyMoves = (moves, [from, to]) => {
  const t = { new: 0, rejoined: 0, tasterAdded: 0, lost: 0, cancelled: 0 };
  for (const m of moves) {
    if (m.at < from || m.at > to) continue;
    t[m.kind] += 1;
    if (m.cancel) t.cancelled += 1;
  }
  return { ...t, joined: t.new + t.rejoined, net: t.new + t.rejoined - t.lost };
};
const allMoves = [
  ...baselineRows.flatMap((r) => noEventMoves(r.status, r.joined, r.cancelled)),
  ...SEED.filter(training).flatMap((r) => (eventsOf(r).length
    ? eventsOf(r).filter((e) => e.move).map((e) => ({ kind: e.move, at: e.at.getTime(), cancel: e.move === "lost" && e.to === "cancelled" }))
    : noEventMoves(r.status, r.joined.getTime(), r.cancelled ? r.cancelled.getTime() : null))),
];
const MV = tallyMoves(allMoves, moveWindows.thisMonth);
const MVLast = tallyMoves(allMoves, moveWindows.lastMonth);
const E = await population();
const planned = Object.fromEntries(Object.keys(seedDelta).map((k) => [k, baseline[k] + seedDelta[k]]));
L.check("seed", "S1 the database population after seeding is the baseline plus the planned seed, definition by definition",
  Object.keys(planned).every((k) => planned[k] === E[k]), { planned, observed: E });

// Payment recovery inputs (lib/reports.ts: distinct members with a failed payment in the period — by default this
// club month, 26 Oct 2026; it was the last 90 days before the period selector — recovered = now paid).
const rec = (await q(
  `select count(distinct p."memberId")::int as failed,
          count(distinct p."memberId") filter (where m."paymentStatus" = 'paid')::int as recovered
     from "Payment" p left join "Member" m on m.id = p."memberId"
    where p."tenantId" = $1 and p.status = 'failed' and p."createdAt" >= $2 and p."memberId" is not null`,
  [tenantId, monthStart.toISOString()],
))[0];

// ── Expected strings, in the source's exact formats ─────────────────────────
// components/dashboard/reports-primitives.tsx formatNumber / formatPct / formatRatio / formatSigned; lib/reports.ts ratePct1dp / percent.
const fmtNum = (n) => n.toLocaleString("en-GB");
const pct1 = (n, b) => (b > 0 ? Math.round((n / b) * 1000) / 10 : null);
const whole = (n, b) => (b > 0 ? Math.round((n / b) * 100) : null);
const fmtPct = (p, b) => (b <= 0 || p === null || !Number.isFinite(p) ? "—" : `${p.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`);
const fmtRatio = (p, n, b) => (fmtPct(p, b) === "—" ? "—" : `${fmtPct(p, b)} (${fmtNum(n)} of ${fmtNum(b)})`);
const signed = (n) => (n > 0 ? `+${fmtNum(n)}` : n < 0 ? `−${fmtNum(Math.abs(n))}` : "0");
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

const ACTIVE_EXCLUDES = "Excludes inactive members, tasters, cancelled members and guardians"; // POPULATION_COPY.active.excludes
// D11 strings (sean/batch-c-headcount 7d5a47ce).
const JOINED_LABEL = "Joined this month (new + rejoined)"; // lib/membership-movement.ts:150 MEMBERSHIP_COPY.joinedLabel
const MOVEMENT_DEFINITION = "New: first ever start. Rejoined: started again after leaving. Joined = new + rejoined. Left: cancelled, or finished a prepaid course. Net = new + rejoined − left. Tasters added are counted apart, and imports are never joins."; // lib/membership-movement.ts:147-148
// ReportsView.tsx:491-496 (label, value, filter) and MembersList.tsx:646-657 (drill headline label).
const JOINED_LINES = [
  { filter: "new-this-month", label: "New", value: MV.new, headline: "new this month" },
  { filter: "rejoined-this-month", label: "Rejoined", value: MV.rejoined, headline: "rejoined this month" },
  { filter: "tasters-this-month", label: "Tasters added", value: MV.tasterAdded, headline: "tasters added this month" },
  { filter: "lost-this-month", label: "Left", value: MV.lost, headline: "left this month" },
];
// Churn (owner decision, 27 Oct 2026): ReportsView.tsx CHURN_TITLE, CHURN_COUNTED and churnValueText.
const CHURN_TITLE = "Churn";
const CHURN_COUNTED = "Every cancellation in the period, including people who joined during it. Finished prepaid courses are not churn (they are in Left). Club-wide";
const churnText = (n, during) => `${fmtNum(n)} ${n === 1 ? "cancellation" : "cancellations"} ${during}`;
const X = {
  membersHeadline: `${E.active} active members${E.activeOnHold > 0 ? `, ${E.activeOnHold} on hold` : ""}`,
  membersScope: `Active training members, including any on hold. ${ACTIVE_EXCLUDES}.`,
  membersTile: [String(E.active), "Active members", ...(E.activeOnHold > 0 ? [`Includes ${E.activeOnHold} on hold`] : []), ACTIVE_EXCLUDES],
  // W3 (owner decision, 27 Oct 2026, 23:30): each count that is a share of a
  // named population carries its percentage (lib/percent shareOf, half-up).
  activeDetail: [
    `Includes ${fmtNum(E.activeOnHold)} on hold`,
    E.active > 0 ? `${Math.round((E.activeOnHold * 100) / E.active)}% of ${fmtNum(E.active)} active` : null,
    E.current > 0 ? `${Math.round((E.active * 100) / E.current)}% of ${fmtNum(E.current)} current members` : `${fmtNum(E.current)} current members`,
    ACTIVE_EXCLUDES,
  ].filter(Boolean).join(" · "),
  // The count of cancellations this month, joiners included: the tile's value line and its link name.
  churn: churnText(MV.cancelled, "this month"),
  joinedValue: fmtNum(MV.joined),                                                                  // ReportsView.tsx:505
  joinedNet: `Net ${signed(MV.net)} this month (new + rejoined − left)`,                            // ReportsView.tsx:524-526
  // ReportsView.tsx:228-230 joinedTileDetail + :384 CSV row.
  joinedCsvDetail: `New ${fmtNum(MV.new)} · Rejoined ${fmtNum(MV.rejoined)} · Tasters added ${fmtNum(MV.tasterAdded)} · Left ${fmtNum(MV.lost)} · Net ${signed(MV.net)} · ${MOVEMENT_DEFINITION}`,
  survival: fmtRatio(pct1(E.survived, E.cohort), E.survived, E.cohort),
  recovery: fmtRatio(pct1(rec.recovered, rec.failed), rec.recovered, rec.failed),
  activeShare: fmtRatio(whole(E.active, E.current), E.active, E.current),
  status: {
    Active: fmtRatio(whole(E.active, E.current), E.active, E.current),
    Inactive: fmtRatio(whole(E.inactive, E.current), E.inactive, E.current),
    Taster: fmtRatio(whole(E.taster, E.current), E.taster, E.current),
  },
  left: `Left the club: ${fmtNum(E.left)} · cancelled members, not part of the shares above`,
};
L.note("seed", "N2 expected figures", { E, cancellations: MV.cancelled, recovery: rec, movement: { thisMonth: MV, lastMonth: MVLast }, X: { churn: X.churn, survival: X.survival, recovery: X.recovery, activeShare: X.activeShare, headline: X.membersHeadline } });

// ── Round 3: payers, the club month, the CSV period ─────────────────────────
// lib/overdue.ts overduePayerWhere / noPaymentYetPayerWhere, once in SQL: payers are active and taster rows of ANY
// account type; overdue = Stripe/TeamUp flag OR a passed due date (not free/paused/cancelled, no subscription, not
// TeamUp-billed), minus "No payment yet" (pending, on a plan, not TeamUp-billed).
const CHASE = `status in ('active', 'taster')`;
const NPY = `("paymentStatus" = 'pending' and "membershipTierId" is not null and "billedBy" <> 'teamup')`;
const OVERDUE = `("paymentStatus" = 'overdue' or ("nextDueAt" < $2::timestamp and "paymentStatus" not in ('free', 'paused', 'cancelled') and "stripeSubscriptionId" is null and "billedBy" <> 'teamup'))`;
const P = (await q(`select
  count(*) filter (where ${CHASE} and ${OVERDUE} and not ${NPY})::int as overdue,
  count(*) filter (where ${CHASE} and ${OVERDUE} and not ${NPY} and "accountType" = 'parent')::int as "overdueGuardians",
  count(*) filter (where ${CHASE} and ${NPY})::int as npy,
  count(*) filter (where ${CHASE} and ${NPY} and "accountType" = 'parent')::int as "npyGuardians",
  count(*)::int as total
from "Member" where "tenantId" = $1`, [tenantId, iso(new Date())]))[0];
// The seed's own payer cases must be in those numbers (guardian overdue, TeamUp overdue, cash No payment yet).
const seededPayers = (await q(
  `select email, (${CHASE} and ${OVERDUE} and not ${NPY}) as overdue, (${CHASE} and ${NPY}) as npy from "Member" where "tenantId" = $1 and email = any($3)`,
  [tenantId, iso(new Date()), ["payer-guardian", "payer-kid", "cash-new", "teamup-overdue"].map(emailFor)],
)).reduce((o, r) => ({ ...o, [r.email.replace(`${club.slug}-rt-`, "").replace("@example.test", "")]: { overdue: r.overdue, npy: r.npy } }), {});
L.check("seed", "S2 the seeded payer cases sit where the payer rules put them (guardian and TeamUp overdue; cash No payment yet; child owes nothing)",
  seededPayers["payer-guardian"]?.overdue === true && seededPayers["teamup-overdue"]?.overdue === true && seededPayers["cash-new"]?.npy === true
    && seededPayers["cash-new"]?.overdue === false && seededPayers["payer-kid"]?.overdue === false && seededPayers["payer-kid"]?.npy === false,
  seededPayers);

// Exact strings, from the source (file:line as of HEAD of sean/batch-a-reporting-truth):
const payersLabel = (n) => `${n.toLocaleString("en-GB")} ${n === 1 ? "payer" : "payers"}`;              // lib/member-population.ts payersLabel
const payersOverdue = (n) => `${payersLabel(n)} overdue`;                                                // lib/member-population.ts payersOverdueLabel
const guardianNote = (g) => (g <= 0 ? "Includes parents and guardians who pay"                           // lib/member-population.ts payerGuardianNote
  : g === 1 ? "Includes 1 parent or guardian who pays" : `Includes ${g.toLocaleString("en-GB")} parents or guardians who pay`);
const PAYER_LABEL = "Payers overdue";                                                                     // PAYER_COPY.label
const PAYER_SCOPE = "Active members and tasters who owe the club, including parents and guardians who pay. Excludes inactive and cancelled members."; // MembersList headline-scope: `${includes}. ${excludes}.`
const owing = P.overdue + P.npy;
const Y = {
  membersTile: [String(P.overdue), PAYER_LABEL, `${guardianNote(P.overdueGuardians)}. Needs chasing`],  // MembersList.tsx tile "overdue"
  membersChip: `${PAYER_LABEL} · ${P.overdue}`,                                                             // MembersList.tsx chip "overdue"
  membersHeadline: payersOverdue(P.overdue),                                                                 // MembersList.tsx headline when filter=overdue
  reportsTile: [PAYER_LABEL, guardianNote(P.overdueGuardians)],                                              // ReportsView.tsx Payment Health link
  reportsValue: fmtNum(P.overdue),
  healthLine: `${payersOverdue(P.overdue)} · No payment yet ${P.npy}`,                                       // lib/billing.ts paymentHealthLine (shown when npy > 0)
  csvOverdue: ["Payments", PAYER_LABEL, String(P.overdue), guardianNote(P.overdueGuardians)],               // ReportsView.tsx reportsCsv
  csvNpy: ["Payments", "Payers with no payment yet", String(P.npy), guardianNote(P.npyGuardians)],
  csvPeriod: ["Report", "Period", monthLabelOf(0), `Whole months, midnight to midnight in the club's time zone (${clubZone}), to today`], // ReportsView.tsx rangeCsvDetail
  outstandingSummary: `outstanding across ${payersLabel(owing)} (failed charges, and plan prices for missed due dates and first payments)`, // OutstandingPanel.tsx
  outstandingSplit: `${payersOverdue(P.overdue)} · ${P.npy.toLocaleString("en-GB")} with no payment yet. ${guardianNote(P.overdueGuardians + P.npyGuardians)}.`, // lib/billing.ts outstandingPayerSummary + OutstandingPanel.tsx
  lastMonthHeadline: `${MVLast.new} new in ${monthLabelOf(-1)}`,                                           // MembersList.tsx:648 sliceHeadlineCopy (past month), D11 movement New
  thisMonthKey: monthKeyOf(0),
  lastMonthKey: monthKeyOf(-1),
};
L.note("seed", "N4 expected payer and month figures", { clubZone, P, Y });

// ── D9: other accounts owing, computed independently ───────────────────────
// lib/overdue.ts otherOwingEvidence: status inactive or cancelled (any account type) AND (latest settled payment —
// succeeded or failed — is a failed charge, OR paymentStatus "overdue"). A passed nextDueAt alone never counts.
// Owner instruction of 24 Oct 2026: a failed latest charge is NOT a debt. Those accounts are "Last charge failed — to
// reconcile" (RC below), even when marked overdue; "Other accounts owing" (OW) is marked overdue with a latest charge
// that did not fail. Both stay out of every payer and member total.
const owingRows = await q(
  `select m.id, m.name, m.status, m."accountType", m."paymentStatus", lp.status as "lastStatus",
          (extract(epoch from lp."createdAt") * 1000)::float8 as "lastAt", lp."amountPence", lp."failureReason"
     from "Member" m
     left join lateral (select p.status, p."createdAt", p."amountPence", p."failureReason" from "Payment" p
                         where p."memberId" = m.id and p."tenantId" = $1 and p.status in ('succeeded', 'failed')
                         order by p."createdAt" desc limit 1) lp on true
    where m."tenantId" = $1 and m.status in ('inactive', 'cancelled') and (lp.status = 'failed' or m."paymentStatus" = 'overdue')
    order by m.name`, [tenantId]);
const debtRows = owingRows.filter((r) => r.lastStatus !== "failed");
const reconcileRows = owingRows.filter((r) => r.lastStatus === "failed");
const OW = { count: debtRows.length, guardians: debtRows.filter((r) => r.accountType === "parent").length };
const RC = { count: reconcileRows.length, guardians: reconcileRows.filter((r) => r.accountType === "parent").length };
const owingIds = owingRows.map((r) => r.id);
const seededOwing = ["owe-inactive", "owe-cancelled"].map((k) => seededIds[k]);
L.check("seed", "S4 the two seeded rows are the seed's D9 accounts (the cancelled one to reconcile by its failed charge, the inactive one owing by \"overdue\")",
  seededOwing.every((id) => owingIds.includes(id))
    && owingRows.find((r) => r.id === seededIds["owe-cancelled"])?.lastStatus === "failed"
    && owingRows.find((r) => r.id === seededIds["owe-inactive"])?.lastStatus == null,
  owingRows.map((r) => ({ name: r.name, status: r.status, evidence: r.lastStatus === "failed" ? "failed_charge" : "marked_overdue" })));
// The same payer and population counts with the owing rows left out: what the totals would be if the debts were invisible.
const Pex = (await q(`select count(*) filter (where ${CHASE} and ${OVERDUE} and not ${NPY})::int as overdue
  from "Member" where "tenantId" = $1 and not (id = any($3))`, [tenantId, iso(new Date()), owingIds]))[0];
const Eex = (await q(`select
  count(*) filter (where "accountType" <> 'parent' and status = 'active')::int as active,
  count(*) filter (where "accountType" <> 'parent' and status <> 'cancelled')::int as current
  from "Member" where "tenantId" = $1 and not (id = any($2))`, [tenantId, owingIds]))[0];
const owingTrainingCurrent = owingRows.filter((r) => r.accountType !== "parent" && r.status !== "cancelled").length;
const OTHER_OWING_LABEL = "Other accounts owing";                                                         // lib/member-population.ts:93
const OTHER_OWING_SHORT = "Inactive or left, marked overdue, not chased";                               // lib/member-population.ts OTHER_OWING_COPY
const OTHER_OWING_SCOPE = "Inactive and cancelled accounts marked overdue whose latest charge did not fail, including parents and guardians. Not chased, and not counted in Payers overdue or any member total."; // via MembersList headline-scope
const RECONCILE_LABEL = "Last charge failed — to reconcile";                                              // FAILED_TO_RECONCILE_COPY
const RECONCILE_SHORT = "Inactive or left · check before treating as owed";
const RECONCILE_SCOPE = "Inactive and cancelled accounts whose latest charge failed, even if marked overdue, including parents and guardians. Not a confirmed debt: check the payment before treating it as owed. Not chased, and in no debt or member total.";
const withGuardians = (text, n) => (n <= 0 ? text : `${text} · ${n === 1 ? "includes 1 parent or guardian" : `includes ${fmtNum(n)} parents or guardians`}`); // ReportsView.tsx withGuardians
const fmtDay = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); // OutstandingPanel.tsx:270-272 (browser zone = this machine)
const fmtPence = (p) => (p == null ? "—" : `£${(p / 100).toFixed(2)}`);                                // OutstandingPanel.tsx:31-34
const Z = {
  line: `${OTHER_OWING_LABEL}: ${fmtNum(OW.count)} (inactive or left, marked overdue, not chased)`,     // lib/member-population.ts otherAccountsOwingLine
  chip: `${OTHER_OWING_LABEL} · ${OW.count}`,                                                               // MembersList.tsx:1008 + :1033
  headline: `${OW.count} ${OW.count === 1 ? "other account owing" : "other accounts owing"}`,              // MembersList.tsx:861-862
  reportsDetail: withGuardians(OTHER_OWING_SHORT, OW.guardians),                                          // ReportsView.tsx otherOwingDetail
  outstandingLine: `${OTHER_OWING_LABEL}: ${fmtNum(OW.count)} (inactive or left, marked overdue, not chased) — listed below, not in this total.`, // OutstandingPanel.tsx
  outstandingHeading: `${OTHER_OWING_LABEL} · ${fmtNum(OW.count)}`,                                         // OutstandingPanel.tsx:290-292
  outstandingRows: Object.fromEntries(debtRows.map((r) => [r.name, {                                        // OutstandingPanel.tsx OtherAccountsOwing kind="owing"
    line: `${r.status === "cancelled" ? "Cancelled" : "Inactive"}${r.accountType === "parent" ? " · Parent or guardian" : ""} · Marked overdue`,
    amount: fmtPence(null),
  }])),
};
Z.csv = ["Payments", OTHER_OWING_LABEL, String(OW.count), Z.reportsDetail];                               // ReportsView.tsx reportsCsv
// The to-reconcile group, in the words each screen uses for it.
const RZ = {
  detail: withGuardians(RECONCILE_SHORT, RC.guardians),                                                    // ReportsView.tsx failedToReconcileDetail
  line: `${RECONCILE_LABEL}: ${fmtNum(RC.count)} (inactive or left, check before treating as owed)`,       // failedToReconcileLine
  headline: `${RC.count} ${RC.count === 1 ? "account" : "accounts"} whose last charge failed — to reconcile`, // MembersList.tsx members-headline
  outstandingHeading: `${RECONCILE_LABEL} · ${fmtNum(RC.count)}`,
  outstandingRows: Object.fromEntries(reconcileRows.map((r) => [r.name, {                                   // OutstandingPanel.tsx kind="reconcile"
    line: `${r.status === "cancelled" ? "Cancelled" : "Inactive"}${r.accountType === "parent" ? " · Parent or guardian" : ""} · Last charge failed on ${fmtDay(r.lastAt)} — check before treating as owed${r.failureReason ? ` · ${r.failureReason}` : ""}`,
    amount: fmtPence(r.amountPence),
  }])),
};
RZ.csv = ["Payments", RECONCILE_LABEL, String(RC.count), RZ.detail];

// ── D10: the badge evidence, computed independently ────────────────────────
// lib/overdue.ts paymentEvidence (:297-309), paymentEvidenceSentence (:320-333), PAYMENT_EVIDENCE_LABEL (:336-340).
const dayMonth = (d, timeZone) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone });
const seedRow = (key) => SEED.find((r) => r.key === key);
const BADGES = {
  "RT Cash No Payment": { text: "No payment recorded", title: `No payment has been recorded for this membership and its first payment date (${dayMonth(dueAtOf(seedRow("cash-new")), "UTC")}) has passed.` },
  "RT Card Failed": { text: "Payment failed", title: `A payment failed on ${dayMonth(seedRow("card-failed").payments[0].at, clubZone)}.` },
  "RT Paid Before Late": { text: "Payment outstanding", title: `The payment due on ${dayMonth(dueAtOf(seedRow("paid-late")), "UTC")} is outstanding.` },
};
L.note("seed", "N5 expected D9 and D10 figures", { OW, RC, owing: debtRows.map((r) => r.name), toReconcile: reconcileRows.map((r) => r.name), Pex, Eex, Z, RZ, BADGES });

// ── Page helpers ────────────────────────────────────────────────────────────
const tileLink = (page, name) => page.getByRole("link", { name: `${name} — see the members behind this number`, exact: true });
const pTexts = async (loc) => (await loc.locator("p").allInnerTexts()).map(norm);
const noHScroll = async (page) => page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
const membersHeadline = async (page) => {
  const h = page.getByTestId("members-headline").filter({ visible: true }).first();
  await h.waitFor({ timeout: 60000 });
  return norm(await h.innerText());
};

function parseCsv(text) {
  const rows = []; let row = []; let cell = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\r") continue;
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows;
}

const browser = await chromium.launch();
try {
  // ── Desktop ───────────────────────────────────────────────────────────────
  const ctx = await context(browser, "10.95.0.1", { acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await ownerSignIn(page, club);
  L.check("journey", "J1 owner sign-in lands on the dashboard", /\/dashboard/.test(page.url()), new URL(page.url()).pathname);

  // Members page: lands on Active; headline, scope line, first tile and chip all say the active count.
  await page.goto("/dashboard/members");
  const headline = await membersHeadline(page);
  L.check("members", "MB1 Members headline gives the active count and the on-hold count inside it", headline === X.membersHeadline, { saw: headline, expected: X.membersHeadline });
  const scope = norm(await page.getByTestId("members-headline-scope").filter({ visible: true }).first().innerText());
  L.check("members", "MB2 the headline names what it counts and what it leaves out (POPULATION_COPY.active)", scope === X.membersScope, { saw: scope, expected: X.membersScope });
  const tile = await pTexts(page.getByTestId("members-tile-headline").filter({ visible: true }).first());
  L.check("members", "MB3 the first tile is the same number with the same label, hold note and exclusions", JSON.stringify(tile) === JSON.stringify(X.membersTile), { saw: tile, expected: X.membersTile });
  const chip = page.getByRole("button", { name: `Active · ${E.active}`, exact: true }).first();
  const chipPressed = await chip.getAttribute("aria-pressed", { timeout: 10000 }).catch(() => null);
  L.check("members", "MB4 the Active chip is selected on landing and carries the same count", chipPressed === "true", { chip: `Active · ${E.active}`, ariaPressed: chipPressed });
  const allChip = await page.getByRole("button", { name: `All current · ${E.current}`, exact: true }).count();
  L.check("members", "MB5 the All current chip counts current members (active, inactive, tasters; no guardians)", allChip >= 1, { expected: `All current · ${E.current}`, found: allChip });
  // D10: the Payment badge names the evidence (MembersList.tsx:244-249 paymentMeta, :343-356 testid member-payment-badge).
  for (const [i, [name, want]] of Object.entries(BADGES).entries()) {
    const badge = page.locator("tr").filter({ hasText: name }).first().getByTestId("member-payment-badge");
    const saw = await badge.waitFor({ timeout: 15000 }).then(async () => ({ text: norm(await badge.innerText()), title: await badge.getAttribute("title") }), () => null);
    L.check("members", `MB6${"abc"[i]} ${name}: the Payment badge reads "${want.text}" with the door sentence as its title`,
      saw?.text === want.text && saw?.title === want.title, { saw, expected: want });
  }
  await shot(page, "reporting-truth-members");

  // Settings overview: Active tile and the member status rows.
  await page.goto("/dashboard/settings");
  const note = page.getByTestId("settings-active-note").filter({ visible: true }).first();
  await note.waitFor({ timeout: 60000 });
  const settingsTile = await pTexts(note.locator("xpath=.."));
  const settingsTileExpected = [String(E.active), "Active members", `Includes ${E.activeOnHold} on hold · excludes guardians`];
  L.check("settings", "ST1 Settings Active members tile equals the Members headline, with its hold and guardian note",
    JSON.stringify(settingsTile) === JSON.stringify(settingsTileExpected), { saw: settingsTile, expected: settingsTileExpected });
  const statusCard = page.getByRole("heading", { name: "Member status", exact: true }).filter({ visible: true }).first().locator("xpath=..");
  const statusRows = await statusCard.evaluate((el) => Object.fromEntries(
    [...el.querySelectorAll('div[class*="grid-cols-[200px"]')].map((row) => [
      (row.querySelector("span.text-tx-2.text-sm")?.textContent ?? "").trim(),
      Number((row.querySelector("span.tabular-nums")?.textContent ?? "").trim()),
    ]),
  ));
  const statusExpected = { Active: E.active, Tasters: E.taster, Inactive: E.inactive, Cancelled: E.left, "On hold": E.currentOnHold, "Parents and guardians": E.guardians };
  L.check("settings", "ST2 Settings member status rows count training members by status; on hold and guardians apart",
    Object.entries(statusExpected).every(([k, v]) => statusRows[k] === v) && Object.keys(statusRows).length === Object.keys(statusExpected).length,
    { saw: statusRows, expected: statusExpected });
  await shot(page, "reporting-truth-settings");

  // Reports.
  await page.goto("/dashboard/reports");
  const activeLink = tileLink(page, "Active members");
  await activeLink.waitFor({ timeout: 90000 });
  L.note("reports", "N3 report freshness (60-second cache; the seed is deterministic, so a cached entry from a re-run holds the same numbers)",
    { asOf: norm(await page.getByTestId("reports-generated-at").first().innerText()), seededAt: seededAt.toISOString() });
  const activeTile = await pTexts(activeLink);
  L.check("reports", "R1 Reports Active members tile equals the Members headline and Settings, and says what it counts",
    // On screen the tile says it is a "now" figure (26 Oct 2026); the CSV row keeps the plain detail.
    activeTile[0] === fmtNum(E.active) && activeTile[1] === "Active members" && activeTile[2] === `Now · ${X.activeDetail}`,
    { saw: activeTile, expected: [fmtNum(E.active), "Active members", `Now · ${X.activeDetail}`] });

  // 24 Oct 2026: a month not wholly recorded says so on every movement figure (ReportsView.tsx estimateLabel/withEstimate).
  const apiReport = await page.request.get("/api/reports").then((r) => r.json()).catch(() => null);
  const curBasis = apiReport?.membership?.movementsByMonth?.find((m) => m.isCurrentMonth)?.basis ?? null;
  const caption = (() => {
    const src = apiReport?.membership ?? {};
    const parts = [];
    if (src.historySource && src.historySource !== "none") parts.push("your TeamUp history");
    if ((src.fromJoinDates ?? 0) > 0) parts.push("join and cancellation dates");
    return parts.length > 0 ? `Estimated from ${parts.join(" and ")}` : "Estimated";
  })();
  const wordsFor = (basis) => (basis === "mixed" ? "Partly estimated" : basis === "estimated" ? caption : null);
  const estimateWords = wordsFor(curBasis);
  const est = (d) => (estimateWords ? `${d} · ${estimateWords}` : d);
  L.note("reports", "N6 this club month's movement basis (from /api/reports) and the estimate words the churn tile and the CSV must carry", { basis: curBasis, words: estimateWords });

  // Churn (owner decision, 27 Oct 2026): "N cancellations this month" titled "Churn", what it counts, no percentage.
  const churnLink = tileLink(page, `${CHURN_TITLE}: ${X.churn}`);
  const churnTile = await pTexts(churnLink);
  const churnWant = [X.churn, CHURN_TITLE, est(CHURN_COUNTED)];
  L.check("reports", "R2 churn reads the count of cancellations this month (joiners included), titled Churn, says what it counts, and shows no percentage",
    JSON.stringify(churnTile) === JSON.stringify(churnWant) && !churnTile.join(" ").includes("%"),
    { saw: churnTile, expected: churnWant, movement: MV });
  // D11: the Joined tile (ReportsView.tsx:489-529 JoinedThisMonthTile).
  const joinedTileEl = page.getByTestId("reports-joined-tile").first();
  const joinedValue = norm(await joinedTileEl.getByTestId("reports-joined-value").innerText());
  const joinedLabel = norm(await joinedTileEl.locator("p").nth(1).innerText());
  L.check("reports", "R3 the Joined tile reads \"Joined this month (new + rejoined)\" with new + rejoined as its value",
    joinedValue === X.joinedValue && joinedLabel === JOINED_LABEL,
    { saw: { value: joinedValue, label: joinedLabel }, expected: { value: X.joinedValue, label: JOINED_LABEL, movement: MV } });
  const joinedHrefs = {};
  const lineSaw = {};
  for (const line of JOINED_LINES) {
    const link = joinedTileEl.getByTestId(`reports-joined-${line.filter}`);
    joinedHrefs[line.filter] = await link.getAttribute("href");
    lineSaw[line.filter] = { text: norm(await link.innerText()), href: joinedHrefs[line.filter] };
  }
  const lineExpected = Object.fromEntries(JOINED_LINES.map((l) => [l.filter, { text: `${l.label} ${fmtNum(l.value)}`, href: `/dashboard/members?filter=${l.filter}&month=${Y.thisMonthKey}` }]));
  L.check("reports", "R3b the four lines read New / Rejoined / Tasters added / Left with their counts, each linking to its drill-through for the club month",
    JOINED_LINES.every((l) => lineSaw[l.filter].text === lineExpected[l.filter].text && lineSaw[l.filter].href === lineExpected[l.filter].href),
    { saw: lineSaw, expected: lineExpected });
  const joinedNet = norm(await joinedTileEl.getByTestId("reports-joined-net").innerText());
  const joinedAll = norm(await joinedTileEl.innerText());
  L.check("reports", "R3c the net reads \"Net ±N this month (new + rejoined − left)\" and the old joinedAt wording is gone",
    joinedNet === X.joinedNet && !joinedAll.includes("People added in MatFlow"), { saw: joinedNet, expected: X.joinedNet });
  const next = await churnLink.evaluate((el) => el.nextElementSibling?.getAttribute("data-testid") ?? null);
  const cb = await churnLink.boundingBox(); const jb = await joinedTileEl.boundingBox();
  L.check("reports", "R4 Joined this month sits immediately beside churn (next tile, same row, to its right)",
    next === "reports-joined-tile" && cb && jb && Math.abs(cb.y - jb.y) <= 2 && jb.x >= cb.x + cb.width - 1,
    { nextTile: next, churn: cb, joined: jb });

  const recoveryTile = await pTexts(page.getByTestId("metric-card").filter({ hasText: "Payment recovery rate" }).first());
  L.check("reports", "R5 payment recovery reads x% (n of m), or — on an empty base (never 0%)", recoveryTile[0] === X.recovery, { saw: recoveryTile[0], expected: X.recovery });
  const survival = norm(await page.locator("p", { hasText: /^6-month survival: / }).first().innerText());
  L.check("reports", "R6 6-month survival reads x% (n of m)", survival === `6-month survival: ${X.survival}`, { saw: survival, expected: `6-month survival: ${X.survival}` });
  const statusCardR = page.getByTestId("left-the-club").first().locator("xpath=..");
  const shares = await statusCardR.evaluate((el) => Object.fromEntries(
    [...el.querySelectorAll("span.text-xs.font-semibold")].map((s) => [(s.previousElementSibling?.querySelector("p")?.textContent ?? "").trim(), (s.textContent ?? "").trim()]),
  ));
  L.check("reports", "R7 current members by status: every share reads x% (n of current)",
    Object.entries(X.status).every(([k, v]) => shares[k] === v), { saw: shares, expected: X.status });
  const leftText = norm(await page.getByTestId("left-the-club").first().innerText());
  L.check("reports", "R8 Left the club is a count, not a share", leftText === X.left, { saw: leftText, expected: X.left });
  const shareInsight = await page.getByText(`${X.activeShare} of current members are active`, { exact: true }).count();
  L.check("reports", "R9 owner insight: active share of current members reads x% (n of m)", shareInsight >= 1, { expected: `${X.activeShare} of current members are active`, found: shareInsight });
  const rateValue = norm(await page.getByTestId("rate-readout").locator("span").first().innerText());
  const rateCounts = await page.getByTestId("rate-readout-counts").count() ? norm(await page.getByTestId("rate-readout-counts").innerText()) : null;
  const rateMatch = rateCounts?.match(/^\(([\d,]+) check-ins ÷ ([\d,]+) members\)$/);
  L.check("reports", "R10 attendance rate: — with no counts, or its counts with the active-member base",
    rateValue === "—" ? rateCounts === null : !!rateMatch && rateMatch[2] === fmtNum(E.active), { value: rateValue, counts: rateCounts, activeBase: E.active });

  // Round 3: the payer tile, its guardian note, the health line, and the drill links carrying the club month.
  const payerLink = page.getByRole("link", { name: `${PAYER_LABEL} — see the payers behind this number`, exact: true });
  await payerLink.scrollIntoViewIfNeeded();
  const payerTexts = await pTexts(payerLink);
  const payerValue = norm(await payerLink.locator("span.tabular-nums").first().innerText());
  L.check("reports", "R11 Reports \"Payers overdue\" tile: the payer count, the label and the guardian note",
    payerValue === Y.reportsValue && JSON.stringify(payerTexts) === JSON.stringify(Y.reportsTile),
    { saw: { value: payerValue, texts: payerTexts }, expected: { value: Y.reportsValue, texts: Y.reportsTile } });
  const healthLine = await page.getByText(Y.healthLine, { exact: true }).count();
  L.check("reports", "R12 the payment health line reads \"N payers overdue · No payment yet M\" (No payment yet > 0 here)",
    P.npy > 0 && healthLine >= 1, { expected: Y.healthLine, found: healthLine });
  const joinedHref = joinedHrefs["new-this-month"];
  const churnHref = await churnLink.getAttribute("href");
  L.check("reports", "R13 the joined and churn drill-throughs carry the club month the tiles counted (month=YYYY-MM)",
    joinedHref === `/dashboard/members?filter=new-this-month&month=${Y.thisMonthKey}` && churnHref === `/dashboard/members?filter=churned-this-month&month=${Y.thisMonthKey}`,
    { joined: joinedHref, churn: churnHref, expectedMonth: Y.thisMonthKey });
  // D9: the Reports "Other accounts owing" tile (ReportsView.tsx:1442-1462), beside the payers, never inside them.
  const owTile = page.getByTestId("reports-other-owing").first();
  const owSaw = {
    label: norm(await owTile.locator("p").first().innerText()),
    detail: norm(await owTile.getByTestId("reports-other-owing-detail").innerText()),
    value: norm(await owTile.locator("span.tabular-nums").first().innerText()),
    href: await owTile.getAttribute("href"),
  };
  const owWant = { label: OTHER_OWING_LABEL, detail: Z.reportsDetail, value: fmtNum(OW.count), href: "/dashboard/members?filter=other-owing" };
  L.check("reports", "OW1 Reports \"Other accounts owing\" tile: the count of confirmed debts, \"Inactive or left, marked overdue, not chased\", and the drill-through",
    JSON.stringify(owSaw) === JSON.stringify(owWant), { saw: owSaw, expected: owWant });
  const rcTile = page.getByTestId("reports-failed-to-reconcile").filter({ visible: true }).first();
  const rcSaw = await rcTile.waitFor({ timeout: 15000 }).then(async () => ({
    label: norm(await rcTile.locator("p").first().innerText()),
    detail: norm(await rcTile.getByTestId("reports-failed-to-reconcile-detail").innerText()),
    value: norm(await rcTile.locator("span.tabular-nums").first().innerText()),
    href: await rcTile.getAttribute("href"),
  }), () => null);
  const rcWant = { label: RECONCILE_LABEL, detail: RZ.detail, value: fmtNum(RC.count), href: "/dashboard/members?filter=failed-to-reconcile" };
  L.check("reports", "RC1 Reports \"Last charge failed — to reconcile\" tile beside it: the failed-charge accounts, \"check before treating as owed\", and its drill-through (24 Oct rule)",
    JSON.stringify(rcSaw) === JSON.stringify(rcWant), { saw: rcSaw, expected: rcWant });
  await shot(page, "reporting-truth-reports");

  // CSV export: same rows, same numbers.
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.getByRole("button", { name: "Export CSV" }).click()]);
  const csvText = fs.readFileSync(await dl.path(), "utf8").replace(/^﻿/, "");
  const csv = parseCsv(csvText);
  const row = (section, metric) => csv.find((r) => r[0] === section && r[1] === metric) ?? null;
  L.check("csv", "C1 the CSV file is dated from the report and starts with Generated at",
    /^matflow-reports-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename()) && csv[1]?.[0] === "Report" && csv[1]?.[1] === "Generated at",
    { file: dl.suggestedFilename(), row2: csv[1]?.slice(0, 2) });
  const csvMembers = {
    total: row("Summary", "Total members")?.[2], current: row("Summary", "Current members")?.[2],
    active: row("Summary", "Active members")?.[2], activeDetail: row("Summary", "Active members")?.[3],
    left: row("Left the club", "Cancelled members")?.[2],
  };
  L.check("csv", "C2 CSV member counts equal the screen (total, current, active with its detail, left)",
    csvMembers.total === String(E.training) && csvMembers.current === String(E.current) && csvMembers.active === String(E.active)
      && csvMembers.activeDetail === X.activeDetail && csvMembers.left === String(E.left),
    { saw: csvMembers, expected: { total: E.training, current: E.current, active: E.active, activeDetail: X.activeDetail, left: E.left } });
  // D11: ReportsView.tsx:382-388 — the Joined row (value new + rejoined, detail the tile's lines and the definition)
  // and one row per line; the old "Joined this month" row is gone.
  const csvHealth = {
    churn: row("Health", "Churn (cancellations) this month")?.slice(2),
    joined: row("Health", JOINED_LABEL)?.slice(2), oldJoined: row("Health", "Joined this month"),
    new: row("Health", "New this month")?.slice(2), rejoined: row("Health", "Rejoined this month")?.slice(2),
    tasters: row("Health", "Tasters added this month")?.slice(2), left: row("Health", "Left this month")?.slice(2),
    recovery: row("Health", "Payment recovery")?.[2], survival: row("Health", "6-month survival")?.[2],
  };
  const csvHealthExpected = {
    churn: [String(MV.cancelled), est(CHURN_COUNTED)],
    joined: [String(MV.joined), est(X.joinedCsvDetail)], oldJoined: null,
    new: [String(MV.new), est("First ever start")], rejoined: [String(MV.rejoined), est("Started again after leaving")],
    tasters: [String(MV.tasterAdded), est("Not in Joined or Net")], left: [String(MV.lost), est("Cancelled, or finished a prepaid course")],
    recovery: X.recovery, survival: X.survival,
  };
  L.check("csv", "C3 CSV churn (the count of cancellations, what it counts, no percentage), \"Joined this month (new + rejoined)\" with its lines and definition, the New / Rejoined / Tasters added / Left rows, recovery and survival read exactly as the tiles",
    JSON.stringify(csvHealth) === JSON.stringify(csvHealthExpected), { saw: csvHealth, expected: csvHealthExpected });
  const csvShares = {
    Active: row("Current members by status", "Active")?.[3], Inactive: row("Current members by status", "Inactive")?.[3],
    Taster: row("Current members by status", "Taster")?.[3], activeShare: row("Owner insights", "Active share of current members")?.[2],
  };
  L.check("csv", "C4 CSV status shares and the active share read x% (n of m) as on screen",
    csvShares.Active === X.status.Active && csvShares.Inactive === X.status.Inactive && csvShares.Taster === X.status.Taster && csvShares.activeShare === X.activeShare,
    { saw: csvShares, expected: { ...X.status, activeShare: X.activeShare } });
  const csvPayers = { overdue: row("Payments", PAYER_LABEL), npy: row("Payments", "Payers with no payment yet") };
  L.check("csv", "C5 CSV payer rows: Payers overdue and Payers with no payment yet, each with its guardian note",
    JSON.stringify(csvPayers.overdue) === JSON.stringify(Y.csvOverdue) && JSON.stringify(csvPayers.npy) === JSON.stringify(Y.csvNpy),
    { saw: csvPayers, expected: { overdue: Y.csvOverdue, npy: Y.csvNpy } });
  const csvPeriod = row("Report", "Period");
  L.check("csv", "C6 CSV \"Period\" row names the month and the club's time zone",
    JSON.stringify(csvPeriod) === JSON.stringify(Y.csvPeriod), { saw: csvPeriod, expected: Y.csvPeriod });
  const csvOwing = row("Payments", OTHER_OWING_LABEL);
  L.check("csv", "OW2 CSV row \"Payments,Other accounts owing,N,<detail>\" as on the tile",
    JSON.stringify(csvOwing) === JSON.stringify(Z.csv), { saw: csvOwing, expected: Z.csv });
  const csvReconcile = row("Payments", RECONCILE_LABEL);
  L.check("csv", "RC2 CSV row \"Payments,Last charge failed — to reconcile,N,<detail>\" as on the tile",
    JSON.stringify(csvReconcile) === JSON.stringify(RZ.csv), { saw: csvReconcile, expected: RZ.csv });

  // Drill-through: the Active tile opens a Members page whose headline is the same number (Sean's note 2).
  await activeLink.click();
  await page.waitForURL(/\/dashboard\/members\?filter=active/, { timeout: 60000 });
  const drillActive = await membersHeadline(page);
  L.check("drill", "D1 Reports Active members tile opens Members with the same headline number", drillActive === X.membersHeadline, { saw: drillActive, expected: X.membersHeadline });
  await page.goto("/dashboard/members?filter=churned-this-month");
  const drillChurn = await membersHeadline(page);
  const churnHeadExpected = `${MV.cancelled} cancelled this month`;
  const shownOn = async (name) => (await page.getByText(name, { exact: true }).filter({ visible: true }).count()) > 0;
  const churnRows = { leftA: await shownOn("RT Left A"), leftB: await shownOn("RT Left B"), joinedLeft: await shownOn("RT Joined Left"), rejoiner: await shownOn("RT Rejoiner"), leftEarlier: await shownOn("RT Left Earlier") };
  L.check("drill", "D2 the churn drill-through reads \"N cancelled this month\" (the tile's count) and lists the cancellations, the joiner who cancelled included; not the rejoiner, not an earlier leaver",
    drillChurn === churnHeadExpected && churnRows.leftA && churnRows.leftB && churnRows.joinedLeft && !churnRows.rejoiner && !churnRows.leftEarlier,
    { saw: drillChurn, expected: churnHeadExpected, rows: churnRows });
  // D11: each Joined-tile line opens Members on exactly the members that figure counted (MembersList.tsx:646-657).
  for (const [i, line] of JOINED_LINES.entries()) {
    await page.goto(joinedHrefs[line.filter] ?? `/dashboard/members?filter=${line.filter}&month=${Y.thisMonthKey}`);
    const saw = await membersHeadline(page);
    const expected = `${line.value} ${line.headline}`;
    L.check("drill", `D3${"abcd"[i]} the ${line.label} line opens Members headed "${expected}" (movement definition; no guardian, no import)`,
      saw === expected, { saw, expected, href: joinedHrefs[line.filter] });
  }
  // Round 3: a Reports link for a month that has ended names that month (a cached report seen after the 1st).
  await page.goto(`/dashboard/members?filter=new-this-month&month=${Y.lastMonthKey}`);
  const drillLast = await membersHeadline(page);
  L.check("drill", "D4 a drill-through with month= for last month reads \"N new in <Month YYYY>\" and counts that club month's movement New",
    drillLast === Y.lastMonthHeadline, { saw: drillLast, expected: Y.lastMonthHeadline });

  // Round 3: Members "Payers overdue" — tile, chip, header and sub-line; the guardian and the TeamUp member listed,
  // the paid-up child and the never-paid member not; no truncation notice on a small club.
  await page.goto("/dashboard/members");
  await membersHeadline(page);
  const payerTile = await pTexts(page.getByTestId("members-tile-overdue").filter({ visible: true }).first());
  L.check("payers", "P1 Members \"Payers overdue\" tile: the payer count, the label and the guardian note",
    JSON.stringify(payerTile) === JSON.stringify(Y.membersTile), { saw: payerTile, expected: Y.membersTile });
  const notice = await page.getByText(/^This club has more than /).count();
  L.check("payers", "P2 no truncation notice on a club under 1,500 members (MembersList renders it only when the page was capped)",
    P.total <= 1500 && notice === 0, { members: P.total, notices: notice });
  await page.getByRole("button", { name: Y.membersChip, exact: true }).first().click();
  const payerHead = await membersHeadline(page);
  const payerScope = norm(await page.getByTestId("members-headline-scope").filter({ visible: true }).first().innerText());
  L.check("payers", "P3 the chip reads \"Payers overdue · N\" and opens a header of \"N payers overdue\" with the payer sub-line",
    payerHead === Y.membersHeadline && payerScope === PAYER_SCOPE, { head: payerHead, scope: payerScope, expected: { head: Y.membersHeadline, scope: PAYER_SCOPE } });
  const listed = async (name) => (await page.getByText(name, { exact: true }).filter({ visible: true }).count()) > 0;
  const payerRows = { guardian: await listed("RT Payer Guardian"), teamup: await listed("RT TeamUp Overdue"), kid: await listed("RT Payer Kid"), cashNew: await listed("RT Cash No Payment") };
  L.check("payers", "P4 under the chip: the guardian and the TeamUp-flagged member are listed; the paid-up child and the never-paid member are not",
    payerRows.guardian && payerRows.teamup && !payerRows.kid && !payerRows.cashNew, payerRows);
  // D9 on the payers view: the sub-line names the debts the view leaves out (MembersList.tsx:871-884).
  const owLine = page.getByTestId("members-other-owing-line").filter({ visible: true }).first();
  const owLineSaw = await owLine.waitFor({ timeout: 15000 }).then(async () => ({ text: norm(await owLine.innerText()), href: await owLine.getAttribute("href") }), () => null);
  const owNotPayers = { inactive: await listed("RT Owing Inactive"), cancelled: await listed("RT Owing Cancelled") };
  L.check("payers", "OW3 under Payers overdue: the sub-line \"Other accounts owing: N (inactive or left, marked overdue, not chased)\" links to them, and neither D9 account is listed as a payer",
    owLineSaw?.text === Z.line && owLineSaw?.href === "/dashboard/members?filter=other-owing" && !owNotPayers.inactive && !owNotPayers.cancelled,
    { saw: owLineSaw, expected: Z.line, listedAsPayers: owNotPayers });
  const rcLine = page.getByTestId("members-to-reconcile-line").filter({ visible: true }).first();
  const rcLineSaw = await rcLine.waitFor({ timeout: 15000 }).then(async () => ({ text: norm(await rcLine.innerText()), href: await rcLine.getAttribute("href") }), () => null);
  L.check("payers", "RC3 under Payers overdue: a separate sub-line \"Last charge failed — to reconcile: N (…)\" links to the failed-charge accounts",
    rcLineSaw?.text === RZ.line && rcLineSaw?.href === "/dashboard/members?filter=failed-to-reconcile", { saw: rcLineSaw, expected: RZ.line });
  await shot(page, "reporting-truth-payers");
  await owLine.click();
  const owHead = await membersHeadline(page);
  const owScope = norm(await page.getByTestId("members-headline-scope").filter({ visible: true }).first().innerText());
  const owChipPressed = await page.getByRole("button", { name: Z.chip, exact: true }).first().getAttribute("aria-pressed", { timeout: 10000 }).catch(() => null);
  const owListed = Object.fromEntries(await Promise.all([...owingRows.map((r) => r.name), "RT Inactive", "RT Left Earlier", "RT Card Failed", "RT Paid Before Late"]
    .map(async (n) => [n, await listed(n)])));
  const owRowCount = await page.locator("tbody tr").filter({ visible: true }).count();
  L.check("payers", "OW4 the sub-line opens \"N other accounts owing\" (chip \"Other accounts owing · N\" selected) listing exactly the confirmed debts, not the account to reconcile",
    owHead === Z.headline && owScope === OTHER_OWING_SCOPE && owChipPressed === "true" && owRowCount === OW.count
      && debtRows.every((r) => owListed[r.name]) && reconcileRows.every((r) => !owListed[r.name])
      && !owListed["RT Inactive"] && !owListed["RT Left Earlier"] && !owListed["RT Card Failed"] && !owListed["RT Paid Before Late"],
    { head: owHead, scope: owScope, chipPressed: owChipPressed, rows: owRowCount, listed: owListed, expected: { head: Z.headline, chip: Z.chip, rows: OW.count, scope: OTHER_OWING_SCOPE } });
  await page.goto("/dashboard/members?filter=other-owing");
  const owDrill = await membersHeadline(page);
  L.check("payers", "OW5 the Reports drill-through URL (filter=other-owing) opens the same \"N other accounts owing\"", owDrill === Z.headline, { saw: owDrill, expected: Z.headline });
  await page.goto("/dashboard/members?filter=failed-to-reconcile");
  const rcDrill = await membersHeadline(page);
  const rcScope = norm(await page.getByTestId("members-headline-scope").filter({ visible: true }).first().innerText());
  const rcListed = Object.fromEntries(await Promise.all(owingRows.map(async (r) => [r.name, await listed(r.name)])));
  L.check("payers", "RC4 filter=failed-to-reconcile opens \"N account(s) whose last charge failed — to reconcile\" with its scope, listing exactly the failed-charge accounts",
    rcDrill === RZ.headline && rcScope === RECONCILE_SCOPE && reconcileRows.every((r) => rcListed[r.name]) && debtRows.every((r) => !rcListed[r.name]),
    { saw: { head: rcDrill, scope: rcScope, listed: rcListed }, expected: { head: RZ.headline, scope: RECONCILE_SCOPE } });
  await shot(page, "reporting-truth-other-owing");
  // D9 never moves a payer or member total: the owing rows count only by their status.
  L.check("payers", "OW6 Payers overdue and Active equal the totals with the owing rows left out; Current counts the inactive one once, by its status (as before D9)",
    payerValue === fmtNum(Pex.overdue) && P.overdue === Pex.overdue && E.active === Eex.active && E.current === Eex.current + owingTrainingCurrent,
    { payersOnScreen: payerValue, payersWithout: Pex.overdue, active: [E.active, Eex.active], current: [E.current, Eex.current], owingCountedAsCurrent: owingTrainingCurrent });

  // Round 3: Payments → Outstanding says the same split in the same words.
  await page.goto("/dashboard/payments");
  const summaryEl = page.getByTestId("outstanding-summary").filter({ visible: true }).first();
  await summaryEl.waitFor({ timeout: 60000 });
  const outSummary = norm(await summaryEl.innerText());
  const outSplit = norm(await page.getByTestId("outstanding-split").filter({ visible: true }).first().innerText());
  L.check("outstanding", "O1 Outstanding summary: \"outstanding across N payers (…)\"", outSummary === Y.outstandingSummary, { saw: outSummary, expected: Y.outstandingSummary });
  L.check("outstanding", "O2 Outstanding split: \"X payers overdue · Y with no payment yet. <guardian note>.\" — the same X and Y as Reports and Members",
    outSplit === Y.outstandingSplit, { saw: outSplit, expected: Y.outstandingSplit });
  const outRows = { guardian: await listed("RT Payer Guardian"), cashNew: await listed("RT Cash No Payment"), teamup: await listed("RT TeamUp Overdue"), kid: await listed("RT Payer Kid") };
  L.check("outstanding", "O3 Outstanding lists the guardian, the never-paid member and the TeamUp member; not the paid-up child",
    outRows.guardian && outRows.cashNew && outRows.teamup && !outRows.kid, outRows);
  // D9 on Outstanding (OutstandingPanel.tsx:171-174, :281-318): a line beside the total, then a separate list with
  // no Chase button; each owing account appears once, in that list only.
  const outOwLine = norm(await page.getByTestId("outstanding-other-owing").filter({ visible: true }).first().innerText().catch(() => ""));
  const readList = async (testId, rows) => {
    const list = page.getByTestId(testId).filter({ visible: true }).first();
    return list.waitFor({ timeout: 15000 }).then(async () => ({
      heading: norm(await list.locator("h3").innerText()),
      chaseButtons: await list.getByRole("button", { name: /Chase/ }).count(),
      rows: Object.fromEntries(await Promise.all(rows.map(async (r) => {
        const rowEl = list.locator("div.flex.items-center.justify-between").filter({ hasText: r.name }).first();
        const n = await rowEl.count();
        return [r.name, n === 0 ? null : { line: norm(await rowEl.locator("p").first().innerText({ timeout: 10000 })), amount: norm(await rowEl.locator("p").nth(1).innerText({ timeout: 10000 })) }];
      }))),
    }), () => null);
  };
  const owListSaw = await readList("outstanding-other-owing-list", debtRows);
  const rcListSaw = await readList("outstanding-to-reconcile-list", reconcileRows);
  const outRcLine = norm(await page.getByTestId("outstanding-to-reconcile").filter({ visible: true }).first().innerText().catch(() => ""));
  L.check("outstanding", "RC5 Outstanding: \"Last charge failed — to reconcile: N (…) — listed below, not in this total.\", then its own list (failed date, amount, \"check before treating as owed\") with no Chase button",
    outRcLine === `${RZ.line} — listed below, not in this total.` && rcListSaw?.heading === RZ.outstandingHeading && rcListSaw?.chaseButtons === 0
      && JSON.stringify(rcListSaw?.rows) === JSON.stringify(RZ.outstandingRows),
    { line: outRcLine, list: rcListSaw, expected: { line: `${RZ.line} — listed below, not in this total.`, heading: RZ.outstandingHeading, rows: RZ.outstandingRows } });
  const owOnce = Object.fromEntries(await Promise.all(owingRows.map(async (r) => [r.name, await page.getByText(r.name, { exact: true }).filter({ visible: true }).count()])));
  L.check("outstanding", "OW7 Outstanding: \"Other accounts owing: N (…) — listed below, not in this total.\", then a separate list with each account's evidence and no Chase button",
    outOwLine === Z.outstandingLine && owListSaw?.heading === Z.outstandingHeading && owListSaw?.chaseButtons === 0
      && JSON.stringify(owListSaw?.rows) === JSON.stringify(Z.outstandingRows) && Object.values(owOnce).every((n) => n === 1),
    { line: outOwLine, list: owListSaw, appearances: owOnce, expected: { line: Z.outstandingLine, heading: Z.outstandingHeading, rows: Z.outstandingRows } });
  await shot(page, "reporting-truth-outstanding");

  // ── The statistics period (Noe, 26 Oct 2026; lib/report-period) ────────────
  // The last 3 club months, from this journey's own replay: the movement over the run, and its cancellations (churn,
  // owner decision 27 Oct 2026). Labels as lib/report-period monthsLabel writes them.
  const shortOf = (offset) => { const [y, m] = monthKeyOf(offset).split("-").map(Number); return new Date(Date.UTC(y, m - 1, 15, 12)).toLocaleString("en-GB", { month: "short", timeZone: "UTC" }); };
  const yearOf = (offset) => monthKeyOf(offset).slice(0, 4);
  const label3 = yearOf(-2) === yearOf(0) ? `${shortOf(-2)} – ${shortOf(0)} ${yearOf(0)}` : `${shortOf(-2)} ${yearOf(-2)} – ${shortOf(0)} ${yearOf(0)}`;
  const start3 = clubMonthStart(-2);
  const MV3 = tallyMoves(allMoves, [start3.getTime(), Infinity]);
  // The run's basis (combined over its months) decides the estimate words on its churn tile.
  const api3 = await page.request.get("/api/reports?period=3m").then((r) => r.json()).catch(() => null);
  const est3 = (d) => (wordsFor(api3?.periodMovement?.basis) ? `${d} · ${wordsFor(api3?.periodMovement?.basis)}` : d);
  const X3 = {
    churn: churnText(MV3.cancelled, "in the last 3 months"),
    churnDetail: est3(CHURN_COUNTED),
    newHref: `/dashboard/members?filter=new-this-month&from=${monthKeyOf(-2)}&to=${monthKeyOf(0)}`,
    lostHref: `/dashboard/members?filter=lost-this-month&from=${monthKeyOf(-2)}&to=${monthKeyOf(0)}`,
    churnHref: `/dashboard/members?filter=churned-this-month&from=${monthKeyOf(-2)}&to=${monthKeyOf(0)}`,
  };
  L.note("period", "N4 expected figures for the last 3 months", { label3, movement: MV3, basis: api3?.periodMovement?.basis ?? null, X3 });

  await page.goto("/dashboard/reports");
  const periodSelect = page.getByLabel("Reporting period");
  await periodSelect.waitFor({ timeout: 90000 });
  L.check("period", "P0 the period selector opens on This month, with From and To both this month",
    (await periodSelect.inputValue()) === "this-month" && (await page.getByLabel("Period from month").inputValue()) === monthKeyOf(0)
      && (await page.getByLabel("Period to month").inputValue()) === monthKeyOf(0),
    { period: await periodSelect.inputValue(), from: await page.getByLabel("Period from month").inputValue(), to: await page.getByLabel("Period to month").inputValue() });
  await periodSelect.selectOption("3m");
  await page.waitForURL(/period=3m/, { timeout: 60000 });
  const churn3Link = tileLink(page, `${CHURN_TITLE}: ${X3.churn}`);
  await churn3Link.waitFor({ timeout: 90000 });
  const churn3 = await pTexts(churn3Link);
  const churn3Want = [X3.churn, CHURN_TITLE, X3.churnDetail];
  L.check("period", "P1 Last 3 months: churn is every cancellation in the run (joiners included), worded for the run, with no percentage",
    JSON.stringify(churn3) === JSON.stringify(churn3Want) && !churn3.join(" ").includes("%"),
    { saw: churn3, expected: churn3Want });
  const joined3 = page.getByTestId("reports-joined-tile").first();
  const joined3Saw = {
    value: norm(await joined3.getByTestId("reports-joined-value").innerText()),
    label: norm(await joined3.locator("p").nth(1).innerText()),
    net: norm(await joined3.getByTestId("reports-joined-net").innerText()),
    newHref: await joined3.getByTestId("reports-joined-new-this-month").getAttribute("href"),
  };
  const joined3Want = {
    value: fmtNum(MV3.joined),
    label: "Joined in the last 3 months (new + rejoined)",
    net: `Net ${signed(MV3.net)} in the last 3 months (new + rejoined − left)`,
    newHref: X3.newHref,
  };
  L.check("period", "P2 the Joined tile counts the run, says so, and drills through with from/to",
    JSON.stringify(joined3Saw) === JSON.stringify(joined3Want), { saw: joined3Saw, expected: joined3Want });
  const range3 = { from: await page.getByLabel("Period from month").inputValue(), to: await page.getByLabel("Period to month").inputValue() };
  L.check("period", "P3 From and To show the run's first and last months", range3.from === monthKeyOf(-2) && range3.to === monthKeyOf(0), range3);
  L.check("period", "P4 the churn tile drills to the churned slice for the whole run", (await churn3Link.getAttribute("href")) === X3.churnHref,
    { saw: await churn3Link.getAttribute("href"), expected: X3.churnHref });
  await shot(page, "reporting-truth-period-3m");

  // The churn slice for the run: "N cancelled in <months>", N the tile's count.
  await page.goto(X3.churnHref);
  const cancelled3Headline = `${MV3.cancelled} cancelled in ${label3}`;
  const cancelled3Seen = await page.getByText(cancelled3Headline, { exact: true }).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
  L.check("period", "P4b the Members churn slice for the run reads 'N cancelled in <months>'", cancelled3Seen, { expected: cancelled3Headline });

  // The Left slice for the run lists exactly the leavers the tile counted, named by the run's months.
  await page.goto(X3.lostHref);
  const leftHeadline = `${MV3.lost} left in ${label3}`;
  const leftSeen = await page.getByText(leftHeadline, { exact: true }).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
  L.check("period", "P5 the Members Left slice for the run reads 'N left in <months>'", leftSeen, { expected: leftHeadline });

  // A custom run: editing From picks Custom months, ending this month.
  await page.goto("/dashboard/reports?period=3m");
  await page.getByLabel("Period from month").waitFor({ timeout: 90000 });
  await page.getByLabel("Period from month").selectOption(monthKeyOf(-1));
  await page.waitForURL(/period=custom/, { timeout: 60000 });
  const customUrl = new URL(page.url());
  L.check("period", "P6 editing From asks for a custom run ending this month",
    customUrl.searchParams.get("from") === monthKeyOf(-1) && customUrl.searchParams.get("to") === monthKeyOf(0) && !customUrl.searchParams.has("weeks"),
    { url: customUrl.search });
  const MV2 = tallyMoves(allMoves, [clubMonthStart(-1).getTime(), Infinity]);
  const label2 = yearOf(-1) === yearOf(0) ? `${shortOf(-1)} – ${shortOf(0)} ${yearOf(0)}` : `${shortOf(-1)} ${yearOf(-1)} – ${shortOf(0)} ${yearOf(0)}`;
  const churnCustomName = `${CHURN_TITLE}: ${churnText(MV2.cancelled, `in ${label2}`)}`;
  const churnCustom = await tileLink(page, churnCustomName).first().waitFor({ timeout: 90000 }).then(() => 1, () => 0);
  L.check("period", "P7 the custom run's churn tile names its months and counts its cancellations", churnCustom >= 1, { expected: churnCustomName, found: churnCustom });

  // Keyboard: the selector is reached by Tab and changed with the arrow keys.
  await page.goto("/dashboard/reports");
  await periodSelect.waitFor({ timeout: 90000 });
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await periodSelect.evaluate((el) => el === document.activeElement);
  }
  L.check("period", "P8 the period selector is reached with Tab", reached, { tabs: "≤ 40" });
  if (reached) {
    await page.keyboard.press("ArrowDown");
    const moved = await page.waitForURL(/period=last-month/, { timeout: 30000 }).then(() => true, () => false);
    L.check("period", "P9 the arrow key changes the period (This month → Last month)", moved, { url: page.url() });
  }

  // Analysis follows the same period.
  await page.goto("/dashboard/analysis?period=3m");
  const aSelect = page.getByLabel("Reporting period");
  await aSelect.waitFor({ timeout: 90000 });
  const aDesc = norm(await page.getByText(/ · AI report$/).first().innerText());
  L.check("period", "P10 Analysis opens on the same period and names its months",
    (await aSelect.inputValue()) === "3m" && aDesc === `${label3} (to today) · AI report`,
    { period: await aSelect.inputValue(), description: aDesc, expected: `${label3} (to today) · AI report` });
  await shot(page, "reporting-truth-analysis-3m");

  // ── Phone width (390 px), same session ─────────────────────────────────────
  const phone = await context(browser, "10.95.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

  await p2.goto("/dashboard/members");
  const mHead = await membersHeadline(p2);
  const mTile = await pTexts(p2.getByTestId("members-tile-headline").filter({ visible: true }).first());
  L.check("mobile", "M1 at 390 px the Members headline and first tile give the active count",
    mHead === X.membersHeadline && mTile[0] === String(E.active) && mTile[1] === "Active members", { headline: mHead, tile: mTile });
  const m1 = await noHScroll(p2);
  L.check("mobile", "M2 /dashboard/members at 390 px has no horizontal page scroll", m1.scroll <= m1.width + 1, m1);
  await shot(p2, "reporting-truth-mobile-members");

  await p2.goto("/dashboard/reports");
  const pActive = tileLink(p2, "Active members");
  await pActive.waitFor({ timeout: 90000 });
  const pActiveTile = await pTexts(pActive);
  L.check("mobile", "M3 at 390 px the Reports Active members tile shows the same number and detail",
    pActiveTile[0] === fmtNum(E.active) && pActiveTile[2] === `Now · ${X.activeDetail}`, { saw: pActiveTile });
  const pChurn = tileLink(p2, `${CHURN_TITLE}: ${X.churn}`); const pJoined = p2.getByTestId("reports-joined-tile").first();
  await pChurn.scrollIntoViewIfNeeded();
  const pChurnTile = await pTexts(pChurn);
  const pJoinedValue = norm(await pJoined.getByTestId("reports-joined-value").innerText());
  const pcb = await pChurn.boundingBox(); const pjb = await pJoined.boundingBox();
  const pNext = await pChurn.evaluate((el) => el.nextElementSibling?.getAttribute("data-testid") ?? null);
  L.check("mobile", "M4 at 390 px churn reads its count of cancellations and the Joined tile follows it directly (stacked, next tile)",
    pChurnTile[0] === X.churn && pJoinedValue === X.joinedValue && pNext === "reports-joined-tile"
      && pcb && pjb && pjb.y >= pcb.y + pcb.height - 1 && Math.abs(pjb.x - pcb.x) <= 2,
    { churn: pChurnTile[0], joined: pJoinedValue, nextTile: pNext, churnBox: pcb, joinedBox: pjb });
  const m2 = await noHScroll(p2);
  L.check("mobile", "M5 /dashboard/reports at 390 px has no horizontal page scroll", m2.scroll <= m2.width + 1, m2);
  const pSel = await p2.getByLabel("Reporting period").boundingBox();
  const pTo = await p2.getByLabel("Period to month").boundingBox();
  L.check("mobile", "M5b at 390 px the period selector and its month pickers sit inside the screen",
    !!pSel && !!pTo && pSel.x >= 0 && pSel.x + pSel.width <= 391 && pTo.x >= 0 && pTo.x + pTo.width <= 391, { select: pSel, to: pTo });
  await shot(p2, "reporting-truth-mobile-reports");

  await p2.goto("/dashboard/settings");
  await p2.getByTestId("settings-active-note").filter({ visible: true }).first().waitFor({ timeout: 60000 });
  const m3 = await noHScroll(p2);
  L.check("mobile", "M6 /dashboard/settings at 390 px has no horizontal page scroll", m3.scroll <= m3.width + 1, m3);

  // Round 3 at 390 px: the Members payer tile and the Outstanding split, without horizontal scroll.
  await p2.goto("/dashboard/members");
  await membersHeadline(p2);
  const pPayerTile = await pTexts(p2.getByTestId("members-tile-overdue").filter({ visible: true }).first());
  L.check("mobile", "M7 at 390 px the Members \"Payers overdue\" tile shows the payer count and guardian note",
    JSON.stringify(pPayerTile) === JSON.stringify(Y.membersTile), { saw: pPayerTile, expected: Y.membersTile });
  await p2.goto("/dashboard/payments");
  const pSplitEl = p2.getByTestId("outstanding-split").filter({ visible: true }).first();
  await pSplitEl.waitFor({ timeout: 60000 });
  const pSplit = norm(await pSplitEl.innerText());
  const m4 = await noHScroll(p2);
  L.check("mobile", "M8 at 390 px Outstanding shows the same split line, with no horizontal page scroll",
    pSplit === Y.outstandingSplit && m4.scroll <= m4.width + 1, { split: pSplit, expected: Y.outstandingSplit, ...m4 });
  await shot(p2, "reporting-truth-mobile-outstanding");

  L.check("journey", "J2 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
