/**
 * US-5: parent removes a photo of their own kid.
 *
 * DELETE /api/member/children/[id]/photos/[photoId]
 *
 * Composite guard at every step:
 *   - kid.parentMemberId === session.memberId
 *   - photo.memberId === kid.id
 *   - photo.tenantId === session.tenantId (RLS backstop also enforces)
 *
 * A 404 is returned for any mismatch — same opacity as cross-tenant
 * access. The MemberPhoto FK is ON DELETE CASCADE on memberId so the
 * row is also wiped if the parent later deletes the kid via
 * lib/member-delete.ts.
 */

import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; photoId: string }> },
) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const parentMemberId = session.user.memberId as string | undefined;
  if (!parentMemberId) return apiError("Not a member account", 403);
  const tenantId: string = session.user.tenantId;
  const { id: childId, photoId } = await params;

  try {
    const outcome = await withTenantContext(tenantId, async (tx) => {
      // Cheap existence check that proves both the parent-of-kid AND the
      // photo-belongs-to-this-kid invariants in one query.
      const photo = await tx.memberPhoto.findFirst({
        where: {
          id: photoId,
          tenantId,
          memberId: childId,
          member: { parentMemberId, tenantId },
        },
        select: { id: true },
      });
      if (!photo) return { kind: "not-found" } as const;

      const result = await tx.memberPhoto.deleteMany({
        where: { id: photoId, tenantId, memberId: childId },
      });
      if (result.count === 0) return { kind: "race" } as const;
      return { kind: "ok" } as const;
    });

    if (outcome.kind === "not-found") return apiError("Not found", 404);
    if (outcome.kind === "race") return apiError("Conflict — photo already removed", 409);

    await logAudit({
      tenantId,
      userId: session.user.id ?? null,
      action: "member.photo.delete",
      entityType: "MemberPhoto",
      entityId: photoId,
      metadata: { parentMemberId, childId },
      req,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError("Failed to remove photo", 500, e, "[children/[id]/photos/[photoId] DELETE]");
  }
}
