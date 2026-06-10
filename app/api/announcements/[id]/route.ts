import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";
import { del } from "@vercel/blob";

const updateSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  body: z.string().min(1).max(2000).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canEdit = ["owner", "manager"].includes(session.user.role);
  if (!canEdit) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  }

  try {
    const updated = await withTenantContext(session.user.tenantId, async (tx) => {
      const r = await tx.announcement.updateMany({
        where: { id, tenantId: session.user.tenantId },
        data: parsed.data,
      });
      if (r.count === 0) return null;
      return tx.announcement.findFirst({ where: { id, tenantId: session.user.tenantId } });
    });
    if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "announcement.updated",
      entityType: "Announcement",
      entityId: id,
      metadata: { fields: Object.keys(parsed.data) },
      req,
    });

    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canDelete = ["owner", "manager"].includes(session.user.role);
  if (!canDelete) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  try {
    // Read imageUrl before deleting so we can clean up the blob
    const existing = await withTenantContext(session.user.tenantId, (tx) =>
      tx.announcement.findFirst({
        where: { id, tenantId: session.user.tenantId },
        select: { imageUrl: true },
      }),
    );

    const result = await withTenantContext(session.user.tenantId, (tx) =>
      tx.announcement.deleteMany({ where: { id, tenantId: session.user.tenantId } }),
    );

    if (result.count === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (existing?.imageUrl && /blob\.vercel-storage\.com/.test(existing.imageUrl)) {
      try {
        await del(existing.imageUrl);
      } catch (e) {
        console.warn("[announcements/delete] orphan blob cleanup failed:", e);
      }
    }

    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "announcement.deleted",
      entityType: "Announcement",
      entityId: id,
      metadata: null,
      req,
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}
