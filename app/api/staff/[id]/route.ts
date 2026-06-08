import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { logAudit } from "@/lib/audit-log";
import { stripTotpFields } from "@/lib/totp-immutable";
import { assertSameOrigin } from "@/lib/csrf";

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().max(254).optional(),
  role: z.enum(["manager", "coach", "admin"]).optional(),
  newPassword: z.string().min(8).optional(),
  // Sprint 5 US-508: optimistic concurrency precondition.
  updatedAt: z.string().optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  // Lane 1 iter-1 S-03 fix: CSRF guard.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isOwner = session.user.role === "owner";
  if (!isOwner) return NextResponse.json({ error: "Only owners can edit staff" }, { status: 403 });

  const { id } = await params;

  let body: unknown;
  try {
    // Defence in depth: strip TOTP fields. The Zod schema is already an
    // allowlist that doesn't include them, but stripping early documents
    // the no-self-disable invariant at the route entry point.
    body = stripTotpFields(await req.json() as Record<string, unknown>);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  const { newPassword, updatedAt: clientUpdatedAt, ...rest } = parsed.data;
  const data: Record<string, unknown> = { ...rest };
  if (newPassword) {
    data.passwordHash = await bcrypt.hash(newPassword, 12);
  }
  // Bump sessionVersion when role, email OR password changes. Lane 1 iter-1
  // S-30 [High] fix: previously the bump only fired on role/email changes —
  // a forced password reset left existing JWTs valid until expiry, which
  // defeats the point of the reset on suspected compromise. Mirrors
  // app/api/admin/customers/[id]/force-password-reset/route.ts:71.
  if (
    typeof rest.role === "string" ||
    typeof rest.email === "string" ||
    newPassword
  ) {
    data.sessionVersion = { increment: 1 };
  }

  // Optimistic concurrency precondition (US-508): refuse the write if the
  // row's updatedAt has moved since the client last loaded it.
  const concurrencyGuard = clientUpdatedAt ? { updatedAt: new Date(clientUpdatedAt) } : {};

  try {
    const result = await withTenantContext(session.user.tenantId, async (tx) => {
      // Email-edit path: before writing, verify the target email isn't already
      // owned by ANOTHER staff user in this tenant. The DB-level
      // @@unique([tenantId, email]) would catch it too, but doing it in the
      // same transaction lets us return a friendly 409 instead of a raw
      // PrismaClientKnownRequestError P2002.
      if (typeof rest.email === "string") {
        const collision = await tx.user.findFirst({
          where: {
            tenantId: session.user.tenantId,
            email: rest.email,
            id: { not: id },
          },
          select: { id: true },
        });
        if (collision) return { updated: null, existing: null, conflict: "email" as const };
      }
      const r = await tx.user.updateMany({
        where: { id, tenantId: session.user.tenantId, role: { not: "owner" }, ...concurrencyGuard },
        data,
      });
      if (r.count === 0) {
        const existing = await tx.user.findFirst({
          where: { id, tenantId: session.user.tenantId, role: { not: "owner" } },
          select: { updatedAt: true },
        });
        return { updated: null, existing, conflict: null as null };
      }
      const fresh = await tx.user.findFirst({ where: { id, tenantId: session.user.tenantId }, select: { id: true, name: true, email: true, role: true } });
      return { updated: fresh, existing: null, conflict: null as null };
    });
    if (result.conflict === "email") {
      return NextResponse.json(
        { error: "Email already in use by another staff member" },
        { status: 409 },
      );
    }
    if (!result.updated) {
      if (!result.existing) return NextResponse.json({ error: "Not found or cannot edit owner" }, { status: 404 });
      if (clientUpdatedAt) {
        return NextResponse.json(
          { error: "This staff member was updated by someone else. Reload and try again.", currentUpdatedAt: result.existing.updatedAt.toISOString() },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: "Not found or cannot edit owner" }, { status: 404 });
    }
    const user = result.updated;
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "staff.update",
      entityType: "User",
      entityId: id,
      metadata: { fields: Object.keys(parsed.data) },
      req,
    });
    return NextResponse.json(user);
  } catch {
    return NextResponse.json({ error: "Failed to update staff" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: Params) {
  // Lane 1 iter-1 S-03 fix: CSRF guard.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isOwner = session.user.role === "owner";
  if (!isOwner) return NextResponse.json({ error: "Only owners can remove staff" }, { status: 403 });

  const { id } = await params;

  // Cannot delete yourself
  if (id === session.user.id) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  }

  try {
    const deleted = await withTenantContext(session.user.tenantId, (tx) =>
      tx.user.deleteMany({
        where: { id, tenantId: session.user.tenantId, role: { not: "owner" } },
      }),
    );
    if (deleted.count === 0) return NextResponse.json({ error: "Not found or cannot delete owner" }, { status: 404 });
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "staff.delete",
      entityType: "User",
      entityId: id,
      req,
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to remove staff member" }, { status: 500 });
  }
}
