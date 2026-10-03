import type { Prisma } from "@prisma/client";
import { owesMoneyClause } from "@/lib/overdue";
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
import { atRiskMemberWhere, buildActionItems, type ActionItem } from "@/lib/dashboard-action-items";
import { TRAINING_MEMBER } from "@/lib/member-population";

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
    tx.class.count({ where: { tenantId, deletedAt: null } }),
    tx.member.count({ where: { tenantId } }),
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

async function getWeekClasses(tx: TxClient, tenantId: string): Promise<DayClass[]> {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const instances = await tx.classInstance.findMany({
    where: {
      // The week's live classes; sessions an attendance-history import created
      // (on a historical class, or with no recorded end) are history only.
      class: { tenantId, isActive: true, deletedAt: null },
      sourceImportJobId: null,
      date: { gte: monday, lte: sunday },
      isCancelled: false,
    },
    include: {
      class: true,
      _count: { select: { attendances: true } },
    },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });

  return instances.map((inst) => ({
    id: inst.id,
    name: inst.class.name,
    time: inst.startTime,
    endTime: inst.endTime ?? undefined,
    coach: inst.class.coachName ?? "TBC",
    capacity: inst.class.maxCapacity ?? null,
    enrolled: inst._count.attendances,
    location: inst.class.location ?? undefined,
    date: inst.date.toISOString().split("T")[0],
  }));
}

async function getStats(tx: TxClient, tenantId: string) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  startOfWeek.setHours(0, 0, 0, 0);

  const [
    totalActive,
    newThisMonth,
    attendanceThisWeek,
    attendanceThisMonth,
    waiverMissing,
    missingPhone,
    paymentsDue,
    atRiskMembers,
  ] = await Promise.all([
    // Training members only: parent/guardian accounts are account holders,
    // not members (lib/member-population.ts, 2 Oct 2026).
    tx.member.count({ where: { tenantId, status: "active", ...TRAINING_MEMBER } }),
    tx.member.count({ where: { tenantId, joinedAt: { gte: startOfMonth }, ...TRAINING_MEMBER } }),
    tx.attendanceRecord.count({
      where: { tenantId, checkInTime: { gte: startOfWeek } },
    }),
    tx.attendanceRecord.count({
      where: { tenantId, checkInTime: { gte: startOfMonth } },
    }),
    // A guardian/parent account never signs a training waiver and is not a
    // member to chase for a phone; both counts are training members only
    // (acceptance S1 follow-up, 2 Oct 2026: 219 guardian drafts read as 531
    // missing waivers).
    tx.member.count({
      where: { tenantId, status: { in: ["active", "taster"] }, waiverAccepted: false, ...TRAINING_MEMBER },
    }),
    tx.member.count({
      where: {
        tenantId,
        status: { in: ["active", "taster"] },
        OR: [{ phone: null }, { phone: "" }],
        ...TRAINING_MEMBER,
      },
    }),
    // Everyone Payments → Outstanding lists: overdue (derived, not only
    // Stripe-pushed) plus "No payment yet" — see lib/overdue.ts. The same clause
    // feeds the action list below, so the headline number, the list of names
    // and the Outstanding tab can never disagree.
    tx.member.count({
      where: { tenantId, status: { in: ["active", "taster"] }, OR: owesMoneyClause(new Date()) },
    }),
    // Joined inside the window and not in yet = new, not at risk (lib/dashboard-action-items).
    tx.member.count({ where: atRiskMemberWhere(tenantId, now) }),
  ]);

  return {
    totalActive,
    newThisMonth,
    attendanceThisWeek,
    attendanceThisMonth,
    waiverMissing,
    missingPhone,
    paymentsDue,
    atRiskMembers,
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
async function getActionItems(tx: TxClient, tenantId: string): Promise<ActionItem[]> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(now.getDate() - 30);

  const [overdue, recentFailed, missingWaiver, atRisk, birthdayCandidates] = await Promise.all([
    tx.member.findMany({
      where: { tenantId, status: { in: ["active", "taster"] }, OR: owesMoneyClause(now) },
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
      where: { tenantId, status: { in: ["active", "taster"] }, waiverAccepted: false, ...TRAINING_MEMBER },
      select: { id: true, name: true },
      take: 25,
    }),
    tx.member.findMany({
      where: atRiskMemberWhere(tenantId, now),
      select: { id: true, name: true },
      take: 25,
    }),
    // DOBs are filtered to the next-7-day window in JS (month/day, year-agnostic).
    tx.member.findMany({
      where: { tenantId, status: { in: ["active", "taster"] }, dateOfBirth: { not: null } },
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
    atRisk,
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
  const [classes, stats, setupGaps, userTasks, actionItems] = await withTenantContext(
    session!.user.tenantId,
    (tx) =>
      Promise.all([
        getWeekClasses(tx, session!.user.tenantId),
        getStats(tx, session!.user.tenantId),
        getSetupGaps(tx, session!.user.tenantId, session!.user.role),
        getUserTasks(tx, session!.user.tenantId, session!.user.id),
        getActionItems(tx, session!.user.tenantId),
      ]),
  );

  return (
    <div className="space-y-6">
      {denied && <DeniedNotice role={session!.user.role} />}
      <SetupBanner items={setupGaps} primaryColor={session!.user.primaryColor} />
      <DashboardStats
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
        classes={classes}
        primaryColor={session!.user.primaryColor}
        role={session!.user.role}
      />
    </div>
  );
}
