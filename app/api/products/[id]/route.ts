import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireOwnerOrManager } from "@/lib/authz";
import { apiError } from "@/lib/api-error";

const CATEGORIES = ["clothing", "food", "drink", "equipment", "other"] as const;

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  pricePence: z.number().int().min(0).max(1_000_000).optional(),
  category: z.enum(CATEGORIES).optional(),
  symbol: z.string().max(8).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  inStock: z.boolean().optional(),
});

// PATCH /api/products/[id]
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { tenantId } = await requireOwnerOrManager();
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid update", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const updated = await withTenantContext(tenantId, async (tx) => {
      const existing = await tx.product.findFirst({
        where: { id, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!existing) return null;
      return tx.product.update({ where: { id }, data: parsed.data });
    });
    if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(updated);
  } catch (err) {
    return apiError("Failed to update product", 500, err, "[products.PATCH]");
  }
}

// DELETE /api/products/[id] — soft-delete
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { tenantId } = await requireOwnerOrManager();
  const { id } = await params;

  try {
    const ok = await withTenantContext(tenantId, async (tx) => {
      const existing = await tx.product.findFirst({
        where: { id, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!existing) return false;
      await tx.product.update({ where: { id }, data: { deletedAt: new Date() } });
      return true;
    });
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError("Failed to delete product", 500, err, "[products.DELETE]");
  }
}
