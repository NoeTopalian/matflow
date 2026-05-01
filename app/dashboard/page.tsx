import { requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import WeeklyCalendar, { DayClass } from "@/components/dashboard/WeeklyCalendar";
import DashboardStats from "@/components/dashboard/DashboardStats";
import SetupBanner from "@/components/dashboard/SetupBanner";

/**
 * Wizard v2 SetupBanner support: detect setup gaps for owner accounts that
 * skipped wizard steps. Returns the list of remaining items with deep links.
 * Empty array = banner hidden.
 */
async function getSetupGaps(tenantId: string, role: string): Promise<{ label: string; href: string }[]> {
  if (role !== "owner") return [];
  try {
    const [tenant, tierCount, classCount, memberCount] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { stripeConnected: true, onboardingCompleted: true },
      }),
      prisma.membershipTier.count({ where: { tenantId } }),
      prisma.class.count({ where: { tenantId, deletedAt: null } }),
      prisma.member.count({ where: { tenantId } }),
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
  } catch {
    return [];
  }
}

async function getWeekClasses(tenantId: string): Promise<DayClass[]> {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const instances = await prisma.classInstance.findMany({
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

async function getStats(tenantId: string) {
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
    prisma.member.count({ where: { tenantId, status: "active" } }),
    prisma.member.count({ where: { tenantId, joinedAt: { gte: startOfMonth } } }),
    prisma.attendanceRecord.count({
      where: { member: { tenantId }, checkInTime: { gte: startOfWeek } },
    }),
    prisma.attendanceRecord.count({
      where: { member: { tenantId }, checkInTime: { gte: startOfMonth } },
    }),
    prisma.member.count({
      where: { tenantId, status: { in: ["active", "taster"] }, waiverAccepted: false },
    }),
    prisma.member.count({
      where: {
        tenantId,
        status: { in: ["active", "taster"] },
        OR: [{ phone: null }, { phone: "" }],
      },
    }),
    prisma.member.count({
      where: { tenantId, status: { in: ["active", "taster"] }, paymentStatus: "overdue" },
    }),
    prisma.member.count({
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

export default async function DashboardPage() {
  const { session } = await requireStaff();

  let classes: DayClass[] = [];
  let stats = {
    totalActive: 0,
    newThisMonth: 0,
    attendanceThisWeek: 0,
    attendanceThisMonth: 0,
    waiverMissing: 0,
    missingPhone: 0,
    paymentsDue: 0,
    atRiskMembers: 0,
  };
  let setupGaps: { label: string; href: string }[] = [];

  try {
    [classes, stats, setupGaps] = await Promise.all([
      getWeekClasses(session!.user.tenantId),
      getStats(session!.user.tenantId),
      getSetupGaps(session!.user.tenantId, session!.user.role),
    ]);
  } catch (e) {
    console.error("[dashboard]", e);
    // Render empty state — error is logged for ops; UI degrades gracefully.
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <SetupBanner items={setupGaps} primaryColor={session!.user.primaryColor} />
      <DashboardStats
        stats={stats}
        classes={classes}
        tenantName={session!.user.tenantName}
        primaryColor={session!.user.primaryColor}
      />
      <WeeklyCalendar
        classes={classes}
        primaryColor={session!.user.primaryColor}
      />
    </div>
  );
}
