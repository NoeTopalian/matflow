import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";

export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // B-7: derive memberId EXCLUSIVELY from session, never from body
  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json({ error: "No member account" }, { status: 400 });

  try {
    await withTenantContext(session.user.tenantId, (tx) =>
      tx.member.updateMany({
        where: { id: memberId, tenantId: session.user.tenantId },
        data: { lastAnnouncementSeenAt: new Date() },
      }),
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError("Failed to mark announcements seen", 500, e, "[member/me/mark-announcements-seen]");
  }
}
