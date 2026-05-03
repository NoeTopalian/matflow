import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit-log";

export async function POST(req: Request) {
  const session = await auth();
  if (!session || session.user.role !== "owner") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tenant = await withTenantContext(session.user.tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: session.user.tenantId },
      select: { stripeAccountId: true },
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
    } catch { /* ignore — still clear DB */ }
  }

  await withTenantContext(session.user.tenantId, (tx) =>
    tx.tenant.update({
      where: { id: session.user.tenantId },
      data: { stripeAccountId: null, stripeConnected: false },
    }),
  );

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
