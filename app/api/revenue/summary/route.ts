import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwnerOrManager } from "@/lib/authz";

/**
 * GET /api/revenue/summary — owner|manager.
 *
 * Returns the data the Settings → Revenue tab used to fake with DEMO_REVENUE.
 * All numbers are derived from real Payment + Member rows for the current
 * tenant. Empty tenants return zeros, not nulls — the UI treats {mrr: 0,
 * history: []} as a valid empty state.
 *
 * Shape mirrors the previous DEMO_REVENUE constant 1:1 so the UI swap is a
 * pure data-source change.
 */
export async function GET() {
  const { tenantId } = await requireOwnerOrManager();

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const baseFilter = { tenantId, status: "succeeded" as const };

  const [
    monthPayments,
    lastMonthPayments,
    sixMonthPayments,
    activeMembers,
    membershipMix,
    tiers,
    recentPayments,
  ] = await Promise.all([
    prisma.payment.findMany({
      where: { ...baseFilter, paidAt: { gte: startOfMonth } },
      select: { amountPence: true },
    }),
    prisma.payment.findMany({
      where: { ...baseFilter, paidAt: { gte: startOfLastMonth, lt: startOfMonth } },
      select: { amountPence: true },
    }),
    prisma.payment.findMany({
      where: { ...baseFilter, paidAt: { gte: sixMonthsAgo } },
      select: { amountPence: true, paidAt: true },
    }),
    prisma.member.count({ where: { tenantId, status: "active" } }),
    prisma.member.groupBy({
      by: ["membershipType"],
      where: { tenantId, status: "active", membershipType: { not: null } },
      _count: true,
    }),
    prisma.membershipTier.findMany({
      where: { tenantId, isActive: true },
      select: { name: true, pricePence: true },
    }),
    prisma.payment.findMany({
      where: { tenantId },
      select: {
        amountPence: true, status: true, createdAt: true, paidAt: true,
        member: { select: { name: true, membershipType: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 6,
    }),
  ]);

  const mrr = Math.round(monthPayments.reduce((s, p) => s + p.amountPence, 0) / 100);
  const lastMonthRevenue = Math.round(lastMonthPayments.reduce((s, p) => s + p.amountPence, 0) / 100);
  const arr = mrr * 12;
  const avgPerMember = activeMembers > 0 ? Math.round(mrr / activeMembers) : 0;
  const growthPct = lastMonthRevenue > 0 ? Math.round(((mrr - lastMonthRevenue) / lastMonthRevenue) * 100) : 0;

  // Bucket six-month payments by month-of-year, walking from sixMonthsAgo so
  // months with no revenue still show as £0 instead of being absent.
  const history: { month: string; revenue: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const total = sixMonthPayments
      .filter((p) => p.paidAt && p.paidAt >= monthStart && p.paidAt < monthEnd)
      .reduce((s, p) => s + p.amountPence, 0);
    history.push({
      month: monthStart.toLocaleString("en-GB", { month: "short" }),
      revenue: Math.round(total / 100),
    });
  }

  // Memberships: count per type, looking up price from MembershipTier when names match.
  const tierPriceByName = new Map(tiers.map((t) => [t.name, Math.round(t.pricePence / 100)]));
  const palette = ["#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#ef4444", "#06b6d4"];
  const memberships = membershipMix
    .filter((m) => !!m.membershipType)
    .map((m, i) => ({
      name: m.membershipType as string,
      price: tierPriceByName.get(m.membershipType as string) ?? 0,
      count: m._count,
      color: palette[i % palette.length],
    }));

  function ago(d: Date): string {
    const diffMs = Date.now() - d.getTime();
    const days = Math.floor(diffMs / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 7) return `${days}d ago`;
    if (days < 28) return `${Math.floor(days / 7)}w ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  const recent = recentPayments.map((p) => ({
    name: p.member?.name ?? "—",
    action: p.status === "refunded" || p.status === "failed" ? "cancelled" : "joined",
    tier: p.member?.membershipType ?? "—",
    date: ago(p.paidAt ?? p.createdAt),
  }));

  return NextResponse.json({
    mrr,
    arr,
    activeMembers,
    avgPerMember,
    growth: growthPct,
    history,
    memberships,
    recent,
  });
}
