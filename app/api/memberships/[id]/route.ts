import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiOwner } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { updateMetadata } from "@/lib/audit-snapshot";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { billingCycleSchema } from "@/lib/billing-cycle";
import { ALLOWANCE_FIELDS, allowanceColumns, classLimitAnchorSchema, classLimitBasisSchema, classLimitSchema, classLimitWeeksSchema, refineAllowance } from "@/lib/class-allowance";

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  pricePence: z.number().int().min(0).max(10_000_000, "Price must be £100,000 or less").optional(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/).optional(),
  billingCycle: billingCycleSchema.optional(),
  // Legacy single weekly limit (a page loaded before T7c); null clears.
  maxClassesPerWeek: z.number().int().min(1).max(30).optional().nullable(),
  // T7c: "N classes" on an explicit reset basis; limit + basis together (plus
  // weeks + start date for "weeks"); nulls clear to Unlimited
  // (refineAllowance). The route writes every allowance column in step.
  classLimit: classLimitSchema.nullable().optional(),
  classLimitBasis: classLimitBasisSchema.nullable().optional(),
  classLimitWeeks: classLimitWeeksSchema.nullable().optional(),
  classLimitAnchor: classLimitAnchorSchema.nullable().optional(),
  isKids: z.boolean().optional(),
  isActive: z.boolean().optional(),
  // ADR-001 D2 slice 2: the venue this tier covers; null = every venue.
  locationId: z.string().min(1).max(64).optional().nullable(),
  // Stripe linkage — see app/api/memberships/route.ts:createSchema.
  // Both nullable so owners can unlink a tier from Stripe later.
  stripePriceId: z.string().regex(/^price_[A-Za-z0-9_]+$/).max(100).nullable().optional(),
  stripeProductId: z.string().regex(/^prod_[A-Za-z0-9_]+$/).max(100).nullable().optional(),
}).superRefine(refineAllowance);

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  try {
    const gate = await requireApiOwner();
    if (!gate.ok) return gate.response;
    const { tenantId, userId } = gate;
    const { id } = await params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
    }

    // The allowance keys become the allowance columns, written together (a
    // reduced limit applies from the next check-in; nothing recorded changes).
    const { maxClassesPerWeek, classLimit, classLimitBasis, classLimitWeeks, classLimitAnchor, ...rest } = parsed.data;
    const allowance = allowanceColumns({ maxClassesPerWeek, classLimit, classLimitBasis, classLimitWeeks, classLimitAnchor });
    const data: Record<string, unknown> = { ...rest, ...(allowance ?? {}) };

    const outcome = await withTenantContext(tenantId, async (tx) => {
      if (parsed.data.locationId) {
        const loc = await tx.location.findFirst({ where: { id: parsed.data.locationId, tenantId }, select: { id: true } });
        if (!loc) return "bad_location" as const;
      }
      const before = await tx.membershipTier.findFirst({ where: { id, tenantId } });
      const r = await tx.membershipTier.updateMany({
        where: { id, tenantId },
        data,
      });
      if (r.count === 0) return null;
      const fresh = await tx.membershipTier.findFirst({ where: { id, tenantId } });
      return fresh ? { fresh, before } : null;
    });
    if (outcome === "bad_location") return NextResponse.json({ error: "That venue is not one of this club's locations" }, { status: 400 });
    if (!outcome) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { fresh, before } = outcome;

    await logAudit({
      tenantId,
      userId,
      action: "membership.tier.update",
      entityType: "MembershipTier",
      entityId: id,
      metadata: updateMetadata(
        Object.keys(data),
        before as unknown as Record<string, unknown> | null,
        fresh as unknown as Record<string, unknown>,
        ["name", "description", "pricePence", "currency", "billingCycle", ...ALLOWANCE_FIELDS, "isKids", "isActive", "locationId"],
      ),
      req,
    });
    return NextResponse.json(fresh);
  } catch (e) {
    return apiError("Failed to update membership tier", 500, e, "[memberships PATCH]");
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  try {
    const gate = await requireApiOwner();
    if (!gate.ok) return gate.response;
    const { tenantId, userId } = gate;
    const { id } = await params;

    const ok = await withTenantContext(tenantId, async (tx) => {
      const existing = await tx.membershipTier.findFirst({ where: { id, tenantId } });
      if (!existing) return false;
      await tx.membershipTier.update({ where: { id }, data: { isActive: false } });
      return true;
    });
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await logAudit({
      tenantId,
      userId,
      action: "membership.tier.delete",
      entityType: "MembershipTier",
      entityId: id,
      req,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError("Failed to delete membership tier", 500, e, "[memberships DELETE]");
  }
}
