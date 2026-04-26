import { requireOwnerOrManager } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import AnnouncementsView, { AnnouncementRow } from "@/components/dashboard/AnnouncementsView";

async function getAnnouncements(tenantId: string): Promise<AnnouncementRow[]> {
  const rows = await prisma.announcement.findMany({
    where: { tenantId },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
    take: 50,
  });
  return rows.map((a) => ({
    id:        a.id,
    title:     a.title,
    body:      a.body,
    imageUrl:  a.imageUrl  ?? null,
    pinned:    a.pinned    ?? false,
    createdAt: a.createdAt.toISOString(),
  }));
}

export default async function NotificationsPage() {
  const { session } = await requireOwnerOrManager();

  let announcements: AnnouncementRow[] = [];
  try {
    announcements = await getAnnouncements(session!.user.tenantId);
  } catch {
    // DB not connected
  }

  return (
    <AnnouncementsView
      announcements={announcements}
      primaryColor={session!.user.primaryColor}
      role={session!.user.role}
    />
  );
}
