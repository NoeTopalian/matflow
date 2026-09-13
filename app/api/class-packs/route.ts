import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  totalCredits: z.number().int().min(1).max(1000),
  validityDays: z.number().int().min(1).max(3650),
  pricePence: z.number().int().min(0).max(10_000_00),
  currency: z.string().min(3).max(3).optional(),
  isActive: z.boolean().optional(),
});

export async function GET() {
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;
  const rows = await withTenantContext(tenantId, (tx) =>
    tx.classPack.findMany({
      where: { tenantId },
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    }),
  );
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });

  const tenant = await withTenantContext(tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      // `currency` is read so the pack is priced in the CLUB's currency —
      // see the comment at the Stripe price below for why that matters.
      select: { stripeAccountId: true, stripeConnected: true, currency: true },
    }),
  );
  if (!tenant?.stripeConnected || !tenant.stripeAccountId) {
    return NextResponse.json({ error: "Connect Stripe before creating class packs" }, { status: 400 });
  }
  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });

  const { name, description, totalCredits, validityDays, pricePence, currency, isActive } = parsed.data;

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });

    const product = await stripe.products.create(
      { name, description: description ?? `${totalCredits} classes valid for ${validityDays} days` },
      { stripeAccount: tenant.stripeAccountId },
    );
    const price = await stripe.prices.create(
      {
        product: product.id,
        unit_amount: pricePence,
        // The CLUB's currency, not a GBP default.
        //
        // This sets the currency on the Stripe PRICE, so getting it wrong is
        // not one mis-charged order — every future buyer of this pack is
        // charged in the wrong currency until the price is rebuilt. A EUR club
        // creating a pack was creating a GBP price.
        //
        // `Tenant.currency` exists, is CHECK-constrained to GBP|EUR|USD, and is
        // read correctly by app/api/member/checkout/route.ts:200-202 — which
        // carries the comment "EUR/USD gyms were charging members in the wrong
        // currency". The bug was found and fixed on that path and left standing
        // here. The client-supplied value is still honoured when present, since
        // the form offers it, but the club's own setting is the fallback rather
        // than a hardcoded GBP.
        currency: (currency ?? tenant.currency ?? "GBP").toLowerCase(),
      },
      { stripeAccount: tenant.stripeAccountId },
    );

    const created = await withTenantContext(tenantId, (tx) =>
      tx.classPack.create({
        data: {
          tenantId,
          name,
          description: description ?? null,
          totalCredits,
          validityDays,
          pricePence,
          // Must match the Stripe price above, or the local row and the thing
          // members are actually charged disagree.
          currency: (currency ?? tenant.currency ?? "GBP").toUpperCase(),
          isActive: isActive ?? true,
          stripeProductId: product.id,
          stripePriceId: price.id,
        },
      }),
    );

    await logAudit({
      tenantId, userId,
      action: "class_pack.create",
      entityType: "ClassPack",
      entityId: created.id,
      metadata: { name, totalCredits, pricePence },
      req,
    });

    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    return apiError("Class pack operation failed", 500, e, "[class-packs]");
  }
}
