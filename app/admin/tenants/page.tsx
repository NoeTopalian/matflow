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
import { ACTIVE_MEMBER } from "@/lib/member-population";

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
  /** Every member row the club has, as main exported it: all statuses and account types. */
  memberCount: number;
  /** The club's own "Active members" number (ACTIVE_MEMBER): active training members, guardians excluded. */
  activeMemberCount: number;
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
    // The club's own "Active members" number (T1, Q4 A-1), beside the all-rows count.
    const activeByTenant = new Map(
      (
        await tx.member.groupBy({
          by: ["tenantId"],
          where: { tenantId: { in: tenants.map((t) => t.id) }, ...ACTIVE_MEMBER },
          _count: { _all: true },
        })
      ).map((g) => [g.tenantId, g._count._all]),
    );
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
        activeMemberCount: activeByTenant.get(t.id) ?? 0,
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

type Params = { view?: string | string[]; q?: string | string[]; status?: string | string[]; stripe?: string | string[] };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function AdminTenantsPage({ searchParams }: { searchParams?: Promise<Params> }) {
  if (!(await isAdminPageAuthed())) redirect("/admin/login");

  const sp = (await searchParams) ?? {};
  const view: TenantView = first(sp.view) === "closed" ? "closed" : "open";
  const { rows, openCount, closedCount } = await getTenants(view);
  // Keyed on the URL's view and filters as the server saw them, so navigating
  // to a different server-rendered URL remounts the list; the list itself
  // reads its filters from the browser's URL (see TenantsList).
  return (
    <TenantsList
      key={`${view}|${first(sp.q)}|${first(sp.status)}|${first(sp.stripe)}`}
      tenants={rows}
      view={view}
      openCount={openCount}
      closedCount={closedCount}
    />
  );
}
