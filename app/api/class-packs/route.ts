import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwnerOrManager } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";

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
  const { tenantId } = await requireOwnerOrManager();
  const rows = await withTenantContext(tenantId, (tx) =>
    tx.classPack.findMany({
      where: { tenantId },
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    }),
  );
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const { tenantId, userId } = await requireOwnerOrManager();

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });

  const tenant = await withTenantContext(tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { stripeAccountId: true, stripeConnected: true },
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
        currency: (currency ?? "GBP").toLowerCase(),
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
          currency: (currency ?? "GBP").toUpperCase(),
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
