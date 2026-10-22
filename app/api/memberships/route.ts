import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiOwner, requireApiOwnerOrManager } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { billingCycleSchema } from "@/lib/billing-cycle";
import { BILLING_BASIS_AVAILABLE, BILLING_BASIS_UNAVAILABLE_MESSAGE, BILLING_ON_NONE_MESSAGE, allowanceColumns, classLimitAnchorSchema, classLimitBasisSchema, classLimitSchema, classLimitWeeksSchema, refineAllowance } from "@/lib/class-allowance";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  // A typo like 9999999999 must not become a live plan price (verifier lane 7).
  pricePence: z.number().int().min(0).max(10_000_000, "Price must be £100,000 or less"),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/),
  billingCycle: billingCycleSchema,
  // Legacy single weekly limit, still accepted from a page loaded before T7c.
  // Never together with the allowance fields (refineAllowance).
  maxClassesPerWeek: z.number().int().min(1).max(30).optional(),
  // T7c: "N classes" on an explicit reset basis (lib/class-allowance.ts):
  // limit + basis together; "weeks" also needs the weeks and the start date.
  // All null or absent = Unlimited.
  classLimit: classLimitSchema.nullable().optional(),
  classLimitBasis: classLimitBasisSchema.nullable().optional(),
  classLimitWeeks: classLimitWeeksSchema.nullable().optional(),
  classLimitAnchor: classLimitAnchorSchema.nullable().optional(),
  isKids: z.boolean(),
  // ADR-001 D2 slice 2: the venue this tier covers; null/absent = every venue.
  locationId: z.string().min(1).max(64).optional().nullable(),
  // Stripe linkage. Both optional and nullable — set later by owners who wire
  // Stripe Connect and want member-side self-subscribe (F2/F3) to pick this
  // tier server-side instead of by trust-the-client priceId. price_/prod_
  // prefixes mirror Stripe's documented id shapes.
  stripePriceId: z.string().regex(/^price_[A-Za-z0-9_]+$/).max(100).nullable().optional(),
  stripeProductId: z.string().regex(/^prod_[A-Za-z0-9_]+$/).max(100).nullable().optional(),
}).superRefine(refineAllowance);

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

    const { name, description, pricePence, currency, billingCycle, isKids, stripePriceId, stripeProductId, locationId } = parsed.data;
    const allowance = allowanceColumns(parsed.data) ?? { classLimit: null, classLimitBasis: null, classLimitWeeks: null, classLimitAnchor: null, maxClassesPerWeek: null };

    // The billing-period basis ships dark until live Stripe delivery is verified (release gate, 22 Oct 2026).
    if (allowance.classLimitBasis === "billing" && !BILLING_BASIS_AVAILABLE) {
      return NextResponse.json({ error: BILLING_BASIS_UNAVAILABLE_MESSAGE, details: { fieldErrors: { classLimitBasis: [BILLING_BASIS_UNAVAILABLE_MESSAGE] } } }, { status: 400 });
    }
    // A plan billed once has no billing period to count classes in (review round 3, L-5).
    if (allowance.classLimitBasis === "billing" && billingCycle === "none") {
      return NextResponse.json({ error: BILLING_ON_NONE_MESSAGE, details: { fieldErrors: { classLimitBasis: [BILLING_ON_NONE_MESSAGE] } } }, { status: 400 });
    }

    // A venue from another club must not attach — refused, never dropped.
    if (locationId) {
      const loc = await withTenantContext(tenantId, (tx) => tx.location.findFirst({ where: { id: locationId, tenantId }, select: { id: true } }));
      if (!loc) return NextResponse.json({ error: "That venue is not one of this club's locations" }, { status: 400 });
    }

    const tier = await withTenantContext(tenantId, (tx) =>
      tx.membershipTier.create({
        data: {
          tenantId,
          name,
          description: description ?? null,
          pricePence,
          currency,
          billingCycle,
          ...allowance,
          isKids,
          stripePriceId: stripePriceId ?? null,
          stripeProductId: stripeProductId ?? null,
          locationId: locationId ?? null,
        },
      }),
    );

    await logAudit({
      tenantId,
      userId,
      action: "membership.tier.create",
      entityType: "MembershipTier",
      entityId: tier.id,
      metadata: {
        name, pricePence, billingCycle, isKids,
        classLimit: allowance.classLimit, classLimitBasis: allowance.classLimitBasis, classLimitWeeks: allowance.classLimitWeeks,
        classLimitAnchor: allowance.classLimitAnchor ? allowance.classLimitAnchor.toISOString().slice(0, 10) : null,
        hasStripePriceId: !!stripePriceId,
      },
      req,
    });

    return NextResponse.json(tier, { status: 201 });
  } catch (e) {
    return apiError("Failed to create membership tier", 500, e, "[memberships POST]");
  }
}
