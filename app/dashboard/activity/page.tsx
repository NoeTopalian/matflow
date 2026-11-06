import { Suspense } from "react";
import { requireOwnerOrManager } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { ActivityTimeline } from "@/components/activity/ActivityTimeline";
import type { ActivityRole } from "@/lib/activity-types";

/**
 * Activity (5 Nov 2026): what has happened in the club, newest first, as
 * sentences whose people and subjects are links, with Undo for the owner.
 *
 * Owner and managers. A manager sees club life only — the restriction is
 * enforced by GET /api/activity, not by this page — and never Undo. Coaches
 * are sent back to the dashboard.
 *
 * The page loads only what the filter controls list (staff and plans); the
 * timeline fetches itself. UI-RULES §7: no try/catch — a load failure reaches
 * app/dashboard/error.tsx.
 */
export default async function ActivityPage() {
  const { tenantId, userId, role } = await requireOwnerOrManager();
  const { staff, tiers } = await withTenantContext(tenantId, async (tx) => ({
    staff: await tx.user.findMany({ where: { tenantId }, select: { id: true, name: true, role: true }, orderBy: [{ role: "asc" }, { name: "asc" }] }),
    tiers: await tx.membershipTier.findMany({ where: { tenantId }, select: { id: true, name: true, isActive: true }, orderBy: { name: "asc" } }),
  }));
  return (
    // The timeline reads its filters from the address bar (useSearchParams).
    <Suspense fallback={null}>
      <ActivityTimeline variant="page" role={role as ActivityRole} viewerId={userId} staff={staff} tiers={tiers} />
    </Suspense>
  );
}
