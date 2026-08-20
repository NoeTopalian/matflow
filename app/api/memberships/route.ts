import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiOwner, requireApiOwnerOrManager } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  pricePence: z.number().int().min(0),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/),
  billingCycle: z.enum(["monthly", "annual", "none"]),
  maxClassesPerWeek: z.number().int().min(1).max(30).optional(),
  isKids: z.boolean(),
  // Stripe linkage. Both optional and nullable — set later by owners who wire
  // Stripe Connect and want member-side self-subscribe (F2/F3) to pick this
  // tier server-side instead of by trust-the-client priceId. price_/prod_
  // prefixes mirror Stripe's documented id shapes.
  stripePriceId: z.string().regex(/^price_[A-Za-z0-9_]+$/).max(100).nullable().optional(),
  stripeProductId: z.string().regex(/^prod_[A-Za-z0-9_]+$/).max(100).nullable().optional(),
});

export async function GET() {
  try {
    const gate = await requireApiOwnerOrManager();
    if (!gate.ok) return gate.response;
    const { tenantId } = gate;
    const tiers = await withTenantContext(tenantId, (tx) =>
      tx.membershipTier.findMany({
        where: { tenantId, isActive: true },
        orderBy: { createdAt: "asc" },
      }),
    );
    return NextResponse.json(tiers);
  } catch (e) {
    return apiError("Failed to load membership tiers", 500, e, "[memberships GET]");
  }
}

export async function POST(req: Request) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  try {
    const gate = await requireApiOwner();
    if (!gate.ok) return gate.response;
    const { tenantId, userId } = gate;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
    }

    const { name, description, pricePence, currency, billingCycle, maxClassesPerWeek, isKids, stripePriceId, stripeProductId } = parsed.data;

    const tier = await withTenantContext(tenantId, (tx) =>
      tx.membershipTier.create({
        data: {
          tenantId,
          name,
          description: description ?? null,
          pricePence,
          currency,
          billingCycle,
          maxClassesPerWeek: maxClassesPerWeek ?? null,
          isKids,
          stripePriceId: stripePriceId ?? null,
          stripeProductId: stripeProductId ?? null,
        },
      }),
    );

    await logAudit({
      tenantId,
      userId,
      action: "membership.tier.create",
      entityType: "MembershipTier",
      entityId: tier.id,
      metadata: { name, pricePence, billingCycle, isKids, hasStripePriceId: !!stripePriceId },
      req,
    });

    return NextResponse.json(tier, { status: 201 });
  } catch (e) {
    return apiError("Failed to create membership tier", 500, e, "[memberships POST]");
  }
}
