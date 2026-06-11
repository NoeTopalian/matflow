// POST /api/members/[id]/promote-to-adult
// Upgrades accountType to 'adult', clears parentMemberId, updates parent's
// hasKidsHint if they have no remaining children.
// Auth: requireOwner

import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const { tenantId, userId } = await requireOwner();
  const { id: memberId } = await params;

  try {
    const result = await withTenantContext(tenantId, async (tx) => {
      const member = await tx.member.findFirst({
        where: { id: memberId, tenantId },
        select: {
          id: true,
          name: true,
          accountType: true,
          parentMemberId: true,
          dateOfBirth: true,
        },
      });
      if (!member) return { kind: "not-found" as const };
      if (!["junior", "kids"].includes(member.accountType ?? "")) {
        return { kind: "not-eligible" as const };
      }

      const oldParentId = member.parentMemberId;

      await tx.member.update({
        where: { id: memberId },
        data: { accountType: "adult", parentMemberId: null },
      });

      // Update parent's hasKidsHint if they have no more children after this
      if (oldParentId) {
        const remainingChildren = await tx.member.count({
          where: { parentMemberId: oldParentId, id: { not: memberId } },
        });
        if (remainingChildren === 0) {
          await tx.member.update({
            where: { id: oldParentId },
            data: { hasKidsHint: false },
          });
        }
      }

      return { kind: "ok" as const, member };
    });

    if (result.kind === "not-found") return apiError("Member not found", 404);
    if (result.kind === "not-eligible") {
      return apiError("Member is not a junior or kids account", 400);
    }

    await logAudit({
      tenantId,
      userId,
      action: "member.promoted_to_adult",
      entityType: "Member",
      entityId: memberId,
      metadata: { previousAccountType: result.member.accountType },
      req,
    });

    return NextResponse.json({ ok: true, memberId });
  } catch (e) {
    return apiError("Failed to promote member", 500, e, "[promote-to-adult]");
  }
}
