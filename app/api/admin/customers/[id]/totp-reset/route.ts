// POST /api/admin/customers/[id]/totp-reset
// Disables TOTP on the gym owner's account. They'll be forced to re-enrol
// on their next successful login (the existing /login/totp/setup flow).
//
// Why this exists: owner loses phone / authenticator app. The regular
// /api/auth/totp/disable endpoint rejects owners by design — TOTP is
// mandatory for owners. This is the documented operator escape hatch.

import { NextResponse } from "next/server";
import { emailDigest } from "@/lib/login-email";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { isAdminAuthed } from "@/lib/admin-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { getOperatorContext } from "@/lib/operator-context";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  StepUpRefusedError,
  consumeStepUpGrant,
  refuseStepUp,
  requireStepUp,
  stepUpTarget,
} from "@/lib/operator-step-up";

export const runtime = "nodejs";

const bodySchema = z.object({
  reason: z.string().min(5).max(500),
  confirmName: z.string().min(1),
});

// Audit iter-1-operator-admin A6I1-S-5: rate-limit destructive admin ops.
const RL_MAX = 20;
const RL_WINDOW_MS = 60 * 60 * 1000;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // CSRF. The operator plane was excluded from the earlier sweep on the
  // reasoning that it is token-authenticated and therefore exempt. That does
  // not hold: lib/admin-auth.ts also accepts a `matflow_admin` COOKIE, and a
  // cookie rides along on a cross-site form post. So every mutation here was
  // reachable from any page the operator happened to have open — on the most
  // powerful surface in the product.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
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

  // Fresh operator re-authentication bound to THIS action on THIS club, this
  // operator session and the owner's credential version. Checked after the
  // harmless preflight above; spent inside the transaction below.
  const stepUp = await requireStepUp(req, ctx, "owner.totp_reset", stepUpTarget(tenantId), { change: {} });
  if (stepUp instanceof Response) return stepUp;

  // ONE transaction: grant spent (and the owner's version re-checked), reset,
  // audit row (operator audit 5 Oct 2026, Q9; lane C 9 Oct 2026). An audit
  // failure rolls back the reset AND the spend.
  let replay: Record<string, unknown> | null = null;
  try {
    replay = await withRlsBypass(async (tx) => {
      const spend = await consumeStepUpGrant(tx, stepUp, { replayActions: ["admin.owner.totp_reset"] });
      if (spend.kind === "replay") return spend.outcome;
      const updated = await tx.user.update({
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
        select: { sessionVersion: true },
      });
      const sessionVersionAfter = typeof updated?.sessionVersion === "number" ? updated.sessionVersion : null;
      await logAudit({
        tx,
        tenantId,
        userId: owner.id,
        action: "admin.owner.totp_reset",
        entityType: "User",
        entityId: owner.id,
        metadata: {
          reason: parsed.data.reason,
          // Keyed digest, never the address (ledger AH-03 proposal, 9 Oct 2026).
          ownerEmailDigest: emailDigest(owner.email),
          wasEnrolled: owner.totpEnabled,
          result: { ownerId: owner.id, wasEnrolled: owner.totpEnabled, sessionVersionAfter },
        },
        actAsUserId: ctx.operatorId,
        operatorId: stepUp.operatorId,
        requestId: stepUp.requestId,
        req,
      });
      return null;
    });
  } catch (err) {
    if (err instanceof StepUpRefusedError) return refuseStepUp(err, req);
    console.error("[totp-reset] reset or audit write failed; nothing changed", err);
    return NextResponse.json(
      { error: "The reset could not be recorded, so nothing was changed. Try again with a new authenticator code." },
      { status: 500 },
    );
  }

  if (replay) {
    return NextResponse.json({
      ok: true,
      alreadyApplied: true,
      ...replay,
      message: "This 2FA reset was already applied with this confirmation. Nothing else was changed.",
    });
  }

  return NextResponse.json({
    ok: true,
    ownerEmail: owner.email,
    ownerName: owner.name,
    message: "TOTP disabled. Owner will be prompted to re-enrol on next login.",
  });
}
