// POST /api/admin/customers/[id]/transfer-ownership
// Transfers the owner role from the current owner to a target user already
// in the tenant (manager / coach / admin). The current owner is demoted to
// manager. Both users get sessionVersion bumped to kick existing JWTs.
//
// Inviting a fresh user via email is intentionally out of scope here — the
// target must already exist on the tenant. Add via the dashboard first.
//
// GET /api/admin/customers/[id]/transfer-ownership
// Returns candidate target users (anyone on the tenant who isn't the
// current owner) so the operator UI can render a picker.

import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed } from "@/lib/admin-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { emailDigest } from "@/lib/login-email";
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
  targetUserId: z.string().min(1),
  reason: z.string().min(5).max(500),
  confirmName: z.string().min(1),
});

// Audit iter-1-operator-admin A6I1-S-5: rate-limit destructive admin ops.
const RL_MAX = 20;
const RL_WINDOW_MS = 60 * 60 * 1000;

/** A refusal decided inside the transaction: thrown so the grant's spend rolls back. */
class Refusal extends Error {
  constructor(readonly status: number, readonly error: string) { super(error); }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthed(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: tenantId } = await params;
  const users = await withRlsBypass((tx) =>
    tx.user.findMany({
      where: { tenantId, role: { not: "owner" } },
      select: { id: true, email: true, name: true, role: true, totpEnabled: true },
      orderBy: { createdAt: "asc" },
    }),
  );
  return NextResponse.json({ candidates: users });
}

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
  if (!parsed.success) return NextResponse.json({ error: "targetUserId, reason, confirmName required" }, { status: 400 });

  const tenant = await withRlsBypass((tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } }));
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  if (parsed.data.confirmName.trim() !== tenant.name) {
    return NextResponse.json({ error: "Gym name confirmation does not match" }, { status: 400 });
  }

  // Fresh operator re-authentication bound to THIS club AND this new owner (a
  // grant to hand the club to one person cannot hand it to another), this
  // operator session and the version of both people. Verified after the
  // harmless preflight above; spent inside the transaction below, where the
  // 404/400 refusals roll the spend back.
  const stepUp = await requireStepUp(
    req,
    ctx,
    "tenant.transfer_ownership",
    stepUpTarget(tenantId, parsed.data.targetUserId),
    { change: {} },
  );
  if (stepUp instanceof Response) return stepUp;

  // Audit iter-1-operator-admin A6I1-V-2 + S-9: collapse the read of
  // currentOwner+target and the role swap into ONE withRlsBypass block.
  // The prior shape did the read in one transaction and the write in
  // another — a concurrent operator request could change ownership in
  // the gap, leaving the tenant with two owners or zero owners. Same-
  // transaction read-then-write closes that TOCTOU window.
  //
  // The audit row is written in the same transaction too (operator audit
  // 5 Oct 2026, Q9): the ownership change commits only with its record.
  let result;
  try {
    result = await withRlsBypass(async (tx) => {
      const spend = await consumeStepUpGrant(tx, stepUp, { replayActions: ["admin.tenant.ownership_transferred"] });
      if (spend.kind === "replay") return { ok: "replay" as const, replay: spend.outcome };
      const currentOwner = await tx.user.findFirst({
        where: { tenantId, role: "owner" },
        select: { id: true, email: true, name: true },
        orderBy: { createdAt: "asc" },
      });
      const target = await tx.user.findFirst({
        where: { id: parsed.data.targetUserId, tenantId },
        select: { id: true, email: true, name: true, role: true },
      });
      // Thrown, not returned: a refusal here must roll back the grant's spend.
      if (!currentOwner) throw new Refusal(404, "Tenant has no current owner");
      if (!target) throw new Refusal(404, "Target user not found on this tenant");
      if (target.id === currentOwner.id) throw new Refusal(400, "Target is already the owner");
      await tx.user.update({
        where: { id: currentOwner.id },
        data: { role: "manager", sessionVersion: { increment: 1 } },
      });
      await tx.user.update({
        where: { id: target.id },
        data: { role: "owner", sessionVersion: { increment: 1 } },
      });
      await logAudit({
        tx,
        tenantId,
        userId: target.id,
        action: "admin.tenant.ownership_transferred",
        entityType: "Tenant",
        entityId: tenantId,
        metadata: {
          reason: parsed.data.reason,
          previousOwnerId: currentOwner.id,
          previousOwnerEmailSha256: emailDigest(currentOwner.email),
          newOwnerId: target.id,
          newOwnerEmailSha256: emailDigest(target.email),
          previousTargetRole: target.role,
          result: { previousOwnerId: currentOwner.id, newOwnerId: target.id },
        },
        actAsUserId: ctx.operatorId,
        operatorId: stepUp.operatorId,
        requestId: stepUp.requestId,
        req,
      });
      return { ok: true as const, currentOwner, target };
    });
  } catch (err) {
    if (err instanceof StepUpRefusedError) return refuseStepUp(err, req);
    if (err instanceof Refusal) return NextResponse.json({ error: err.error }, { status: err.status });
    console.error("[transfer-ownership] transfer or audit write failed; nothing changed", err);
    return NextResponse.json(
      { error: "The transfer could not be recorded, so nothing was changed. Try again with a new authenticator code." },
      { status: 500 },
    );
  }

  if (result.ok === "replay") {
    return NextResponse.json({
      ok: true,
      alreadyApplied: true,
      ...result.replay,
      message: "This ownership transfer was already applied with this confirmation. Nothing else was changed.",
    });
  }
  const { currentOwner, target } = result;

  return NextResponse.json({
    ok: true,
    previousOwner: { id: currentOwner.id, email: currentOwner.email, name: currentOwner.name },
    newOwner: { id: target.id, email: target.email, name: target.name },
    message: "Ownership transferred. Both users have been signed out and must log in again.",
  });
}
