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

// Unlink only nulls parentMemberId — never deletes the child Member row.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

  try {
    // A `kids` account may never be left without a guardian: the database CHECK
    // `Member_kids_must_have_parent` (migration 20260515000001) is
    // `accountType <> 'kids' OR parentMemberId IS NOT NULL`. Nulling the link
    // on one therefore threw, the catch below turned it into a 500, and an
    // owner was told the club had a fault when what had happened was that the
    // club asked for something the schema does not allow. The refusal now says
    // so, and says what to do instead.
    const child = await withTenantContext(session.user.tenantId, (tx) =>
      tx.member.findFirst({
        where: {
          id: childMemberId,
          tenantId: session.user.tenantId,
          parentMemberId: parentId,
        },
        select: { id: true, accountType: true },
      }),
    );
    if (!child) return apiError("Link not found", 404);
    if (child.accountType === "kids") {
      return apiError(
        "A child account can't be left without a guardian. Link them to another guardian first, " +
          "or remove the account.",
        409,
      );
    }

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

    // Lost the race: the link moved between the read and the write.
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
    // Backstop for the same constraint, in case the row's accountType changes
    // between the read above and the write — or a future caller reaches this
    // handler by another path. A constraint the product knows about is never a
    // 500: 500 means "we did not expect this", and we do.
    if (String((e as { message?: string })?.message ?? e).includes("Member_kids_must_have_parent")) {
      return apiError(
        "A child account can't be left without a guardian. Link them to another guardian first, " +
          "or remove the account.",
        409,
      );
    }
    return apiError("Failed to unlink child", 500, e, "[unlink-child]");
  }
}
