// POST /api/admin/customers/[id]/totp-reset
// Disables TOTP on the gym owner's account. They'll be forced to re-enrol
// on their next successful login (the existing /login/totp/setup flow).
//
// Why this exists: owner loses phone / authenticator app. The regular
// /api/auth/totp/disable endpoint rejects owners by design — TOTP is
// mandatory for owners. This is the documented operator escape hatch.

import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { isAdminAuthed } from "@/lib/admin-auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { getOperatorContext } from "@/lib/operator-context";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

const bodySchema = z.object({
  reason: z.string().min(5).max(500),
  confirmName: z.string().min(1),
});

// Audit iter-1-operator-admin A6I1-S-5: rate-limit destructive admin ops.
const RL_MAX = 20;
const RL_WINDOW_MS = 60 * 60 * 1000;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthed(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const ctx = await getOperatorContext(req);
  const rl = await checkRateLimit(`admin:tenant-action:${ctx.operatorId}:${getClientIp(req)}`, RL_MAX, RL_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many admin actions. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const { id: tenantId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Reason and confirmName required" }, { status: 400 });

  const tenant = await withRlsBypass((tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } }));
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  if (parsed.data.confirmName.trim() !== tenant.name) {
    return NextResponse.json({ error: "Gym name confirmation does not match" }, { status: 400 });
  }

  const owner = await withRlsBypass((tx) =>
    tx.user.findFirst({
      where: { tenantId, role: "owner" },
      select: { id: true, email: true, name: true, totpEnabled: true },
      orderBy: { createdAt: "asc" },
    }),
  );
  if (!owner) return NextResponse.json({ error: "No owner on this tenant" }, { status: 404 });

  await withRlsBypass((tx) =>
    tx.user.update({
      where: { id: owner.id },
      data: {
        totpEnabled: false,
        totpSecret: null,
        // Audit iter-1-member-lifecycle A3H-4: `undefined` is a Prisma no-op
        // — old recovery codes survive a TOTP reset and remain valid against
        // the re-enrolled TOTP. Use `Prisma.JsonNull` (the sentinel for
        // nullable JSON columns) to actually clear the array.
        totpRecoveryCodes: Prisma.JsonNull,
        sessionVersion: { increment: 1 },
      },
    }),
  );

  await logAudit({
    tenantId,
    userId: owner.id,
    action: "admin.owner.totp_reset",
    entityType: "User",
    entityId: owner.id,
    metadata: {
      reason: parsed.data.reason,
      ownerEmail: owner.email,
      wasEnrolled: owner.totpEnabled,
    },
    actAsUserId: ctx.operatorId,
    req,
  });

  return NextResponse.json({
    ok: true,
    ownerEmail: owner.email,
    ownerName: owner.name,
    message: "TOTP disabled. Owner will be prompted to re-enrol on next login.",
  });
}
