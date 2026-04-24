import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
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
    const memberId = session.user.memberId;
    if (memberId) {
      await prisma.member.update({
        where: { id: memberId },
        data: { sessionVersion: { increment: 1 } },
      });
    } else {
      await prisma.user.update({
        where: { id: session.user.id },
        data: { sessionVersion: { increment: 1 } },
      });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to revoke sessions" }, { status: 500 });
  }
}
