/**
 * An archived member's record is read-only (PR 3, 6 Nov 2026). The profile
 * hides its edit controls; this is the server-side refusal for the routes that
 * change a member (details, belt, hold, resume, photos), so a stale tab or a
 * script cannot edit someone who has been removed. Restore first. Recording a
 * payment against an archived member's debt stays allowed (the debt is real).
 *
 * Returns the 409 to send, or null when the member is current (or not found:
 * the route's own lookup answers that, as before).
 */
import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";

export const ARCHIVED_MEMBER_READ_ONLY = "This member is archived. Restore them from their profile before changing their record.";

export async function refuseArchivedMember(tenantId: string, memberId: string): Promise<NextResponse | null> {
  const row = await withTenantContext(tenantId, (tx) =>
    tx.member.findFirst({ where: { id: memberId, tenantId }, select: { archivedAt: true } }),
  );
  return row?.archivedAt ? NextResponse.json({ error: ARCHIVED_MEMBER_READ_ONLY, archived: true }, { status: 409 }) : null;
}
