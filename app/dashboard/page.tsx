import type { Prisma } from "@prisma/client";
import { owesMoneyClause } from "@/lib/overdue";
import { paymentsDueWhere } from "@/lib/payments-due";
import { requireStaff } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import WeeklyCalendar, { DayClass } from "@/components/dashboard/WeeklyCalendar";

// Dashboard data path runs four reads. Each used to open its own
// withTenantContext → prisma.$transaction; fired together via Promise.all they
// contended for the single pooled connection (connection_limit=1) and exceeded
// Prisma's default 2s transaction maxWait → "Unable to start a transaction in
// the given time". Folding them into ONE withTenantContext (mirroring
// lib/reports.ts + app/dashboard/attendance/page.tsx) collapses 4 transactions
// into 1. Helpers now accept the shared tx instead of opening their own.
type TxClient = Prisma.TransactionClient;
import DashboardStats from "@/components/dashboard/DashboardStats";
import SetupBanner from "@/components/dashboard/SetupBanner";
import DeniedNotice from "@/components/dashboard/DeniedNotice";
import { birthdayCandidateWhere, buildActionItems, readAtRisk, type ActionItem, type AtRiskRead } from "@/lib/dashboard-action-items";
import { ACTIVE_MEMBER, CAN_TRAIN_MEMBER, TRAINING_MEMBER } from "@/lib/member-population";
import { liveClassWhere } from "@/lib/class-live";
import { clashLabel, resolveSessionTeacher, staffCoachLabel } from "@/lib/session-coach";
import { loadCovers, sessionHasStarted } from "@/lib/session-cover";
import { loadTeacherClashes } from "@/lib/session-clash";
import { usableTimezone } from "@/lib/class-time";
import { clubDayKey, clubMonthWindow, clubWeekStart, clubWeekStartKey, shiftDayKey } from "@/lib/club-month";

/**
 * Wizard v2 SetupBanner support: detect setup gaps for owner accounts that
 * skipped wizard steps. Returns the list of remaining items with deep links.
 * Empty array = banner hidden.
 */
async function getSetupGaps(tx: TxClient, tenantId: string, role: string): Promise<{ label: string; href: string }[]> {
  if (role !== "owner") return [];
  const [tenant, tierCount, classCount, memberCount] = await Promise.all([
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { stripeConnected: true, onboardingCompleted: true, contactEmail: true, billingContactEmail: true },
    }),
    tx.membershipTier.count({ where: { tenantId } }),
    // T6b: classes ON THE TIMETABLE. A club whose classes are all paused,
    // archived or imported history has nothing scheduled, so the banner says
    // "Schedule a class".
    tx.class.count({ where: liveClassWhere(tenantId) }),
    tx.member.count({ where: { tenantId, archivedAt: null } }),
  ]);

  // Don't show the banner until the wizard has been completed at least once
  // — otherwise we'd be nudging a user who is mid-onboarding.
  if (!tenant?.onboardingCompleted) return [];

  const gaps: { label: string; href: string }[] = [];
  if (!tenant.stripeConnected) {
    gaps.push({ label: "Connect Stripe", href: "/onboarding?resume=1" });
  }
  if (tierCount === 0) {
    gaps.push({ label: "Add a membership tier", href: "/dashboard/memberships" });
  }
  if (classCount === 0) {
    gaps.push({ label: "Schedule a class", href: "/dashboard/timetable" });
  }
  if (memberCount === 0) {
    gaps.push({ label: "Add your first members", href: "/onboarding?resume=1" });
  }
  // The club's public address (1 Oct 2026): until it is set, members have no
  // one to write to and their replies to receipts go nowhere.
  if (!tenant.contactEmail && !tenant.billingContactEmail) {
    gaps.push({ label: "Add your club's contact email so members can reach you", href: "/dashboard/settings" });
  }
  return gaps;
}

async function getWeekClasses(tx: TxClient, tenantId: string, timeZone: string): Promise<DayClass[]> {
  // Round 3 (10 Nov 2026): the club's week, not the server's (UTC on
  // Vercel). A session's `date` is UTC midnight of its club day, so the
  // window is each day key ± 12 hours, as todayWindow (lib/class-time.ts).
  const mondayKey = clubWeekStartKey(new Date(), timeZone);
  const halfDay = 12 * 60 * 60 * 1000;
  const keyMidnight = (key: string) => Date.parse(`${key}T00:00:00Z`);
  const monday = new Date(keyMidnight(mondayKey) - halfDay);
  const nextMonday = new Date(keyMidnight(shiftDayKey(mondayKey, 7)) - halfDay);

  const instances = await tx.classInstance.findMany({
    where: {
      // The week's live classes; sessions an attendance-history import created
      // (on a historical class, or with no recorded end) are history only.
      class: liveClassWhere(tenantId),
      sourceImportJobId: null,
      date: { gte: monday, lt: nextMonday },
      isCancelled: false,
    },
    include: {
      // The linked staff coach, for the coach's name (lib/class-coach.ts resolveCoachName).
      class: { include: { coachUser: { select: { id: true, name: true, deactivatedAt: true } } } },
      _count: { select: { attendances: true } },
    },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });

  // Session cover: who teaches each dated session (lib/session-coach.ts, the one resolver), and one person shown on two
  // overlapping sessions where one is a cover (lib/session-clash.ts).
  const covers = await loadCovers(tx, tenantId, instances.map((i) => i.id));
  const clashes = await loadTeacherClashes(tx, tenantId, instances.map((i) => i.id), timeZone);
  const now = new Date();

  const teacher = (inst: (typeof instances)[number]) =>
    resolveSessionTeacher(inst.class, covers.get(inst.id), { started: sessionHasStarted(inst, timeZone, now), clash: clashes.get(inst.id) });

  return instances.map((inst) => ({
    id: inst.id,
    name: inst.class.name,
    time: inst.startTime,
    endTime: inst.endTime ?? undefined,
    // The covering coach ("Covered by …"), "Cover needed" while a request is open, else the staff coach linked to
    // the class, else the typed name; null when it has none of them.
    coach: staffCoachLabel(teacher(inst)),
    // The flag naming the other session the same person teaches at the same time (one of the two a cover).
    clash: clashLabel(teacher(inst)),
    capacity: inst.class.maxCapacity ?? null,
    enrolled: inst._count.attendances,
    location: inst.class.location ?? undefined,
    date: inst.date.toISOString().split("T")[0],
  }));
}

async function getStats(tx: TxClient, tenantId: string, role: string, atRisk: AtRiskRead, timeZone: string) {
  const now = new Date();
  // Round 3 (10 Nov 2026): this month and this week start at the club's
  // midnight (Tenant.timezone), as on Reports; they were the server's.
  const startOfMonth = new Date(clubMonthWindow(now, timeZone).monthStart);
  const startOfWeek = clubWeekStart(now, timeZone);

  const [
    totalActive,
    newThisMonth,
    attendanceThisWeek,
    attendanceThisMonth,
    waiverMissing,
    missingPhone,
    paymentsDue,
  ] = await Promise.all([
    // Training members only: parent/guardian accounts are account holders,
    // not members (lib/member-population.ts, 2 Oct 2026).
    tx.member.count({ where: { tenantId, ...ACTIVE_MEMBER } }),
    tx.member.count({ where: { tenantId, joinedAt: { gte: startOfMonth }, ...TRAINING_MEMBER } }),
    tx.attendanceRecord.count({
      where: { tenantId, checkInTime: { gte: startOfWeek } },
    }),
    tx.attendanceRecord.count({
      where: { tenantId, checkInTime: { gte: startOfMonth } },
    }),
    // A guardian/parent account never signs a training waiver and is not a
    // member to chase for a phone; both counts are training members only
    // (acceptance S1 follow-up, 2 Oct 2026: a real import's guardian drafts
    // were counted as missing waivers).
    tx.member.count({
      where: { tenantId, ...CAN_TRAIN_MEMBER, waiverAccepted: false },
    }),
    tx.member.count({
      where: {
        tenantId,
        ...CAN_TRAIN_MEMBER,
        OR: [{ phone: null }, { phone: "" }],
      },
    }),
    // Owner/manager: everyone Payments → Outstanding lists, overdue plus "No
    // payment yet" (lib/overdue.ts) — the same clause feeds the action list
    // below. Other roles: payers overdue only, the count of the Members chip
    // their tile links to (round-3 review L5; lib/payments-due.ts).
    tx.member.count({ where: paymentsDueWhere(tenantId, role, now) }),
  ]);

  return {
    totalActive,
    newThisMonth,
    attendanceThisWeek,
    attendanceThisMonth,
    waiverMissing,
    missingPhone,
    paymentsDue,
    // Read once by readAtRisk (lib/dashboard-action-items): 0 and suppressed
    // while the gate is closed, the same value the named list gets; the copy
    // says why there is no number yet.
    atRiskMembers: atRisk.count,
    atRiskSuppressed: atRisk.suppressed,
    atRiskCopy: atRisk.copy,
  };
}

/**
 * Open team tasks where the viewer is the assignee or the creator. Mirrors
 * GET /api/tasks but read server-side so the dashboard renders without a
 * client-fetch waterfall. Same authz invariant — tenant scope is enforced via
 * withTenantContext + an explicit where clause.
 */
async function getUserTasks(tx: TxClient, tenantId: string, userId: string) {
  const rows = await tx.task.findMany({
    where: {
      tenantId,
      status: "open",
      OR: [{ assignedToId: userId }, { createdById: userId }],
    },
    select: {
      id: true,
      title: true,
      status: true,
      createdAt: true,
      createdBy: { select: { id: true, name: true } },
      assignedTo: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/**
 * Specific, NAMED action items for the dashboard "Needs attention today" card —
 * money problems, retention risks, admin gaps, and member moments (birthdays).
 * The raw per-signal queries run here; lib/dashboard-action-items shapes + ranks
 * them into the typed list the UI renders.
 */
async function getActionItems(tx: TxClient, tenantId: string, atRisk: AtRiskRead): Promise<ActionItem[]> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(now.getDate() - 30);

  const [overdue, recentFailed, missingWaiver, birthdayCandidates] = await Promise.all([
    tx.member.findMany({
      where: { tenantId, status: { in: ["active", "taster"] }, archivedAt: null, OR: owesMoneyClause(now) },
      select: { id: true, name: true, paymentStatus: true, membershipTierId: true, billedBy: true },
      take: 25,
    }),
    tx.payment.findMany({
      where: { tenantId, status: "failed", createdAt: { gte: thirtyDaysAgo } },
      select: { memberId: true, amountPence: true, createdAt: true, member: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    tx.member.findMany({
      where: { tenantId, ...CAN_TRAIN_MEMBER, waiverAccepted: false },
      select: { id: true, name: true },
      take: 25,
    }),
    // DOBs are filtered to the next-7-day window in JS (month/day, year-agnostic).
    tx.member.findMany({
      where: birthdayCandidateWhere(tenantId),
      select: { id: true, name: true, dateOfBirth: true },
      take: 500,
    }),
  ]);

  return buildActionItems({
    now,
    overdue: overdue.map((m) => ({
      id: m.id,
      name: m.name,
      // The Outstanding list's "No payment yet" rule (lib/overdue noPaymentYetWhere).
      noPaymentYet: m.paymentStatus === "pending" && m.membershipTierId !== null && m.billedBy !== "teamup",
    })),
    recentFailed: recentFailed.map((p) => ({
      memberId: p.memberId,
      memberName: p.member?.name ?? null,
      amountPence: p.amountPence,
      createdAt: p.createdAt,
    })),
    missingWaiver,
    atRisk: atRisk.members,
    atRiskSuppressed: atRisk.suppressed,
    birthdayCandidates: birthdayCandidates
      .filter((m): m is { id: string; name: string; dateOfBirth: Date } => m.dateOfBirth !== null)
      .map((m) => ({ id: m.id, name: m.name, dateOfBirth: m.dateOfBirth })),
  });
}

export default async function DashboardPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const denied = (await searchParams)?.denied === "1";
  const { session } = await requireStaff();

  // UI-RULES §7 / RULES §2: a DB failure is NOT an empty gym. This load is
  // deliberately unguarded — a throw propagates to app/dashboard/error.tsx,
  // which renders ErrorState with retry and the log-searchable reference. The
  // try/catch that used to sit here turned an outage into "0 members, £0
  // revenue", which reads as a dead gym rather than a broken page.
  // instrumentation.ts's onRequestError still logs and Sentry-reports the
  // failure, so catching here bought nothing but the lie. main re-added the
  // catch alongside getActionItems; the read is kept, the catch is not.
  //
  // One shared transaction for all reads — avoids the connection-pool
  // contention that caused "Unable to start a transaction in the given time".
  //
  // At-Risk is read once, club-wide, and handed to both the tile and the named
  // list so they are switched off together (readAtRiskGate: shown only once
  // MatFlow has been the register for the whole 14-day window; imported
  // visits count as visits once it is).
  const [classes, stats, setupGaps, userTasks, actionItems, todayKey] = await withTenantContext(
    session!.user.tenantId,
    async (tx) => {
      const club = await tx.tenant.findUnique({ where: { id: session!.user.tenantId }, select: { timezone: true } });
      const atRisk = await readAtRisk(tx, session!.user.tenantId, new Date(), club?.timezone);
      const timeZone = usableTimezone(club?.timezone);
      return Promise.all([
        getWeekClasses(tx, session!.user.tenantId, timeZone),
        getStats(tx, session!.user.tenantId, session!.user.role, atRisk, timeZone),
        getSetupGaps(tx, session!.user.tenantId, session!.user.role),
        getUserTasks(tx, session!.user.tenantId, session!.user.id),
        getActionItems(tx, session!.user.tenantId, atRisk),
        clubDayKey(new Date(), timeZone),
      ]);
    },
  );

  return (
    <div className="space-y-6">
      {denied && <DeniedNotice role={session!.user.role} />}
      <SetupBanner items={setupGaps} primaryColor={session!.user.primaryColor} />
      <DashboardStats
        todayKey={todayKey}
        stats={stats}
        classes={classes}
        tenantName={session!.user.tenantName}
        primaryColor={session!.user.primaryColor}
        userName={session!.user.name ?? undefined}
        userTasks={userTasks}
        actionItems={actionItems}
        currentUserId={session!.user.id}
        currentUserRole={session!.user.role}
      />
      <WeeklyCalendar
        todayKey={todayKey}
        classes={classes}
        primaryColor={session!.user.primaryColor}
        role={session!.user.role}
      />
    </div>
  );
}
