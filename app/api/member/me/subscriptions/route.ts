/**
 * GET /api/member/me/subscriptions
 * Returns the list of classIds the logged-in member has subscribed to.
 */
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
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

  const subs = await prisma.classSubscription.findMany({
    where: {
      memberId,
      class: { tenantId: session.user.tenantId },
    },
    select: { classId: true },
  });

  return NextResponse.json({ classIds: subs.map((s) => s.classId) });
}
