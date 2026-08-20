/**
 * GET /api/member/me/subscriptions
 * Returns the list of classIds the logged-in member has subscribed to.
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) {
    return NextResponse.json({ classIds: [] });
  }

  const subs = await withTenantContext(session.user.tenantId, (tx) =>
    tx.classSubscription.findMany({
      where: {
        memberId,
        // Archiving a class leaves its ClassSubscription rows behind — nothing
        // deletes them and the member has no UI to clear them, so an
        // unfiltered read returned dead class ids forever. Scope to the
        // classes the member can actually still see (RULES §5).
        class: { tenantId: session.user.tenantId, isActive: true, deletedAt: null },
      },
      select: { classId: true },
    }),
  );

  return NextResponse.json({ classIds: subs.map((s) => s.classId) });
}
