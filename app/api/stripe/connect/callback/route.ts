import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "owner") {
    return NextResponse.redirect(new URL("/dashboard/settings?tab=revenue&error=auth", req.url));
  }

  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!code || !state) {
    return NextResponse.redirect(new URL("/dashboard/settings?tab=revenue&error=missing_params", req.url));
  }

  // Verify CSRF state: format is `{hmac}:{tenantId}:{timestamp}`
  const parts = state.split(":");
  if (parts.length < 3) {
    return NextResponse.redirect(new URL("/dashboard/settings?tab=revenue&error=invalid_state", req.url));
  }
  const [hmac, ...rest] = parts;
  const payload = rest.join(":");
  const expectedHmac = createHmac("sha256", AUTH_SECRET_VALUE).update(payload).digest("hex");
  // Length check first — timingSafeEqual throws on length mismatch, and an
  // attacker controls the supplied `hmac` value so they could otherwise tell
  // (via thrown error vs returned redirect) whether their guess matched length.
  // Constant-time compare only after lengths agree.
  const hmacOk =
    hmac.length === expectedHmac.length &&
    timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(expectedHmac, "hex"));
  if (!hmacOk) {
    return NextResponse.redirect(new URL("/dashboard/settings?tab=revenue&error=invalid_state", req.url));
  }

  const [tenantId, ts] = rest;
  if (tenantId !== session.user.tenantId) {
    return NextResponse.redirect(new URL("/dashboard/settings?tab=revenue&error=tenant_mismatch", req.url));
  }
  if (!ts || Date.now() - Number(ts) > 15 * 60 * 1000) {
    return NextResponse.redirect(new URL("/dashboard/settings?tab=revenue&error=state_expired", req.url));
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-03-25.dahlia" });
    const response = await stripe.oauth.token({ grant_type: "authorization_code", code });
    const stripeAccountId = response.stripe_user_id;
    if (!stripeAccountId) throw new Error("No stripe_user_id in response");

    await withTenantContext(session.user.tenantId, (tx) =>
      tx.tenant.update({
        where: { id: session.user.tenantId },
        data: { stripeAccountId, stripeConnected: true },
      }),
    );

    const { logAudit } = await import("@/lib/audit-log");
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "stripe.connect",
      entityType: "Tenant",
      entityId: session.user.tenantId,
      metadata: { stripeAccountId },
      req,
    });

    return NextResponse.redirect(new URL("/dashboard/settings?tab=revenue&connected=true", req.url));
  } catch {
    return NextResponse.redirect(new URL("/dashboard/settings?tab=revenue&error=exchange_failed", req.url));
  }
}
