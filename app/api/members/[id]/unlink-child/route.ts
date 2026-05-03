import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { logAudit } from "@/lib/audit-log";
import { z } from "zod";

const bodySchema = z.object({
  childMemberId: z.string().min(1).max(50),
});

// Unlink only nulls parentMemberId — never deletes the child Member row.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

  try {
    const result = await withTenantContext(session.user.tenantId, (tx) =>
      tx.member.updateMany({
        where: {
          id: childMemberId,
          tenantId: session.user.tenantId,
          parentMemberId: parentId,
        },
        data: { parentMemberId: null },
      }),
    );

    if (result.count !== 1) return apiError("Link not found", 404);

    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "member.unlink.child",
      entityType: "Member",
      entityId: childMemberId,
      metadata: { parentMemberId: parentId, childMemberId },
      req,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError("Failed to unlink child", 500, e, "[unlink-child]");
  }
}
