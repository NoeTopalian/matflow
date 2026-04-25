import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function POST() {
  const session = await auth();
  if (!session || session.user.role !== "owner") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await prisma.tenant.update({
    where: { id: session.user.tenantId },
    data: {
      onboardingCompleted: false,
      onboardingAnswers: null,
    },
  });

  return NextResponse.json({ ok: true });
}
