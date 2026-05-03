import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";

export async function POST() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.user.tenantId === "demo-tenant") {
    return NextResponse.json({ ok: true });
  }

  try {
    await withTenantContext(session.user.tenantId, async (tx) => {
      const memberId = session.user.memberId;
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
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to revoke sessions" }, { status: 500 });
  }
}
