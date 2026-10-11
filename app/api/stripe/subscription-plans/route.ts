import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { z } from "zod";
import {
  ClubAccountNotChargeable,
  clubAccountOrRefusal,
  requireChargeableClubAccount,
} from "@/lib/stripe/club-account";

// Defence-in-depth on the plan-creation body. Stripe itself validates
// `unit_amount > 0` but we should reject obviously bad input before sending.
// `amount` is in POUNDS (the SettingsPage UI uses step="0.01" and shows £ —
// see the Math.round(amount * 100) at the unit_amount call below). Iteration 1
// of this Zod schema declared .int() which rejected legitimate decimal values
// like 29.99. Cap at £100k/month — generous ceiling for any real gym plan.
const createPlanSchema = z.object({
  name: z.string().trim().min(1).max(200),
  amount: z.number().positive().max(100_000),
  interval: z.enum(["week", "month", "year"]),
  // Stripe has no 4-weekly interval; it is `week` × 4. Only meaningful with
  // `week`; ignored (forced to 1) for month/year so a plan cannot be minted as
  // "every 3 months" from a UI that has no such option.
  intervalCount: z.number().int().min(1).max(4).optional(),
});

// Payments lane PA: the Stripe connection (id, flag, status) is decided by
// requireChargeableClubAccount; this only reads the club's currency.
async function getTenantCurrency(tenantId: string): Promise<string> {
  const tenant = await withTenantContext(tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { currency: true },
    }),
  );
  return tenant?.currency ?? "GBP";
}

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "owner") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ plans: [] });
  }
  let acctId: string;
  try {
    acctId = (await requireChargeableClubAccount(session.user.tenantId, { purpose: "catalogue" })).stripeAccountId;
  } catch (e) {
    // Unchanged contract for the settings screen (an empty list when the club
    // has no usable connection), now with the reason so it can say why.
    if (e instanceof ClubAccountNotChargeable) return NextResponse.json({ plans: [], reason: e.reason });
    throw e;
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });
    const prices = await stripe.prices.list(
      { active: true, expand: ["data.product"], limit: 20 },
      { stripeAccount: acctId },
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
  // Audit iter-1-member-lifecycle A3H-1: CSRF guard on an owner-only mutating
  // endpoint that creates Stripe products / price plans on the gym's
  // connected account. Imported inline to avoid changing the top-of-file
  // import order for an isolated audit fix.
  const { assertSameOrigin } = await import("@/lib/csrf");
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session || session.user.role !== "owner") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });
  // Payments lane PA: one guard for every Stripe call; the id it read is the
  // only one the product and price below are created on.
  const club = await clubAccountOrRefusal(session.user.tenantId, "catalogue", { audience: "staff" });
  if (!club.ok) return club.response;
  const acctId = club.account.stripeAccountId;
  const currency = await getTenantCurrency(session.user.tenantId);

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
  const { name, amount, interval, intervalCount } = parsed.data;
  const recurring = {
    interval: interval ?? "month",
    interval_count: interval === "week" ? (intervalCount ?? 1) : 1,
  };

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeKey, { apiVersion: "2026-03-25.dahlia" });

    const product = await stripe.products.create(
      { name: name.trim() },
      { stripeAccount: acctId },
    );

    const price = await stripe.prices.create(
      {
        product: product.id,
        unit_amount: Math.round(amount * 100),
        // Tenant currency, not hardcoded gbp — EUR/USD gyms were getting
        // GBP-denominated plans.
        currency: currency.toLowerCase(),
        recurring,
      },
      { stripeAccount: acctId },
    );

    return NextResponse.json({ id: price.id, name: product.name, amount, interval: recurring.interval, intervalCount: recurring.interval_count });
  } catch (err: unknown) {
    return apiError("Stripe operation failed", 500, err, "[stripe/subscription-plans]");
  }
}
