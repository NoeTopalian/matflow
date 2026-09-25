import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { logAudit } from "@/lib/audit-log";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/csrf";

const bodySchema = z.object({
  childMemberId: z.string().min(1).max(50),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);
  if (session.user.role !== "owner") return apiError("Forbidden", 403);

  const { id: parentId } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON", 400);
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return apiError("Invalid data", 400);

  const { childMemberId } = parsed.data;
  if (parentId === childMemberId) return apiError("A member cannot be linked to themselves", 400);

  try {
    const outcome = await withTenantContext(session.user.tenantId, async (tx) => {
      const parent = await tx.member.findFirst({
        where: { id: parentId, tenantId: session.user.tenantId },
        select: { id: true, parentMemberId: true },
      });
      if (!parent) return "no-parent" as const;
      if (parent.parentMemberId !== null) return "nested" as const;

      // Club-life finding F-L6-1: a child could not be MOVED between
      // guardians — unlink refused to leave them without one, and link
      // refused anyone already linked, so the two guards deadlocked. Link
      // now moves a child who is linked elsewhere in the club (the previous
      // guardian is recorded in the audit row). A child with a login of
      // their own is still not linkable, and a child already under this
      // parent is a conflict, not a silent no-op.
      const child = await tx.member.findFirst({
        where: {
          id: childMemberId,
          tenantId: session.user.tenantId,
          passwordHash: null,
        },
        select: { id: true, parentMemberId: true },
      });
      if (!child) return "no-child" as const;
      if (child.parentMemberId === parentId) return "already" as const;
      const previousParentMemberId = child.parentMemberId;

      const updated = await tx.member.updateMany({
        where: {
          id: childMemberId,
          tenantId: session.user.tenantId,
          parentMemberId: previousParentMemberId,
          passwordHash: null,
        },
        data: { parentMemberId: parentId },
      });
      return updated.count === 1 ? { ok: true as const, previousParentMemberId } : "conflict" as const;
    });

    if (outcome === "no-parent") return apiError("Parent not found", 404);
    if (outcome === "nested") return apiError("Cannot nest sub-accounts: the chosen parent is itself a sub-account", 400);
    if (outcome === "no-child") return apiError("Child cannot be linked: must be in this tenant and have no login of their own", 404);
    if (outcome === "already") return apiError("This child is already linked to that guardian", 409);
    if (outcome === "conflict") return apiError("Link conflict — child is no longer eligible", 409);

    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "member.link.child",
      entityType: "Member",
      entityId: childMemberId,
      metadata: { parentMemberId: parentId, childMemberId, previousParentMemberId: outcome.previousParentMemberId },
      req,
    });

    return NextResponse.json({ ok: true, parentMemberId: parentId, childMemberId });
  } catch (e) {
    return apiError("Failed to link child", 500, e, "[link-child]");
  }
}
