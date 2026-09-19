import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-error";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { PRODUCT_PRICE_MAP } from "@/lib/products";
import { ensureCanAcceptCharges } from "@/lib/stripe-account-status";
import { assertSameOrigin } from "@/lib/csrf";

interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

// Audit iter-1-member-lifecycle A3H-1: validate body shape + bounds before
// any DB work. Previously items[].quantity could be negative / NaN / huge.
const bodySchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(200),
    price: z.number().positive().finite(),
    quantity: z.number().int().positive().max(100),
  })).min(1).max(50),
  successUrl: z.string().url().max(500).optional(),
  cancelUrl: z.string().url().max(500).optional(),
});

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
  // Audit iter-1-member-lifecycle A3H-1: CSRF guard on a session-
  // authenticated mutating endpoint that initiates a Stripe checkout +
  // creates an Order row. Mirrors the subscription-routes pattern.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid cart" }, { status: 400 });
  }
  const { items, successUrl, cancelUrl } = parsed.data;

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

  // The CLUB decides how it takes money, not the platform's environment.
  //
  // This used to branch on `!stripeKey` alone, so the rail came from a
  // platform-wide environment variable. A club that chose "Pay at desk only —
  // members pay cash or card at reception, no online charges" in the onboarding
  // wizard still got a Stripe checkout, because that choice persisted one
  // unrelated BACS flag and nothing anywhere read a payment rail. It is also
  // the option a standing-order club would pick.
  //
  // A NULL rail means "not chosen" and falls through to exactly the previous
  // behaviour, so no existing club changes.
  const tenant = await withTenantContext(session.user.tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: session.user.tenantId },
      select: {
        paymentRail: true,
        stripeAccountId: true,
        stripeConnected: true,
        stripeAccountStatus: true,
        currency: true,
        // The owner's switch for "members may spend money here". The shop used
        // to ignore it entirely, so a club that had turned member purchasing
        // off still took orders — the one thing the switch exists to stop.
        memberSelfBilling: true,
      },
    }),
  ).catch(() => null);

  const clubTakesPaymentAtDesk = tenant?.paymentRail === "pay_at_desk";

  // ── Pay at desk: the club's own choice, or no Stripe configured at all ──────
  if (clubTakesPaymentAtDesk || !stripeKey) {
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
      // Do NOT hand back a reference for an order that was not saved. The whole
      // value of the ref is that staff can look it up, and they cannot look up a
      // row that does not exist — so "Your order has been placed" here would be
      // a promise the product cannot keep, to a member standing at the desk who
      // would then be told there is no such order.
      console.error("[member/checkout] failed to persist pay-at-desk order", err);
      return NextResponse.json(
        { error: "We couldn't record your order just now — please ask a member of staff." },
        { status: 503 },
      );
    }
    return NextResponse.json({
      mode: "pay_at_desk",
      orderRef,
      total,
      items,
      message: "Your order has been placed. Please pay at the front desk.",
    });
  }

  // memberSelfBilling is the owner saying "members do not start card payments
  // themselves; the gym handles payment". It defaults to false. A pay-at-desk
  // order IS the gym handling payment, so it is decided above and never reaches
  // this line — refusing it would switch the member shop off for every club on
  // the default. Only the online card rail is refused, with the same status and
  // words as member/subscriptions/start.
  if (tenant && !tenant.memberSelfBilling) {
    return apiError("This gym manages payments centrally — please speak to staff", 403);
  }

  // ── Stripe checkout session ─────────────────────────────────────────────────
  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeKey, { apiVersion: "2026-03-25.dahlia" });

    // The tenant was already loaded above to decide the rail — reusing it keeps
    // this to one query and makes it impossible for the rail decision and the
    // Connect decision to read two different snapshots of the same row.
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
        // Tenant currency, not hardcoded gbp — EUR/USD gyms were charging
        // members in the wrong currency.
        currency: (tenant.currency ?? "GBP").toLowerCase(),
        product_data: { name: item.name },
        unit_amount: Math.round(item.serverPrice * 100),
      },
      quantity: item.quantity,
    }));

    const orderRef = `ORD-${Date.now().toString(36).toUpperCase()}`;
    const totalPence = validatedItems.reduce((sum, i) => sum + Math.round(i.serverPrice * 100) * i.quantity, 0);
    const memberIdForOrder = (session.user.memberId as string | undefined) ?? null;

    // THE ORDER IS WRITTEN BEFORE STRIPE IS CALLED. The comment here used to say
    // exactly that while the code did the opposite: it created the checkout
    // session first, then wrapped the Order write in a try/catch that logged,
    // swallowed, and RETURNED THE CHECKOUT URL ANYWAY. So a member could pay
    // with no Order row, no Payment row and no receipt — money at Stripe and
    // nothing anywhere in MatFlow.
    //
    // The swallow justified itself by claiming "the webhook can reconstruct via
    // metadata". It cannot: the webhook's shop branch is
    // `order.updateMany({ where: { orderRef, status: "pending" } })` and it
    // mirrors a Payment and sends the receipt only when `flipped.count > 0`
    // (app/api/stripe/webhook/route.ts:525-532). With no row to flip, the count
    // is zero and the payment is invisible for ever.
    //
    // Writing first also costs nothing, because the webhook matches on
    // `orderRef` — which is generated above and travels in the session metadata
    // — not on the session id. So the row does not need the session id to be
    // reconcilable, and attaching it afterwards is a convenience, not a
    // dependency.
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
          },
        }),
      );
    } catch (err) {
      // Refuse before any money can move. The pay-at-desk branch above already
      // answers 503 on the same failure; this one used to be the odd one out.
      console.error("[member/checkout] failed to persist stripe order — refusing checkout", err);
      return NextResponse.json(
        { error: "We couldn't start checkout just now — please try again in a moment." },
        { status: 503 },
      );
    }

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

    // Best-effort, and genuinely best-effort this time: the webhook reconciles
    // on `orderRef`, so a failure here costs traceability in the Stripe
    // dashboard and nothing else. It is logged rather than swallowed silently.
    try {
      await withTenantContext(session.user.tenantId, (tx) =>
        tx.order.updateMany({
          where: { tenantId: session.user.tenantId, orderRef },
          data: { stripeSessionId: checkoutSession.id },
        }),
      );
    } catch (err) {
      console.error("[member/checkout] could not attach stripeSessionId to order", orderRef, err);
    }

    return NextResponse.json({ mode: "stripe", url: checkoutSession.url });
  } catch (err: unknown) {
    return apiError("Payment processing failed", 500, err, "[member/checkout]");
  }
}
