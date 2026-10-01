import { requireOwner } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import ActivityLog from "@/components/dashboard/ActivityLog";

/**
 * Owner Activity page (1 Oct 2026): every action every staff member took,
 * with Undo where the audit row can put the entity back. Owner only — this is
 * the one surface that sees every staff member's work and reverses it.
 *
 * UI-RULES §7: no try/catch — a load failure reaches app/dashboard/error.tsx.
 */
export default async function ActivityPage() {
  const { tenantId } = await requireOwner();
  const staff = await withTenantContext(tenantId, (tx) =>
    tx.user.findMany({ where: { tenantId }, select: { id: true, name: true, role: true }, orderBy: [{ role: "asc" }, { name: "asc" }] }),
  );
  return <ActivityLog initialStaff={staff} />;
}
