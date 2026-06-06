import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";

export async function POST(req: Request) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
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
