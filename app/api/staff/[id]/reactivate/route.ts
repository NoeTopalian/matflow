/**
 * POST /api/staff/[id]/reactivate
 *
 * Undo a staff removal (PR 3, 6 Nov 2026). "Remove" on Settings → Staff
 * deactivates the account (app/api/staff/[id]/route.ts DELETE); this clears
 * `deactivatedAt`, so the person can sign in again with their existing
 * credentials and appears in the staff lists. Owner only, CSRF, support
 * sessions refused, audit `staff.reactivate`.
 */
import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { assertSameOrigin } from "@/lib/csrf";
import { requireApiOwner } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { refuseSupportSession } from "@/lib/support-session";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const support = refuseSupportSession(gate.session); if (support) return support;
  const { tenantId, userId } = gate;
  const { id } = await params;

  try {
    const count = await withTenantContext(tenantId, async (tx) => {
      const out = await tx.user.updateMany({
        where: { id, tenantId, role: { not: "owner" }, deactivatedAt: { not: null } },
        data: { deactivatedAt: null },
      });
      if (out.count > 0) {
        const row = await tx.user.findFirst({ where: { id, tenantId }, select: { name: true, role: true } });
        await logAudit({
          tx,
          tenantId,
          userId,
          action: "staff.reactivate",
          entityType: "User",
          entityId: id,
          metadata: { name: row?.name ?? null, role: row?.role ?? null },
          req,
        });
      }
      return out.count;
    });
    if (count === 0) return NextResponse.json({ error: "This account is not deactivated" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Couldn't reactivate this account. Try again." }, { status: 500 });
  }
}
