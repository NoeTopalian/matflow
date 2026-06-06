import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";

export async function POST(req: Request) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  // Lane 1 iter-2 L1-I2-S-05 [High] fix: split 401 (no session) from 403
  // (wrong role). The collapsed `401 Unauthorized` confused browser tooling
  // (treated 401 as "session expired" → logout loop for non-owners) and
  // diverged from the rest of the codebase which returns 403 for wrong role.
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

  // Lane 1 iter-2 L1-I2-S-04 [High] fix: missing audit log on a tenant-wide
  // state reset. Resetting onboarding flips a major behaviour gate; staff
  // need a paper trail.
  await logAudit({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    action: "tenant.onboarding.reset",
    entityType: "Tenant",
    entityId: session.user.tenantId,
    req,
  });

  return NextResponse.json({ ok: true });
}
