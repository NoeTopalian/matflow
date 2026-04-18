import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";

interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
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

  const stripeKey = process.env.STRIPE_SECRET_KEY;

  // ── Stripe not configured: return pay-at-desk confirmation ─────────────────
  if (!stripeKey) {
    const orderRef = `ORD-${Date.now().toString(36).toUpperCase()}`;
    const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
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

    const lineItems = items.map((item) => ({
      price_data: {
        currency: "gbp",
        product_data: { name: item.name },
        unit_amount: Math.round(item.price * 100),
      },
      quantity: item.quantity,
    }));

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: successUrl || `${req.nextUrl.origin}/member/shop?success=1`,
      cancel_url: cancelUrl || `${req.nextUrl.origin}/member/shop`,
      payment_method_types: ["card"],
      // Apple Pay / Google Pay are automatically included by Stripe when available
    });

    return NextResponse.json({ mode: "stripe", url: checkoutSession.url });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Checkout failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
