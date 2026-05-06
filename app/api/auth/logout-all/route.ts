import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.user.tenantId === "demo-tenant") {
    return NextResponse.json({ ok: true });
  }

  try {
    const memberId = session.user.memberId;
    await withTenantContext(session.user.tenantId, async (tx) => {
      if (memberId) {
        await tx.member.update({
          where: { id: memberId },
          data: { sessionVersion: { increment: 1 } },
        });
      } else {
        await tx.user.update({
          where: { id: session.user.id },
          data: { sessionVersion: { increment: 1 } },
        });
      }
    });

    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "auth.logout_all",
      entityType: memberId ? "Member" : "User",
      entityId: memberId ?? session.user.id,
      metadata: null,
      req,
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to revoke sessions" }, { status: 500 });
  }
}
