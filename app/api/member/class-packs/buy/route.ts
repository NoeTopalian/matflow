import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";
import { ensureCanAcceptCharges } from "@/lib/stripe-account-status";
import { getBaseUrl } from "@/lib/env-url";

const schema = z.object({ packId: z.string().min(1) });

export const runtime = "nodejs";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json({ error: "Member account not linked" }, { status: 400 });

  const rl = await checkRateLimit(`pack:buy:${memberId}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many purchase attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });

  const tenantId = session.user.tenantId;
  const lookups = await withTenantContext(tenantId, async (tx) => {
    const m = await tx.member.findFirst({
      where: { id: memberId, tenantId },
      select: { id: true, email: true, name: true, stripeCustomerId: true },
    });
    if (!m) return { kind: "no-member" as const };
    const p = await tx.classPack.findFirst({
      where: { id: parsed.data.packId, tenantId, isActive: true },
    });
    if (!p || !p.stripePriceId) return { kind: "no-pack" as const };
    const t = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { stripeAccountId: true, stripeConnected: true, stripeAccountStatus: true },
    });
    return { kind: "ok" as const, member: m, pack: p, tenant: t };
  });
  if (lookups.kind === "no-member") return NextResponse.json({ error: "Member not found" }, { status: 404 });
  if (lookups.kind === "no-pack") return NextResponse.json({ error: "Pack unavailable" }, { status: 404 });
  const { member, pack, tenant } = lookups;
  if (!tenant?.stripeConnected || !tenant.stripeAccountId) {
    return NextResponse.json({ error: "Stripe not connected" }, { status: 400 });
  }
  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });

  // Fix 3: refuse purchase if Stripe Connect account can't accept charges.
  const acceptCheck = await ensureCanAcceptCharges(tenantId, tenant.stripeAccountId, tenant.stripeAccountStatus);
  if (!acceptCheck.ok) {
    return NextResponse.json(
      { error: "This gym's Stripe account requires attention. Please contact the gym." },
      { status: 503 },
    );
  }

  const base = getBaseUrl(req);
  const successUrl = `${base}/member/profile?pack=success`;
  const cancelUrl = `${base}/member/profile?pack=cancel`;

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });

    let customerId = member.stripeCustomerId;
    if (!customerId) {
      // Race-safe: only one request can flip stripeCustomerId from null to a real value.
      const customer = await stripe.customers.create(
        { email: member.email, name: member.name },
        { stripeAccount: tenant.stripeAccountId },
      );
      const winnerId = await withTenantContext(tenantId, async (tx) => {
        const u = await tx.member.updateMany({
          where: { id: member.id, stripeCustomerId: null },
          data: { stripeCustomerId: customer.id },
        });
        if (u.count === 1) return customer.id;
        const fresh = await tx.member.findUnique({
          where: { id: member.id },
          select: { stripeCustomerId: true },
        });
        return fresh?.stripeCustomerId ?? customer.id;
      });
      customerId = winnerId;
    }

    const checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer: customerId ?? undefined,
        // pack.stripePriceId narrowed to non-null by the no-pack guard above —
        // TypeScript can't track this through the withTenantContext closure.
        line_items: [{ price: pack.stripePriceId!, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          matflowKind: "class_pack",
          tenantId,
          memberId: member.id,
          packId: pack.id,
        },
      },
      { stripeAccount: tenant.stripeAccountId },
    );

    return NextResponse.json({ url: checkoutSession.url });
  } catch (e) {
    return apiError("Class pack operation failed", 500, e, "[member/class-packs/buy]");
  }
}
