import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";
import { Prisma } from "@prisma/client";
import { refuseSupportSession } from "@/lib/support-session";

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  const support = refuseSupportSession(session); if (support) return support; // read-only support session (lib/support-session.ts)
  if (!session || session.user.role !== "owner") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tenant = await withTenantContext(session.user.tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: session.user.tenantId },
      select: { stripeAccountId: true },
    }),
  );

  // Payments lane PA: the database is cleared FIRST, then Stripe is told.
  // Every payment route reads id, flag and status through
  // requireChargeableClubAccount, so once this write commits no new request
  // can pass the guard. Deauthorising first left a window in which the guard
  // still saw a connected club whose grant Stripe had already revoked. The
  // deauthorise call uses the id captured above, so it still reaches the
  // right account after the row is cleared.
  await withTenantContext(session.user.tenantId, (tx) =>
    tx.tenant.update({
      where: { id: session.user.tenantId },
      // Tier 4.15: also clear the cached capability snapshot. Otherwise a
      // reconnect within the 24h staleness window would trust a stale
      // chargesEnabled verdict from the previous account in the checkout gate.
      data: { stripeAccountId: null, stripeConnected: false, stripeAccountStatus: Prisma.DbNull },
    }),
  );

  if (tenant?.stripeAccountId && process.env.STRIPE_SECRET_KEY) {
    try {
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });
      await stripe.oauth.deauthorize({
        client_id: process.env.STRIPE_CLIENT_ID!,
        stripe_user_id: tenant.stripeAccountId,
      });
    } catch { /* ignore — the club is already disconnected in MatFlow (unchanged behaviour) */ }
  }

  await logAudit({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    action: "stripe.disconnect",
    entityType: "Tenant",
    entityId: session.user.tenantId,
    req,
  });

  return NextResponse.json({ ok: true });
}
