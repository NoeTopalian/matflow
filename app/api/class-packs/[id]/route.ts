import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";

// Name, description and the on-sale switch only. Credits, price and validity
// are fixed when the product is created (owner decision, 27 Oct 2026: "Later
// product edits must not silently rewrite sold entitlements"); a validityDays
// sent here is stripped by zod. This route touches ClassPack alone: every sold
// MemberClassPack keeps the expiresAt and credits it was sold with, and no
// edit re-sends anything to Stripe.
const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  const { id } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });

  const fresh = await withTenantContext(tenantId, async (tx) => {
    const u = await tx.classPack.updateMany({
      where: { id, tenantId },
      data: parsed.data as Record<string, unknown>,
    });
    if (u.count === 0) return null;
    return tx.classPack.findFirst({ where: { id, tenantId } });
  });
  if (!fresh) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await logAudit({
    tenantId, userId,
    action: "class_pack.update",
    entityType: "ClassPack",
    entityId: id,
    metadata: { fields: Object.keys(parsed.data) },
    req,
  });

  return NextResponse.json(fresh);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  const { id } = await params;

  // Soft-deactivate rather than hard-delete so existing MemberClassPack rows keep their FK
  const updated = await withTenantContext(tenantId, (tx) =>
    tx.classPack.updateMany({
      where: { id, tenantId },
      data: { isActive: false },
    }),
  );
  if (updated.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await logAudit({
    tenantId, userId,
    action: "class_pack.deactivate",
    entityType: "ClassPack",
    entityId: id,
    req,
  });

  return NextResponse.json({ ok: true });
}
