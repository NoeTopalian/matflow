import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { auth } from "@/auth";
import { PRODUCT_PRICE_MAP } from "@/lib/products";

interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
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

  // Validate all item prices against server-side lookup; build validated list using server prices
  const validatedItems: (CartItem & { serverPrice: number })[] = [];
  for (const item of items) {
    const serverPrice = PRODUCT_PRICE_MAP[item.id];
    if (serverPrice === undefined || Math.abs(item.price - serverPrice) > 0.001) {
      return NextResponse.json({ error: "Invalid item price" }, { status: 400 });
    }
    validatedItems.push({ ...item, serverPrice });
  }

  const origin = req.nextUrl.origin;
  const safeSuccessUrl = safeSameOriginUrl(successUrl, `${origin}/member/shop?success=1`, origin);
  const safeCancelUrl = safeSameOriginUrl(cancelUrl, `${origin}/member/shop`, origin);

  const stripeKey = process.env.STRIPE_SECRET_KEY;

  // ── Stripe not configured: return pay-at-desk confirmation ─────────────────
  if (!stripeKey) {
    const orderRef = `ORD-${Date.now().toString(36).toUpperCase()}`;
    const total = validatedItems.reduce((sum, i) => sum + i.serverPrice * i.quantity, 0);
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
    const { prisma } = await import("@/lib/prisma");
    const tenant = await prisma.tenant.findUnique({
      where: { id: session.user.tenantId },
      select: { stripeAccountId: true, stripeConnected: true },
    }).catch(() => null);
    if (!tenant?.stripeAccountId) {
      return NextResponse.json(
        { error: "This gym has not connected Stripe yet — checkout is unavailable." },
        { status: 400 },
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

    const checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: lineItems,
        success_url: safeSuccessUrl,
        cancel_url: safeCancelUrl,
        payment_method_types: ["card"],
      },
      connectedAccount ? { stripeAccount: connectedAccount } : undefined,
    );

    return NextResponse.json({ mode: "stripe", url: checkoutSession.url });
  } catch (err: unknown) {
    return apiError("Payment processing failed", 500, err, "[member/checkout]");
  }
}
