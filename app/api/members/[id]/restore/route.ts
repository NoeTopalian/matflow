/**
 * POST /api/members/[id]/restore
 *
 * Restore an archived member (PR 3, 6 Nov 2026). "Remove member" archives
 * (lib/member-delete.ts archiveMember); this clears `archivedAt`, so the
 * member is back in every list, count and door with every record they had.
 * Kids archived together with this parent (the cascade choice) come back with
 * them. A Stripe subscription cancelled by the removal is not restarted: the
 * owner sets billing up again, as for any returning member.
 *
 * Owner + manager (the same roles that can end a hold or edit a member's
 * plan), CSRF, support sessions refused, audit `member.restore`.
 */
import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { assertSameOrigin } from "@/lib/csrf";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { refuseSupportSession } from "@/lib/support-session";
import { restoreMember } from "@/lib/member-delete";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const support = refuseSupportSession(gate.session); if (support) return support;
  const { tenantId, userId } = gate;
  const { id } = await params;

  try {
    const outcome = await withTenantContext(tenantId, async (tx) => {
      const o = await restoreMember(tx, { id, tenantId });
      if (o.kind === "ok") {
        await logAudit({
          tx,
          tenantId,
          userId,
          action: "member.restore",
          entityType: "Member",
          entityId: id,
          metadata: { name: o.name, restoredKidIds: o.restoredKidIds, subscriptionEnding: o.subscriptionEnding },
          req,
        });
      }
      return o;
    });
    if (outcome.kind === "not-found") {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }
    if (outcome.kind === "already-current") {
      return NextResponse.json({ success: true, alreadyCurrent: true, restoredKids: 0, subscriptionEnding: false });
    }
    if (outcome.kind === "erased") {
      return NextResponse.json({ error: "This member's personal data was erased on request, so there is nothing to restore." }, { status: 409 });
    }
    if (outcome.kind === "parent-archived") {
      return NextResponse.json({ error: `${outcome.parentName}, their parent, is archived. Restore the parent first, or link this child to another parent.` }, { status: 409 });
    }
    if (outcome.kind === "race") {
      return NextResponse.json({ error: "This member was changed by someone else. Reload and try again." }, { status: 409 });
    }
    return NextResponse.json({ success: true, restoredKids: outcome.restoredKidIds.length, subscriptionEnding: outcome.subscriptionEnding });
  } catch {
    return NextResponse.json({ error: "Couldn't restore this member. Try again." }, { status: 500 });
  }
}
