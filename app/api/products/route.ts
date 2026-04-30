import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireStaff, requireOwnerOrManager } from "@/lib/authz";
import { apiError } from "@/lib/api-error";

const CATEGORIES = ["clothing", "food", "drink", "equipment", "other"] as const;

const createSchema = z.object({
  name: z.string().min(1).max(120),
  pricePence: z.number().int().min(0).max(1_000_000),
  category: z.enum(CATEGORIES),
  symbol: z.string().max(8).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  inStock: z.boolean().optional().default(true),
});

// GET /api/products — list all non-deleted products for the staff's tenant.
export async function GET() {
  const { tenantId } = await requireStaff();
  const products = await prisma.product.findMany({
    where: { tenantId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(products);
}

// POST /api/products — owner/manager only.
export async function POST(req: NextRequest) {
  const { tenantId } = await requireOwnerOrManager();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid product", details: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const created = await prisma.product.create({
      data: { tenantId, ...parsed.data },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return apiError("Failed to create product", 500, err, "[products.POST]");
  }
}
