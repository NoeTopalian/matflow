// /admin/tenants — super-admin only. Server component fetches all tenants
// + their stats; client component renders the searchable/filterable/sortable
// list. Gated by proxy.ts admin-cookie check. Sibling to /admin/applications.
//
// Closed clubs (deletedAt set) are fetched too: they are kept, not deleted
// (16 Oct 2026), and the list's "Closed" filter is where an operator finds
// one to reopen. The default view leaves them out.

import { withRlsBypass } from "@/lib/prisma-tenant";
import { isAdminPageAuthed } from "@/lib/admin-auth";
import { redirect } from "next/navigation";
import TenantsList from "./TenantsList";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  /** ISO timestamp when the club was closed; null while it is open. */
  deletedAt: string | null;
};

async function getTenants(): Promise<TenantRow[]> {
  const tenants = await withRlsBypass((tx) =>
    tx.tenant.findMany({
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
      orderBy: { createdAt: "desc" },
    }),
  );
  return tenants.map((t) => {
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
}

export default async function AdminTenantsPage() {
  if (!(await isAdminPageAuthed())) redirect("/admin/login");

  const tenants = await getTenants();
  return <TenantsList tenants={tenants} />;
}
