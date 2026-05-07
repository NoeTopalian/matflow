import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { z } from "zod";

// Defence-in-depth on the plan-creation body. Stripe itself validates
// `unit_amount > 0` but we should reject obviously bad input before sending.
// `amount` is in POUNDS (the SettingsPage UI uses step="0.01" and shows £ —
// see the Math.round(amount * 100) at the unit_amount call below). Iteration 1
// of this Zod schema declared .int() which rejected legitimate decimal values
// like 29.99. Cap at £100k/month — generous ceiling for any real gym plan.
const createPlanSchema = z.object({
  name: z.string().trim().min(1).max(200),
  amount: z.number().positive().max(100_000),
  interval: z.enum(["month", "year"]),
});

async function getTenantStripeAccount(tenantId: string) {
  const tenant = await withTenantContext(tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { stripeAccountId: true, stripeConnected: true },
    }),
  );
  if (!tenant?.stripeConnected || !tenant.stripeAccountId) return null;
  return tenant.stripeAccountId;
}

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "owner") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stripeAccountId = await getTenantStripeAccount(session.user.tenantId);
  if (!stripeAccountId || !process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ plans: [] });
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });
    const prices = await stripe.prices.list(
      { active: true, expand: ["data.product"], limit: 20 },
      { stripeAccount: stripeAccountId },
    );

    const plans = prices.data.map((p) => ({
      id: p.id,
      name: typeof p.product === "object" && p.product !== null
        ? (p.product as { name?: string }).name ?? "Plan"
        : "Plan",
      amount: (p.unit_amount ?? 0) / 100,
      currency: p.currency,
      interval: p.recurring?.interval ?? "month",
    }));

    return NextResponse.json({ plans });
  } catch (e) {
    console.error("[stripe/subscription-plans]", e);
    return NextResponse.json({ plans: [] });
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session || session.user.role !== "owner") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stripeAccountId = await getTenantStripeAccount(session.user.tenantId);
  if (!stripeAccountId || !process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "Stripe not connected" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = createPlanSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid plan data" }, { status: 400 });
  }
  const { name, amount, interval } = parsed.data;

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });

    const product = await stripe.products.create(
      { name: name.trim() },
      { stripeAccount: stripeAccountId },
    );

    const price = await stripe.prices.create(
      {
        product: product.id,
        unit_amount: Math.round(amount * 100),
        currency: "gbp",
        recurring: { interval: interval ?? "month" },
      },
      { stripeAccount: stripeAccountId },
    );

    return NextResponse.json({ id: price.id, name: product.name, amount, interval });
  } catch (err: unknown) {
    return apiError("Stripe operation failed", 500, err, "[stripe/subscription-plans]");
  }
}
