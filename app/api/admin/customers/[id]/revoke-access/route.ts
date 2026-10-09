// POST /api/admin/customers/[id]/revoke-access
//
// Incident revoke-all (security campaign lane A, 9 Oct 2026; admin hub ledger
// AH-R7, catalogue SEC-013). Until this route, the only way an operator could
// throw someone out of MatFlow was as a SIDE EFFECT of something else — a
// password reset, a 2FA reset, suspending the whole club, changing the login
// address — each of which also changes something the club did not ask to
// change. An incident needs the eviction on its own.
//
// Body (strict): { scope: "user" | "member" | "club", subjectId?, reason }
//   - scope "user":   subjectId = a staff User.id IN this club;
//   - scope "member": subjectId = a Member.id IN this club;
//   - scope "club":   no subjectId — every staff user and member of the club;
//   - reason: trimmed, 10–500 characters, recorded on the audit row.
// The step-up grant (x-matflow-step-up) is bound to action "access.revoke_all",
// target stepUpTarget(tenant, subject | CLUB_REVOKE_SUBJECT, scope), change {},
// this operator session, and the subject's EXISTENCE (lib/operator-step-up.ts:
// never a session version, which the person being evicted could keep moving).
//
// ONE transaction: spend the grant (replay → the recorded result) → for every
// subject in scope, sessionVersion + 1 (auth.ts ends every JWT session at the
// next request, and a support session bound to the old version with it) →
// retire every outstanding sign-in token in scope (password-reset codes, login
// and activation links; a waiver link is not a credential) → the audit row
// with counts and the reason. Any failure rolls back all of it, the spend
// included.
//
// NEVER written: passwords, TOTP secrets, recovery codes, addresses, roles,
// memberships, the club's status. This evicts; it does not lock anyone out —
// someone who still holds the password can sign in again, which is why the
// response says so and the runbook pairs it with a reset or a suspension.

import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed } from "@/lib/admin-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { getOperatorContext } from "@/lib/operator-context";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { hasImpersonationCookie } from "@/lib/impersonation";
import { SUPPORT_OPERATOR_PLANE_MESSAGE } from "@/lib/support-session";
import { retireEmailBoundTokens } from "@/lib/login-email";
import {
  CLUB_REVOKE_SUBJECT,
  StepUpRefusedError,
  consumeStepUpGrant,
  refuseStepUp,
  requireStepUp,
  stepUpTarget,
} from "@/lib/operator-step-up";

export const runtime = "nodejs";

const REVOKE_ACCESS_OUTCOME = "admin.access.revoked";
const REASON_MIN = 10;

const reason = z.string().trim().min(REASON_MIN).max(500);
const bodySchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("user"), subjectId: z.string().min(1).max(64), reason }).strict(),
  z.object({ scope: z.literal("member"), subjectId: z.string().min(1).max(64), reason }).strict(),
  z.object({ scope: z.literal("club"), reason }).strict(),
]);

// Same budget as the other operator customer actions (A6I1-S-5).
const RL_MAX = 20;
const RL_WINDOW_MS = 60 * 60 * 1000;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });

class SubjectGone extends Error {}

type Outcome = {
  scope: "user" | "member" | "club";
  subjectId: string | null;
  sessionsRevoked: { users: number; members: number };
  tokensRetired: { resetCodes: number; signInLinks: number };
};

const NOTE =
  "Every session in scope ends at its next request. Anyone who still knows the password can sign in again: " +
  "pair this with a password reset or a suspension when the password itself is compromised.";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  if (!(await isAdminAuthed(req))) return json({ error: "Forbidden" }, 403);
  // Session precedence: no operator powers from a browser in a support session.
  if (await hasImpersonationCookie()) return json({ error: SUPPORT_OPERATOR_PLANE_MESSAGE }, 403);

  const ctx = await getOperatorContext(req);
  const rl = await checkRateLimit(`admin:tenant-action:${ctx.operatorId}:${getClientIp(req)}`, RL_MAX, RL_WINDOW_MS);
  if (!rl.allowed) {
    return json({ error: "Too many admin actions. Try again shortly." }, 429, { "Retry-After": String(rl.retryAfterSeconds) });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(
      {
        error: `Choose who to sign out (a staff user, a member, or the whole club) and give a reason of at least ${REASON_MIN} characters.`,
      },
      400,
    );
  }
  const body = parsed.data;
  const { id: tenantId } = await params;
  const subjectId = body.scope === "club" ? null : body.subjectId;
  const target = stepUpTarget(tenantId, subjectId ?? CLUB_REVOKE_SUBJECT, body.scope);

  // ── Preflight: harmless reads; nothing written, the grant not spent. ──────
  const pre = await withRlsBypass(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) return "no_tenant" as const;
    if (body.scope === "user") {
      const u = await tx.user.findFirst({ where: { id: body.subjectId, tenantId }, select: { id: true } });
      if (!u) return "no_subject" as const;
    }
    if (body.scope === "member") {
      const m = await tx.member.findFirst({ where: { id: body.subjectId, tenantId }, select: { id: true } });
      if (!m) return "no_subject" as const;
    }
    return "ok" as const;
  });
  if (pre === "no_tenant") return json({ error: "Club not found." }, 404);
  if (pre === "no_subject") return json({ error: "That person was not found in this club." }, 404);

  // Fresh operator re-authentication bound to THIS scope in THIS club.
  const stepUp = await requireStepUp(req, ctx, "access.revoke_all", target, { change: {} });
  if (stepUp instanceof Response) {
    stepUp.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
    return stepUp;
  }

  try {
    const result = await withRlsBypass(
      async (tx) => {
        // 1. Spend (single use; replay → the recorded result; subject gone → stale).
        const spend = await consumeStepUpGrant(tx, stepUp, { replayActions: [REVOKE_ACCESS_OUTCOME] });
        if (spend.kind === "replay") return { alreadyApplied: true as const, ...spend.outcome };

        let users = 0;
        let members = 0;
        let tokens = { resetCodes: 0, signInLinks: 0 };

        if (body.scope === "user") {
          const u = await tx.user.findFirst({ where: { id: body.subjectId, tenantId }, select: { id: true, email: true } });
          if (!u) throw new SubjectGone();
          users = (await tx.user.updateMany({ where: { id: u.id, tenantId }, data: { sessionVersion: { increment: 1 } } })).count;
          tokens = await retireEmailBoundTokens(tx, { tenantId, emails: [u.email] });
        } else if (body.scope === "member") {
          const m = await tx.member.findFirst({ where: { id: body.subjectId, tenantId }, select: { id: true, email: true } });
          if (!m) throw new SubjectGone();
          members = (await tx.member.updateMany({ where: { id: m.id, tenantId }, data: { sessionVersion: { increment: 1 } } })).count;
          tokens = await retireEmailBoundTokens(tx, { tenantId, emails: [m.email] });
        } else {
          users = (await tx.user.updateMany({ where: { tenantId }, data: { sessionVersion: { increment: 1 } } })).count;
          members = (await tx.member.updateMany({ where: { tenantId }, data: { sessionVersion: { increment: 1 } } })).count;
          // Every outstanding sign-in token of the club, whatever address it names.
          const now = new Date();
          const resetCodes = (
            await tx.passwordResetToken.updateMany({ where: { tenantId, used: false }, data: { used: true } })
          ).count;
          const signInLinks = (
            await tx.magicLinkToken.updateMany({
              where: { tenantId, used: false, purpose: { in: ["login", "first_time_signup"] } },
              data: { used: true, usedAt: now },
            })
          ).count;
          tokens = { resetCodes, signInLinks };
        }

        const outcome: Outcome = {
          scope: body.scope,
          subjectId,
          sessionsRevoked: { users, members },
          tokensRetired: tokens,
        };
        // The outcome row, in the same transaction (its failure rolls back all of it).
        await logAudit({
          tx,
          tenantId,
          userId: null,
          action: "admin.access.revoked", // = REVOKE_ACCESS_OUTCOME (literal so lib/audit-labels coverage sees it)
          entityType: body.scope === "user" ? "User" : body.scope === "member" ? "Member" : "Tenant",
          entityId: subjectId ?? tenantId,
          metadata: { reason: body.reason, ...outcome, result: outcome },
          actAsUserId: ctx.operatorId,
          operatorId: stepUp.operatorId,
          requestId: stepUp.requestId,
          req,
        });
        return outcome;
      },
      { timeout: 60_000 },
    );
    return json({ ok: true, ...result, note: NOTE });
  } catch (err) {
    if (err instanceof StepUpRefusedError) {
      const res = refuseStepUp(err, req);
      res.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
      return res;
    }
    if (err instanceof SubjectGone) {
      return json({ error: "That person is no longer in this club. Nothing was changed." }, 409);
    }
    console.error("[revoke-access] revocation or audit write failed; nothing changed", (err as Error)?.name ?? "error");
    return json(
      { error: "The revocation could not be recorded, so nothing was changed. Try again with a new authenticator code." },
      500,
    );
  }
}
