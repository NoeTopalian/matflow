import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

export async function POST() {
  const session = await auth();
  if (!session || session.user.role !== "owner") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await withTenantContext(session.user.tenantId, (tx) =>
    tx.tenant.update({
      where: { id: session.user.tenantId },
      data: {
        onboardingCompleted: false,
        onboardingAnswers: Prisma.JsonNull,
      },
    }),
  );

  return NextResponse.json({ ok: true });
}
