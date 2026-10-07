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
import { requireStepUp, stepUpTarget } from "@/lib/operator-step-up";
import { emailField } from "@/lib/email-normalise";
import {
  LOGIN_EMAIL_REASON_MIN,
  emailDigest,
  isLoginEmailProvisional,
  loginEmailTaken,
  retireEmailBoundTokens,
} from "@/lib/login-email";

export const runtime = "nodejs";

const reason = z.string().trim().min(LOGIN_EMAIL_REASON_MIN).max(500);
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark_provisional"), reason }),
  z.object({ action: z.literal("clear_provisional"), reason, attestMailboxVerified: z.literal(true) }),
  z.object({ action: z.literal("change"), reason, newEmail: emailField(120) }),
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
    return NextResponse.json({ error: "That is already the owner's login email." }, { status: 400 });
  }

  // Fresh operator re-authentication bound to THIS sub-action on THIS owner
  // (review defect 7): a grant bought to mark provisional cannot be spent on a
  // change. The shared-secret sentinel (no named operator) is refused here.
  const stepUp = await requireStepUp(req, ctx, "owner.login_email", stepUpTarget(tenantId, owner.id, body.action));
  if (stepUp) return stepUp;

  const now = new Date();
  try {
    const result = await withRlsBypass(async (tx) => {
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
          metadata: { reason: body.reason, emailSha256: emailDigest(owner.email), retired },
          actAsUserId: ctx.operatorId,
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
          },
          actAsUserId: ctx.operatorId,
          req,
        });
        return { email: owner.email, provisional: false };
      }

      // change
      if (await loginEmailTaken(tx, { tenantId, userId: owner.id, email: body.newEmail })) throw new Collision();
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
        },
        actAsUserId: ctx.operatorId,
        req,
      });
      return { email: body.newEmail, provisional: true };
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof StaleOwnerEmail) {
      return NextResponse.json(
        { error: "The owner's login email changed while you were working, so nothing was changed. Reload the page and check it." },
        { status: 409 },
      );
    }
    if (err instanceof Collision || (err as { code?: string })?.code === "P2002") {
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
