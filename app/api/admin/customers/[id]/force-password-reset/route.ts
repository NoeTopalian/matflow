// POST /api/admin/customers/[id]/force-password-reset
// Resets the owner's password to a freshly-generated temp value, clears the
// lockout, bumps sessionVersion (kicks every existing JWT). The temp password
// is returned ONCE in the response — operator copies it and shares it with
// the gym owner via whatever support channel they already have.

import { NextResponse } from "next/server";
import { emailDigest } from "@/lib/login-email";
import { z } from "zod";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
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
import { tempPasswordExpiresAt as tempPasswordDeadline } from "@/lib/temp-password";

export const runtime = "nodejs";

const bodySchema = z.object({ reason: z.string().min(5).max(500) });

// The temporary password expires after lib/temp-password's TTL (72 h, 6 Oct
// 2026): after that the owner cannot sign in with it and /api/auth/set-password
// refuses it — the operator issues a new one.

// Audit iter-1-operator-admin A6I1-S-5: rate-limit destructive admin ops.
const RL_MAX = 20;
const RL_WINDOW_MS = 60 * 60 * 1000;

function makeTempPassword(): string {
  // 12-char base32-ish; readable, no ambiguous characters.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = randomBytes(12);
  return Array.from(buf, (b) => alphabet[b % alphabet.length]).join("");
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
  if (!parsed.success) return NextResponse.json({ error: "Reason required (min 5 chars)" }, { status: 400 });

  // Harmless preflight first: a 404 here costs the operator nothing.
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

  // Fresh operator re-authentication bound to THIS action on THIS club, this
  // operator session and the owner's credential version (lib/operator-step-up.ts).
  // Verified here, spent inside the transaction below.
  const stepUp = await requireStepUp(req, ctx, "owner.force_password_reset", stepUpTarget(tenantId), { change: {} });
  if (stepUp instanceof Response) return stepUp;

  const tempPassword = makeTempPassword();
  const hash = bcrypt.hashSync(tempPassword, 12);
  const tempPasswordExpiresAt = tempPasswordDeadline();

  // ONE transaction: the grant is spent, the owner re-checked (the version the
  // grant carries includes the owner's id and sessionVersion), the password
  // reset, and the audit row written (operator audit 5 Oct 2026, Q9-2; lane C
  // 9 Oct 2026). If any of it fails nothing changes, the grant stays unspent,
  // and no temporary password leaves this route.
  //
  // The temporary password is the one effect outside the database: it exists
  // only in this response. A lost response leaves the owner with a reset they
  // cannot use (72-hour expiry, must-change) — a replay of the same grant is
  // answered "already applied" WITHOUT the password, and the operator issues a
  // new reset with a new code. Never a second reset from one grant.
  let outcome: { replay: Record<string, unknown> } | { sessionVersionAfter: number | null };
  try {
    outcome = await withRlsBypass(async (tx) => {
      const spend = await consumeStepUpGrant(tx, stepUp, { replayActions: ["admin.owner.force_password_reset"] });
      if (spend.kind === "replay") return { replay: spend.outcome };
      // Keep the password being replaced in history, so the owner cannot choose
      // it again on /set-password — the page promises "not one you have used"
      // (verifier lane 1, 30 Sep 2026: the old password was accepted because
      // only the temporary one was in history).
      const current = await tx.user.findUnique({ where: { id: owner.id }, select: { passwordHash: true } });
      if (current?.passwordHash) {
        await tx.passwordHistory.create({ data: { userId: owner.id, passwordHash: current.passwordHash } });
      }
      const updated = await tx.user.update({
        where: { id: owner.id },
        data: {
          passwordHash: hash,
          failedLoginCount: 0,
          lockedUntil: null,
          sessionVersion: { increment: 1 },
          // F-3: the owner chooses their own password at the next sign-in.
          mustChangePassword: true,
          tempPasswordExpiresAt,
        },
        select: { sessionVersion: true },
      });
      const sessionVersionAfter = typeof updated?.sessionVersion === "number" ? updated.sessionVersion : null;
      await logAudit({
        tx,
        tenantId,
        userId: owner.id,
        action: "admin.owner.force_password_reset",
        entityType: "User",
        entityId: owner.id,
        metadata: {
          reason: parsed.data.reason,
          // Keyed digest, never the address (ledger AH-03 proposal, 9 Oct 2026).
          ownerEmailDigest: emailDigest(owner.email),
          tempPasswordExpiresAt: tempPasswordExpiresAt.toISOString(),
          stepUp: true,
          // The minimal result a replay of this grant echoes (never the password).
          result: { ownerId: owner.id, tempPasswordExpiresAt: tempPasswordExpiresAt.toISOString(), sessionVersionAfter },
        },
        actAsUserId: ctx.operatorId,
        operatorId: stepUp.operatorId,
        requestId: stepUp.requestId,
        req,
      });
      return { sessionVersionAfter };
    });
  } catch (err) {
    if (err instanceof StepUpRefusedError) return refuseStepUp(err, req);
    console.error("[force-password-reset] reset or audit write failed; nothing changed", err);
    return NextResponse.json(
      { error: "The reset could not be recorded, so nothing was changed. Try again with a new authenticator code." },
      { status: 500 },
    );
  }

  if ("replay" in outcome) {
    return NextResponse.json({
      ok: true,
      alreadyApplied: true,
      ...outcome.replay,
      message:
        "This reset was already applied with this confirmation. The temporary password cannot be shown again; " +
        "if it was lost, issue a new reset with a new authenticator code.",
    });
  }

  return NextResponse.json({
    ok: true,
    ownerEmail: owner.email,
    ownerName: owner.name,
    tempPassword,
    tempPasswordExpiresAt: tempPasswordExpiresAt.toISOString(),
    message: "Password reset. Share the temporary password with the owner through the channel you verified — it won't be shown again and it stops working after 72 hours. They will be asked to choose their own password when they sign in.",
  });
}
