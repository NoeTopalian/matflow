import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import QRCheckinPage from "@/components/checkin/QRCheckinPage";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

async function getTodayClasses(tenantId: string) {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  return prisma.classInstance.findMany({
    where: {
      class: { tenantId },
      date: { gte: startOfDay, lte: endOfDay },
      isCancelled: false,
    },
    include: {
      class: true,
      _count: { select: { attendances: true } },
    },
    orderBy: { startTime: "asc" },
  });
}

export default async function CheckinPage({ params }: Props) {
  const { slug } = await params;

  let tenant: Awaited<ReturnType<typeof prisma.tenant.findUnique>> = null;
  try {
    tenant = await prisma.tenant.findUnique({ where: { slug } });
  } catch (e) {
    console.error("[/checkin/[slug]] tenant lookup failed", { slug, error: e });
    notFound();
  }
  if (!tenant) notFound();

  let classes: Awaited<ReturnType<typeof getTodayClasses>> = [];
  try {
    classes = await getTodayClasses(tenant.id);
  } catch (e) {
    console.error("[/checkin/[slug]] today classes lookup failed", { tenantId: tenant.id, error: e });
  }

  const todayClasses = classes.map((inst) => ({
    id: inst.id,
    name: inst.class.name,
    coachName: inst.class.coachName,
    location: inst.class.location,
    startTime: inst.startTime,
    endTime: inst.endTime,
    maxCapacity: inst.class.maxCapacity,
    enrolled: inst._count.attendances,
    color: inst.class.color,
  }));

  return (
    <QRCheckinPage
      tenantSlug={slug}
      tenantName={tenant.name}
      primaryColor={tenant.primaryColor}
      logoUrl={tenant.logoUrl}
      todayClasses={todayClasses}
    />
  );
}
