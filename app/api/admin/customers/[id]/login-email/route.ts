// POST /api/admin/customers/[id]/login-email
//
// Operator control over the club OWNER's login email (7 Oct 2026). Three actions:
//
//   mark_provisional  — the address is a login identifier only, not a proven
//                       mailbox: no reset code, sign-in link or external sign-in
//                       reaches it (lib/login-email.ts). Outstanding reset codes
//                       and sign-in links for it are retired.
//   clear_provisional — the operator ATTESTS that they verified the owner controls
//                       the mailbox themselves. With email delivery off there is
//                       no verification flow, so this is the operator's word only,
//                       and the audit row says so. The reason must say how.
//   change            — set a new login email. An address typed by an operator
//                       proves nothing about who reads it, so the new address is
//                       provisional too. Same user id, role, tenant, password,
//                       authenticator and recovery codes; every session is signed
//                       out; tokens for the old and new address are retired.
//
// Each: named MFA operator, same-origin, rate limit, a step-up grant bound to
// "owner.login_email" on THIS club's THIS owner for THIS sub-action, a reason
// of at least 10 characters, and the audit row in the same transaction as the
// change. A change is conditional on the address the route read (409 if it
// moved in between).

import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed } from "@/lib/admin-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { getOperatorContext } from "@/lib/operator-context";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  STEP_UP_HEADER,
  StepUpRefusedError,
  consumeStepUpGrant,
  findAppliedGrant,
  refuseStepUp,
  requireStepUp,
  stepUpTarget,
  verifyStepUpGrantToken,
} from "@/lib/operator-step-up";
import { sha256Hex } from "@/lib/operator-auth";
import { emailField } from "@/lib/email-normalise";
import {
  LOGIN_EMAIL_REASON_MIN,
  emailDigest,
  isLoginEmailProvisional,
  LoginIdentityTaken,
  claimLoginIdentity,
  retireEmailBoundTokens,
} from "@/lib/login-email";

export const runtime = "nodejs";

const CHANGED_ACTION = "admin.owner.login_email.changed";

/**
 * The recorded result of THIS operator's change grant for THIS owner, if its
 * change committed. The grant's signature binds the operator, action and
 * target; its nonce hash is the outcome row's request id. Nothing is verified
 * as spendable and nothing is spent.
 */
async function appliedOwnerOutcome(req: Request, operatorId: string, tenantId: string, target: string) {
  const token = req.headers.get(STEP_UP_HEADER);
  const payload = token ? verifyStepUpGrantToken(token) : null;
  if (!payload || payload.op !== operatorId || payload.act !== "owner.login_email" || payload.tgt !== target) return null;
  return withRlsBypass((tx) => findAppliedGrant(tx, { tenantId, actions: [CHANGED_ACTION], requestId: sha256Hex(payload.n) }));
}

const reason = z.string().trim().min(LOGIN_EMAIL_REASON_MIN).max(500);
const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("mark_provisional"), reason }),
  z.strictObject({ action: z.literal("clear_provisional"), reason, attestMailboxVerified: z.literal(true) }),
  z.strictObject({ action: z.literal("change"), reason, newEmail: emailField(120) }),
]);

// Same budget as the other Danger Zone actions (A6I1-S-5).
const RL_MAX = 20;
const RL_WINDOW_MS = 60 * 60 * 1000;

class Collision extends Error {}
class StaleOwnerEmail extends Error {}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
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
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Choose an action and give a reason of at least ${LOGIN_EMAIL_REASON_MIN} characters.` },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const owner = await withRlsBypass((tx) =>
    tx.user.findFirst({
      where: { tenantId, role: "owner" },
      select: { id: true, email: true, loginEmailProvisionalSince: true },
      orderBy: { createdAt: "asc" },
    }),
  );
  if (!owner) return NextResponse.json({ error: "No owner on this tenant" }, { status: 404 });

  // State checks that need no secret come BEFORE the grant is spent, so a
  // mistaken click does not cost the operator a fresh code.
  if (body.action === "clear_provisional" && !isLoginEmailProvisional(owner)) {
    return NextResponse.json({ error: "The login email is not marked provisional." }, { status: 409 });
  }
  if (body.action === "change" && body.newEmail === owner.email) {
    // A lost response: the change committed, the operator re-sends the SAME
    // grant, and the address is now the owner's. Answered from the record —
    // read only, nothing spent (browser rehearsal AH-G1; mirrors the member
    // contact-email route). Without a grant for this change it stays a 400.
    const applied = await appliedOwnerOutcome(req, ctx.operatorId, tenantId, stepUpTarget(tenantId, owner.id, "change"));
    if (applied) return NextResponse.json({ ok: true, alreadyApplied: true, ...applied });
    return NextResponse.json({ error: "That is already the owner's login email." }, { status: 400 });
  }

  // Fresh operator re-authentication bound to THIS sub-action on THIS owner
  // (review defect 7): a grant bought to mark provisional cannot be spent on a
  // change. The shared-secret sentinel (no named operator) is refused here.
  // Since lane C (9 Oct 2026) the grant is also bound to this operator
  // session, the canonical change (the normalised new address, or nothing)
  // and the owner's address/provisional state as confirmed; it is VERIFIED
  // here and SPENT inside the transaction below, so a collision, a stale
  // address or a failed audit row rolls the spend back with the change.
  const stepUp = await requireStepUp(req, ctx, "owner.login_email", stepUpTarget(tenantId, owner.id, body.action), {
    change: body.action === "change" ? { newEmail: body.newEmail } : {},
  });
  if (stepUp instanceof Response) return stepUp;
  const correlation = { operatorId: stepUp.operatorId, requestId: stepUp.requestId };

  const now = new Date();
  try {
    const result = await withRlsBypass(async (tx) => {
      const spend = await consumeStepUpGrant(tx, stepUp, {
        replayActions: [
          "admin.owner.login_email.marked_provisional",
          "admin.owner.login_email.cleared_provisional",
          "admin.owner.login_email.changed",
        ],
      });
      if (spend.kind === "replay") return { alreadyApplied: true, ...spend.outcome };
      if (body.action === "mark_provisional") {
        await tx.user.update({
          where: { id: owner.id },
          data: { loginEmailProvisionalSince: owner.loginEmailProvisionalSince ?? now },
        });
        const retired = await retireEmailBoundTokens(tx, { tenantId, emails: [owner.email] });
        await logAudit({
          tx,
          tenantId,
          userId: owner.id,
          action: "admin.owner.login_email.marked_provisional",
          entityType: "User",
          entityId: owner.id,
          metadata: { reason: body.reason, emailSha256: emailDigest(owner.email), retired, result: { provisional: true } },
          actAsUserId: ctx.operatorId,
          ...correlation,
          req,
        });
        return { email: owner.email, provisional: true };
      }

      if (body.action === "clear_provisional") {
        await tx.user.update({ where: { id: owner.id }, data: { loginEmailProvisionalSince: null } });
        await logAudit({
          tx,
          tenantId,
          userId: owner.id,
          action: "admin.owner.login_email.cleared_provisional",
          entityType: "User",
          entityId: owner.id,
          metadata: {
            reason: body.reason,
            // No verification email exists while delivery is off: this is the
            // operator's own attestation that they verified the mailbox.
            verification: "operator_attestation",
            emailSha256: emailDigest(owner.email),
            provisionalSince: owner.loginEmailProvisionalSince?.toISOString() ?? null,
            result: { provisional: false },
          },
          actAsUserId: ctx.operatorId,
          ...correlation,
          req,
        });
        return { email: owner.email, provisional: false };
      }

      // change
      // Cross-table claim lock (lib/login-email.ts, AH-01): held to commit.
      const claim = await claimLoginIdentity(tx, { tenantId, email: body.newEmail, exclude: { userId: owner.id } });
      if (claim.kind !== "none") throw new LoginIdentityTaken(claim);
      // Conditional on the address read above (review defect 6): if the owner
      // changed it themselves in between, this change does not overwrite it
      // and the stale address's tokens are not the ones retired.
      const changed = await tx.user.updateMany({
        where: { id: owner.id, tenantId, email: owner.email },
        data: {
          email: body.newEmail,
          loginEmailProvisionalSince: now,
          sessionVersion: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw new StaleOwnerEmail();
      const retired = await retireEmailBoundTokens(tx, { tenantId, emails: [owner.email, body.newEmail] });
      await logAudit({
        tx,
        tenantId,
        userId: owner.id,
        action: "admin.owner.login_email.changed",
        entityType: "User",
        entityId: owner.id,
        metadata: {
          reason: body.reason,
          oldEmailSha256: emailDigest(owner.email),
          newEmailSha256: emailDigest(body.newEmail),
          provisional: true,
          retired,
          result: { provisional: true },
        },
        actAsUserId: ctx.operatorId,
        ...correlation,
        req,
      });
      return { email: body.newEmail, provisional: true };
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof StepUpRefusedError) return refuseStepUp(err, req);
    if (err instanceof StaleOwnerEmail) {
      return NextResponse.json(
        { error: "The owner's login email changed while you were working, so nothing was changed. Reload the page and check it." },
        { status: 409 },
      );
    }
    // Operators only: two rows already hold this address (a legacy duplicate
    // written before the claim lock). Never resolved by picking one.
    if (err instanceof LoginIdentityTaken && err.claim.kind === "many") {
      return NextResponse.json(
        { error: "Two or more accounts in this club already hold that address (a legacy duplicate). Review them before using it; nothing was changed.", result: "legacy_duplicate" },
        { status: 409 },
      );
    }
    if (err instanceof Collision || err instanceof LoginIdentityTaken || (err as { code?: string })?.code === "P2002") {
      return NextResponse.json(
        { error: "That address cannot be used as this owner's login email." },
        { status: 409 },
      );
    }
    console.error("[login-email] change or audit write failed; nothing changed", err);
    return NextResponse.json(
      { error: "The change could not be recorded, so nothing was changed. Try again with a new authenticator code." },
      { status: 500 },
    );
  }
}
