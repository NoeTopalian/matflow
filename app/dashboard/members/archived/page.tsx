import Link from "next/link";
import { requireOwnerOrManager } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate } from "@/lib/date";

/**
 * Archived members (PR 3, 6 Nov 2026). "Remove member" archives: the member
 * leaves every list, count and door, and every record stays. This is the one
 * list that shows them, newest first, so the owner or a manager can open a
 * profile and Restore it. Unguarded on purpose (UI-RULES §7): a load failure
 * reaches the segment error page, never an empty list.
 */
export default async function ArchivedMembersPage() {
  const { session } = await requireOwnerOrManager();
  const tenantId = session!.user.tenantId;

  const rows = await withTenantContext(tenantId, (tx) =>
    tx.member.findMany({
      where: { tenantId, archivedAt: { not: null } },
      select: { id: true, name: true, accountType: true, archivedAt: true, archivedBy: { select: { name: true } } },
      orderBy: { archivedAt: "desc" },
      take: 500,
    }),
  );

  return (
    <>
      <PageHeader
        title="Archived members"
        description="People removed from Members. Their attendance, payments and history are kept. Open someone to restore them."
        action={
          <Link href="/dashboard/members" className="text-sm text-tx-2 underline-offset-2 hover:underline">
            Back to Members
          </Link>
        }
      />
      {rows.length === 0 ? (
        <p className="rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-6 text-sm text-tx-3">No archived members.</p>
      ) : (
        <ul aria-label="Archived members" className="divide-y divide-[var(--bd-default)] rounded-[var(--r-md)] border border-bd-default bg-sf-1">
          {rows.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-2 text-[13px]">
              <Link href={`/dashboard/members/${m.id}`} className="min-w-0 truncate font-medium text-tx-1 hover:underline">
                {m.name}
              </Link>
              <span className="shrink-0 text-tx-3">
                Removed {m.archivedAt ? formatDate(m.archivedAt) : ""}
                {m.archivedBy?.name ? ` by ${m.archivedBy.name}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
