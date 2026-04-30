/**
 * POST   /api/member/class-subscriptions/[classId]   — subscribe self to a class
 * DELETE /api/member/class-subscriptions/[classId]   — unsubscribe self
 *
 * Tenant-scoped: the class must belong to the member's tenant.
 */
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
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

  // Verify the class belongs to the member's tenant before letting them subscribe.
  const cls = await prisma.class.findFirst({
    where: { id: classId, tenantId: r.tenantId },
    select: { id: true },
  });
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  try {
    await prisma.classSubscription.create({
      data: { memberId: r.memberId, classId },
    });
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
  const result = await prisma.classSubscription.deleteMany({
    where: {
      memberId: r.memberId,
      classId,
      class: { tenantId: r.tenantId },
    },
  });
  return NextResponse.json({ success: true, removed: result.count });
}
