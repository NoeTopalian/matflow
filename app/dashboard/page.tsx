import type { Prisma } from "@prisma/client";
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
      select: { stripeConnected: true, onboardingCompleted: true },
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
      class: { tenantId },
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
  const fourteenDaysAgo = new Date(now);
  fourteenDaysAgo.setDate(now.getDate() - 14);

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
    tx.member.count({ where: { tenantId, status: "active" } }),
    tx.member.count({ where: { tenantId, joinedAt: { gte: startOfMonth } } }),
    tx.attendanceRecord.count({
      where: { tenantId, checkInTime: { gte: startOfWeek } },
    }),
    tx.attendanceRecord.count({
      where: { tenantId, checkInTime: { gte: startOfMonth } },
    }),
    tx.member.count({
      where: { tenantId, status: { in: ["active", "taster"] }, waiverAccepted: false },
    }),
    tx.member.count({
      where: {
        tenantId,
        status: { in: ["active", "taster"] },
        OR: [{ phone: null }, { phone: "" }],
      },
    }),
    tx.member.count({
      where: { tenantId, status: { in: ["active", "taster"] }, paymentStatus: "overdue" },
    }),
    tx.member.count({
      where: {
        tenantId,
        status: "active",
        attendances: { none: { checkInTime: { gte: fourteenDaysAgo } } },
      },
    }),
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

export default async function DashboardPage() {
  const { session } = await requireStaff();

  // UI-RULES §7: a DB failure is NOT an empty gym. This load is deliberately
  // unguarded — a throw propagates to app/dashboard/error.tsx, which renders
  // ErrorState with retry and the log-searchable reference. The try/catch that
  // used to sit here turned an outage into "0 members, £0 revenue", which
  // reads as a dead gym rather than a broken page. instrumentation.ts's
  // onRequestError still logs and Sentry-reports the failure, so catching here
  // bought nothing but the lie.
  //
  // One shared transaction for all four reads — avoids the connection-pool
  // contention that caused "Unable to start a transaction in the given time".
  const [classes, stats, setupGaps, userTasks] = await withTenantContext(
    session!.user.tenantId,
    (tx) =>
      Promise.all([
        getWeekClasses(tx, session!.user.tenantId),
        getStats(tx, session!.user.tenantId),
        getSetupGaps(tx, session!.user.tenantId, session!.user.role),
        getUserTasks(tx, session!.user.tenantId, session!.user.id),
      ]),
  );

  return (
    <div className="space-y-6">
      <SetupBanner items={setupGaps} primaryColor={session!.user.primaryColor} />
      <DashboardStats
        stats={stats}
        classes={classes}
        tenantName={session!.user.tenantName}
        primaryColor={session!.user.primaryColor}
        userName={session!.user.name ?? undefined}
        userTasks={userTasks}
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
