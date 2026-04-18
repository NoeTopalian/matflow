import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import QRCheckinPage from "@/components/checkin/QRCheckinPage";

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
      attendances: { select: { id: true } },
    },
    orderBy: { startTime: "asc" },
  });
}

export default async function CheckinPage({ params }: Props) {
  const { slug } = await params;

  const tenant = await prisma.tenant.findUnique({ where: { slug } }).catch(() => null);
  if (!tenant) notFound();

  let classes: Awaited<ReturnType<typeof getTodayClasses>> = [];
  try {
    classes = await getTodayClasses(tenant.id);
  } catch {
    // DB error — show empty state
  }

  const todayClasses = classes.map((inst) => ({
    id: inst.id,
    name: inst.class.name,
    coachName: inst.class.coachName,
    location: inst.class.location,
    startTime: inst.startTime,
    endTime: inst.endTime,
    maxCapacity: inst.class.maxCapacity,
    enrolled: inst.attendances.length,
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
