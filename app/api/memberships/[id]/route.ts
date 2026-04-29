import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  pricePence: z.number().int().min(0).optional(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/).optional(),
  billingCycle: z.enum(["monthly", "annual", "none"]).optional(),
  maxClassesPerWeek: z.number().int().min(1).max(30).optional().nullable(),
  isKids: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { tenantId, userId } = await requireOwner();
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

    const updated = await prisma.membershipTier.updateMany({
      where: { id, tenantId },
      data: parsed.data as Record<string, unknown>,
    });

    if (updated.count === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await logAudit({
      tenantId,
      userId,
      action: "membership.tier.update",
      entityType: "MembershipTier",
      entityId: id,
      metadata: { fields: Object.keys(parsed.data) },
      req,
    });

    const fresh = await prisma.membershipTier.findFirst({ where: { id, tenantId } });
    return NextResponse.json(fresh);
  } catch (e) {
    return apiError("Failed to update membership tier", 500, e, "[memberships PATCH]");
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { tenantId, userId } = await requireOwner();
    const { id } = await params;

    // Confirm the tier belongs to this tenant before soft-deleting
    const existing = await prisma.membershipTier.findFirst({ where: { id, tenantId } });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await prisma.membershipTier.update({
      where: { id },
      data: { isActive: false },
    });

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
