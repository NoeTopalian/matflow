// POST /api/admin/customers/[id]/force-password-reset
// Resets the owner's password to a freshly-generated temp value, clears the
// lockout, bumps sessionVersion (kicks every existing JWT). The temp password
// is returned ONCE in the response — operator copies it and shares it with
// the gym owner via whatever support channel they already have.

import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { isAdminAuthed } from "@/lib/admin-auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { getOperatorContext } from "@/lib/operator-context";

export const runtime = "nodejs";

const bodySchema = z.object({ reason: z.string().min(5).max(500) });

function makeTempPassword(): string {
  // 12-char base32-ish; readable, no ambiguous characters.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = randomBytes(12);
  return Array.from(buf, (b) => alphabet[b % alphabet.length]).join("");
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthed(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: tenantId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Reason required (min 5 chars)" }, { status: 400 });

  const tenant = await withRlsBypass((tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } }));
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  const owner = await withRlsBypass((tx) =>
    tx.user.findFirst({
      where: { tenantId, role: "owner" },
      select: { id: true, email: true, name: true },
      orderBy: { createdAt: "asc" },
    }),
  );
  if (!owner) return NextResponse.json({ error: "No owner on this tenant" }, { status: 404 });

  const tempPassword = makeTempPassword();
  const hash = bcrypt.hashSync(tempPassword, 12);

  await withRlsBypass((tx) =>
    tx.user.update({
      where: { id: owner.id },
      data: {
        passwordHash: hash,
        failedLoginCount: 0,
        lockedUntil: null,
        sessionVersion: { increment: 1 },
      },
    }),
  );

  const ctx = await getOperatorContext(req);
  await logAudit({
    tenantId,
    userId: owner.id,
    action: "admin.owner.force_password_reset",
    entityType: "User",
    entityId: owner.id,
    metadata: { reason: parsed.data.reason, ownerEmail: owner.email },
    actAsUserId: ctx.operatorId,
    req,
  });

  return NextResponse.json({
    ok: true,
    ownerEmail: owner.email,
    ownerName: owner.name,
    tempPassword,
    message: "Password reset. Share the temp password with the owner via your support channel — it won't be shown again.",
  });
}
