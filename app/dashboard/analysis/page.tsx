import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import AnalysisView from "@/components/dashboard/AnalysisView";

export const metadata = { title: "Analysis | MatFlow" };

export default async function AnalysisPage() {
  const session = await auth();
  if (!session) redirect("/login");

  const tenantId = session.user.tenantId;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

  const [
    totalMembers,
    newThisMonth,
    newLastMonth,
    checkinsThisMonth,
    checkinsLastMonth,
    activeClasses,
  ] = await Promise.all([
    prisma.member.count({ where: { tenantId, status: "active" } }),
    prisma.member.count({ where: { tenantId, joinedAt: { gte: startOfMonth } } }),
    prisma.member.count({ where: { tenantId, joinedAt: { gte: startOfLastMonth, lte: endOfLastMonth } } }),
    prisma.attendanceRecord.count({ where: { classInstance: { class: { tenantId } }, checkInTime: { gte: startOfMonth } } }),
    prisma.attendanceRecord.count({ where: { classInstance: { class: { tenantId } }, checkInTime: { gte: startOfLastMonth, lte: endOfLastMonth } } }),
    prisma.class.count({ where: { tenantId, isActive: true } }),
  ]);

  const metrics = {
    totalMembers,
    newThisMonth,
    newLastMonth,
    checkinsThisMonth,
    checkinsLastMonth,
    activeClasses,
    monthLabel: now.toLocaleString("default", { month: "long", year: "numeric" }),
    gymName: session.user.tenantName,
  };

  return <AnalysisView metrics={metrics} primaryColor={session.user.primaryColor ?? "#3b82f6"} />;
}
