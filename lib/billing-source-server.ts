import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { BILLED_ELSEWHERE_REFUSAL, isBilledElsewhere } from "@/lib/billing-source";

/** The 409 every collection-starting route returns for a member TeamUp bills. */
export function billedElsewhereResponse(): NextResponse {
  return NextResponse.json({ error: BILLED_ELSEWHERE_REFUSAL, reason: "billed_elsewhere" }, { status: 409 });
}

/**
 * Returns a 409 when the member is billed by TeamUp, otherwise null. Call it
 * after authentication and before any provider call — a hidden button is not
 * a control (readiness spec v3 §7).
 */
export async function refuseIfBilledElsewhere(tenantId: string, memberId: string): Promise<NextResponse | null> {
  const m = await withTenantContext(tenantId, (tx) =>
    tx.member.findFirst({ where: { id: memberId, tenantId }, select: { billedBy: true } }),
  );
  return isBilledElsewhere(m) ? billedElsewhereResponse() : null;
}
