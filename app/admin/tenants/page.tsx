// /admin/tenants — super-admin only. Server component fetches all tenants
// + their stats; client component renders the searchable/filterable/sortable
// list. Gated by proxy.ts admin-cookie check. Sibling to /admin/applications.
//
// Two views, chosen on the server so a view never receives the other's rows:
// open clubs (the default, deletedAt null — unchanged) and "Closed clubs"
// (?view=closed: soft-deleted through the club page's Danger zone; sign-in is
// refused and the club page offers Restore). Closure is deletedAt, separate
// from the subscription status each row still shows.

import { withRlsBypass } from "@/lib/prisma-tenant";
import { isAdminPageAuthed } from "@/lib/admin-auth";
import { redirect } from "next/navigation";
import TenantsList from "./TenantsList";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type TenantView = "open" | "closed";

export type TenantRow = {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  ownerName: string | null;
  ownerUserId: string | null;
  memberCount: number;
  status: string;
  stripeConnected: boolean;
  stripeChargesEnabled: boolean | null;
  onboardingCompleted: boolean;
  createdAt: string;
  /** When the club was closed (soft-deleted); null for an open club. */
  deletedAt: string | null;
};

async function getTenants(view: TenantView) {
  return withRlsBypass(async (tx) => {
    const [tenants, openCount, closedCount] = await Promise.all([
      tx.tenant.findMany({
        where: view === "closed" ? { deletedAt: { not: null } } : { deletedAt: null },
        select: {
          id: true,
          name: true,
          slug: true,
          subscriptionStatus: true,
          stripeConnected: true,
          stripeAccountStatus: true,
          onboardingCompleted: true,
          createdAt: true,
          deletedAt: true,
          users: {
            where: { role: "owner" },
            take: 1,
            select: { id: true, email: true, name: true },
            orderBy: { createdAt: "asc" },
          },
          _count: { select: { members: true } },
        },
        orderBy: view === "closed" ? { deletedAt: "desc" } : { createdAt: "desc" },
      }),
      tx.tenant.count({ where: { deletedAt: null } }),
      tx.tenant.count({ where: { deletedAt: { not: null } } }),
    ]);
    const rows: TenantRow[] = tenants.map((t) => {
      const status = t.stripeAccountStatus as { chargesEnabled?: boolean } | null;
      return {
        id: t.id,
        name: t.name,
        slug: t.slug,
        ownerEmail: t.users[0]?.email ?? null,
        ownerName: t.users[0]?.name ?? null,
        ownerUserId: t.users[0]?.id ?? null,
        memberCount: t._count.members,
        status: t.subscriptionStatus,
        stripeConnected: t.stripeConnected,
        stripeChargesEnabled: status?.chargesEnabled ?? null,
        onboardingCompleted: t.onboardingCompleted,
        createdAt: t.createdAt.toISOString(),
        deletedAt: t.deletedAt ? t.deletedAt.toISOString() : null,
      };
    });
    return { rows, openCount, closedCount };
  });
}

export default async function AdminTenantsPage({ searchParams }: { searchParams?: Promise<{ view?: string | string[] }> }) {
  if (!(await isAdminPageAuthed())) redirect("/admin/login");

  const view: TenantView = (await searchParams)?.view === "closed" ? "closed" : "open";
  const { rows, openCount, closedCount } = await getTenants(view);
  return <TenantsList tenants={rows} view={view} openCount={openCount} closedCount={closedCount} />;
}
