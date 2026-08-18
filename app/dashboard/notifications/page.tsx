import { requireOwnerOrManager } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import AnnouncementsView, { AnnouncementRow } from "@/components/dashboard/AnnouncementsView";

async function getAnnouncements(tenantId: string): Promise<AnnouncementRow[]> {
  const rows = await withTenantContext(tenantId, (tx) =>
    tx.announcement.findMany({
      where: { tenantId },
      orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
      take: 50,
    }),
  );
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

  // UI-RULES §7: unguarded. "No announcements yet" on a failed read invites an
  // owner to re-post something the members have already been sent.
  const announcements: AnnouncementRow[] = await getAnnouncements(session!.user.tenantId);

  return (
    <AnnouncementsView
      announcements={announcements}
      primaryColor={session!.user.primaryColor}
      role={session!.user.role}
    />
  );
}
