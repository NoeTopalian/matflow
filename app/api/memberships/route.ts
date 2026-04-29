import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner, requireOwnerOrManager } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  pricePence: z.number().int().min(0),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/),
  billingCycle: z.enum(["monthly", "annual", "none"]),
  maxClassesPerWeek: z.number().int().min(1).max(30).optional(),
  isKids: z.boolean(),
});

export async function GET() {
  try {
    const { tenantId } = await requireOwnerOrManager();
    const tiers = await prisma.membershipTier.findMany({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json(tiers);
  } catch (e) {
    return apiError("Failed to load membership tiers", 500, e, "[memberships GET]");
  }
}

export async function POST(req: Request) {
  try {
    const { tenantId, userId } = await requireOwner();

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

    const { name, description, pricePence, currency, billingCycle, maxClassesPerWeek, isKids } = parsed.data;

    const tier = await prisma.membershipTier.create({
      data: {
        tenantId,
        name,
        description: description ?? null,
        pricePence,
        currency,
        billingCycle,
        maxClassesPerWeek: maxClassesPerWeek ?? null,
        isKids,
      },
    });

    await logAudit({
      tenantId,
      userId,
      action: "membership.tier.create",
      entityType: "MembershipTier",
      entityId: tier.id,
      metadata: { name, pricePence, billingCycle, isKids },
      req,
    });

    return NextResponse.json(tier, { status: 201 });
  } catch (e) {
    return apiError("Failed to create membership tier", 500, e, "[memberships POST]");
  }
}
