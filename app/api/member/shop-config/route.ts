import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";

/**
 * GET /api/member/shop-config — how the member shop should present payment.
 *
 * Exists so the shop can LABEL its checkout button truthfully. Before this, the
 * button read "Pay · £X" under "Powered by Stripe · Apple Pay & card supported"
 * for every club, including one that had explicitly chosen "Pay at desk only —
 * no online charges". Pressing it then placed a desk order, so the member was
 * promised a card payment and given an IOU.
 *
 * A separate route rather than a field on /api/member/products because that
 * endpoint returns a bare ARRAY and an e2e contract asserts it
 * (tests/e2e/api/routes.spec.ts). Wrapping it in an object to carry one string
 * would break that for no benefit.
 *
 * `paymentRail` is null when the club has not chosen, which is the shipped
 * state for every existing club: the shop then falls back to whether Stripe is
 * configured, exactly as it always has.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tenantId = session.user.tenantId;

  try {
    const tenant = await withTenantContext(tenantId, (tx) =>
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: { paymentRail: true, stripeConnected: true },
      }),
    );
    return NextResponse.json({
      paymentRail: tenant?.paymentRail ?? null,
      stripeConnected: tenant?.stripeConnected ?? false,
    });
  } catch (err) {
    // Never guess a rail on failure. The caller treats an error as "unknown"
    // and shows neutral copy, because claiming either rail wrongly is the
    // defect this route exists to remove.
    console.error("[member/shop-config] GET failed", err);
    return NextResponse.json({ error: "Temporarily unavailable" }, { status: 503 });
  }
}
