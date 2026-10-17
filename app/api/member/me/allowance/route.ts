/**
 * GET /api/member/me/allowance
 *
 * T7 (Sean note 5): the signed-in member's plan allowance usage for the
 * schedule — "2 of 4 classes used in the last 4 weeks" — counted by the same
 * rows the check-in counts (lib/class-allowance-count.ts). `allowance` is
 * null for an Unlimited plan or no plan. A failure is a 500, never a null:
 * the page says the count could not be loaded rather than showing nothing.
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { memberAllowanceUsage } from "@/lib/class-allowance-count";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json({ allowance: null });

  try {
    const allowance = await withTenantContext(session.user.tenantId, (tx) =>
      memberAllowanceUsage(tx, { tenantId: session.user.tenantId, memberId }),
    );
    return NextResponse.json({ allowance });
  } catch {
    return NextResponse.json({ error: "Couldn't load your class allowance" }, { status: 500 });
  }
}
