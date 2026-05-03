import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { PRODUCT_PRICE_MAP } from "@/lib/products";
import { ensureCanAcceptCharges } from "@/lib/stripe-account-status";

interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

/**
 * Build a tenant-scoped {productId → price} map from the DB. Falls back to the
 * static demo catalogue (lib/products.ts) when the tenant has no rows yet, so
 * a brand-new gym still sees a working store before customising it.
 */
async function buildPriceMap(tenantId: string): Promise<Record<string, number>> {
  if (tenantId === "demo-tenant") return PRODUCT_PRICE_MAP;
  try {
    const rows = await withTenantContext(tenantId, (tx) =>
      tx.product.findMany({
        where: { tenantId, deletedAt: null },
        select: { id: true, pricePence: true },
      }),
    );
    if (rows.length === 0) return PRODUCT_PRICE_MAP;
    return Object.fromEntries(rows.map((r) => [r.id, r.pricePence / 100]));
  } catch {
    return PRODUCT_PRICE_MAP;
  }
}

function safeSameOriginUrl(url: string | undefined, fallback: string, origin: string): string {
  if (!url) return fallback;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== origin) return fallback;
    return url;
  } catch {
    return fallback;
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const { items, successUrl, cancelUrl } = await req.json() as {
    items: CartItem[];
    successUrl: string;
    cancelUrl: string;
  };

  if (!items?.length) {
    return NextResponse.json({ error: "No items in cart" }, { status: 400 });
  }

  // Validate all item prices against the tenant-scoped DB catalogue. Server
  // prices win — the client-supplied price is only sanity-checked to catch
  // tampering. Falls back to lib/products.ts for demo / fresh tenants.
  const priceMap = await buildPriceMap(session.user.tenantId);
  const validatedItems: (CartItem & { serverPrice: number })[] = [];
  for (const item of items) {
    const serverPrice = priceMap[item.id];
    if (serverPrice === undefined || Math.abs(item.price - serverPrice) > 0.001) {
      return NextResponse.json({ error: "Invalid item price" }, { status: 400 });
    }
    validatedItems.push({ ...item, serverPrice });
  }

  const origin = req.nextUrl.origin;
  const safeSuccessUrl = safeSameOriginUrl(successUrl, `${origin}/member/shop?success=1`, origin);
  const safeCancelUrl = safeSameOriginUrl(cancelUrl, `${origin}/member/shop`, origin);

  const stripeKey = process.env.STRIPE_SECRET_KEY;

  // ── Stripe not configured: persist a pay-at-desk Order so revenue is tracked ─
  if (!stripeKey) {
    const orderRef = `ORD-${Date.now().toString(36).toUpperCase()}`;
    const total = validatedItems.reduce((sum, i) => sum + i.serverPrice * i.quantity, 0);
    try {
      await withTenantContext(session.user.tenantId, (tx) =>
        tx.order.create({
          data: {
            tenantId: session.user.tenantId,
            memberId: (session.user.memberId as string | undefined) ?? null,
            orderRef,
            items: validatedItems.map((i) => ({ id: i.id, name: i.name, price: i.serverPrice, quantity: i.quantity })),
            totalPence: Math.round(total * 100),
            status: "pending",
            paymentMethod: "pay_at_desk",
          },
        }),
      );
    } catch (err) {
      // DB write failure shouldn't block the user — they're standing at the front
      // desk. Log so the gym sees it; the order can be reconstructed manually.
      console.error("[member/checkout] failed to persist pay-at-desk order", err);
    }
    return NextResponse.json({
      mode: "pay_at_desk",
      orderRef,
      total,
      items,
      message: "Your order has been placed. Please pay at the front desk.",
    });
  }

  // ── Stripe checkout session ─────────────────────────────────────────────────
  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeKey, { apiVersion: "2026-03-25.dahlia" });

    // Use connected account when available (Stripe Connect)
    const tenant = await withTenantContext(session.user.tenantId, (tx) =>
      tx.tenant.findUnique({
        where: { id: session.user.tenantId },
        select: { stripeAccountId: true, stripeConnected: true, stripeAccountStatus: true },
      }),
    ).catch(() => null);
    if (!tenant?.stripeAccountId) {
      return NextResponse.json(
        { error: "This gym has not connected Stripe yet — checkout is unavailable." },
        { status: 400 },
      );
    }

    // Fix 3: refuse checkout if Stripe Connect account can't accept charges
    // (KYC failure, requirements past due, fraud restriction). Refresh on
    // stale cache so a fresh tenant gets the first lazy-fetch.
    const acceptCheck = await ensureCanAcceptCharges(
      session.user.tenantId,
      tenant.stripeAccountId,
      tenant.stripeAccountStatus,
    );
    if (!acceptCheck.ok) {
      return NextResponse.json(
        { error: "This gym's Stripe account requires attention. Please contact the gym." },
        { status: 503 },
      );
    }

    const connectedAccount = tenant.stripeConnected ? tenant.stripeAccountId : undefined;

    const lineItems = validatedItems.map((item: typeof validatedItems[number]) => ({
      price_data: {
        currency: "gbp",
        product_data: { name: item.name },
        unit_amount: Math.round(item.serverPrice * 100),
      },
      quantity: item.quantity,
    }));

    // Create the Order BEFORE redirecting to Stripe so the row exists even if
    // the webhook is delayed or the user closes the tab. Status flips to 'paid'
    // when the checkout.session.completed webhook fires (see webhook handler
    // below for the matflowKind='shop_order' branch).
    const orderRef = `ORD-${Date.now().toString(36).toUpperCase()}`;
    const totalPence = validatedItems.reduce((sum, i) => sum + Math.round(i.serverPrice * 100) * i.quantity, 0);
    const memberIdForOrder = (session.user.memberId as string | undefined) ?? null;

    const checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: lineItems,
        success_url: safeSuccessUrl,
        cancel_url: safeCancelUrl,
        payment_method_types: ["card"],
        metadata: {
          matflowKind: "shop_order",
          tenantId: session.user.tenantId,
          orderRef,
          ...(memberIdForOrder ? { memberId: memberIdForOrder } : {}),
        },
      },
      connectedAccount ? { stripeAccount: connectedAccount } : undefined,
    );

    try {
      await withTenantContext(session.user.tenantId, (tx) =>
        tx.order.create({
          data: {
            tenantId: session.user.tenantId,
            memberId: memberIdForOrder,
            orderRef,
            items: validatedItems.map((i) => ({ id: i.id, name: i.name, price: i.serverPrice, quantity: i.quantity })),
            totalPence,
            status: "pending",
            paymentMethod: "stripe",
            stripeSessionId: checkoutSession.id,
          },
        }),
      );
    } catch (err) {
      // DB write failed but Stripe session is already created — log and continue
      // so the user still gets to checkout. The webhook can reconstruct via metadata.
      console.error("[member/checkout] failed to persist stripe order", err);
    }

    return NextResponse.json({ mode: "stripe", url: checkoutSession.url });
  } catch (err: unknown) {
    return apiError("Payment processing failed", 500, err, "[member/checkout]");
  }
}
