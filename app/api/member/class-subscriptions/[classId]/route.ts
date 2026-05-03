/**
 * POST   /api/member/class-subscriptions/[classId]   — subscribe self to a class
 * DELETE /api/member/class-subscriptions/[classId]   — unsubscribe self
 *
 * Tenant-scoped: the class must belong to the member's tenant.
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

async function resolveMember() {
  const session = await auth();
  if (!session?.user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return { error: NextResponse.json({ error: "Member not found" }, { status: 404 }) };
  return { memberId, tenantId: session.user.tenantId };
}

export async function POST(_req: Request, ctx: { params: Promise<{ classId: string }> }) {
  const { classId } = await ctx.params;
  const r = await resolveMember();
  if ("error" in r) return r.error;

  try {
    const created = await withTenantContext(r.tenantId, async (tx) => {
      const cls = await tx.class.findFirst({
        where: { id: classId, tenantId: r.tenantId },
        select: { id: true },
      });
      if (!cls) return "no-class" as const;
      await tx.classSubscription.create({
        data: { memberId: r.memberId, classId },
      });
      return "ok" as const;
    });
    if (created === "no-class") return NextResponse.json({ error: "Class not found" }, { status: 404 });
  } catch (e: unknown) {
    // Idempotent: re-subscribe is a no-op via @@unique([memberId, classId])
    if ((e as { code?: string }).code !== "P2002") {
      return NextResponse.json({ error: "Failed to subscribe" }, { status: 500 });
    }
  }
  return NextResponse.json({ success: true, classId }, { status: 201 });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ classId: string }> }) {
  const { classId } = await ctx.params;
  const r = await resolveMember();
  if ("error" in r) return r.error;

  // Tenant-scoped delete via the class relation; deleteMany returns count
  // so cross-tenant attempts no-op silently rather than 404-leaking.
  const result = await withTenantContext(r.tenantId, (tx) =>
    tx.classSubscription.deleteMany({
      where: {
        memberId: r.memberId,
        classId,
        class: { tenantId: r.tenantId },
      },
    }),
  );
  return NextResponse.json({ success: true, removed: result.count });
}
