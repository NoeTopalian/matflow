/**
 * POST /api/admin/auth/step-up
 * Body: { action: StepUpAction, targetId: string, code: "123456" }
 *
 * Fresh re-authentication for one high-impact operator action. Requires a
 * full, MFA-verified operator session (never the shared secret, never an
 * enrolment or challenge cookie) AND a current authenticator code, which is
 * spent. Returns a grant bound to this operator, this action and this target,
 * valid for 5 minutes and usable once — see lib/operator-step-up.ts.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/csrf";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit-log";
import { OP_SESSION_COOKIE, consumeOperatorTotp, resolveOperatorFromCookie } from "@/lib/operator-auth";
import { STEP_UP_ACTIONS, issueStepUpGrant } from "@/lib/operator-step-up";

export const runtime = "nodejs";

const schema = z.object({
  action: z.enum(STEP_UP_ACTIONS),
  targetId: z.string().min(1).max(200),
  code: z.string().regex(/^\d{6}$/),
});

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const store = await cookies();
  const session = await resolveOperatorFromCookie(store.get(OP_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: "Sign in with your operator account first." }, { status: 401 });
  }

  const rl = await checkRateLimit(`admin:operator-step-up:${session.id}`, 5, 10 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Action, target and a 6-digit code are required." }, { status: 400 });
  }

  const operator = await prisma.operator.findUnique({
    where: { id: session.id },
    select: { id: true, totpEnabled: true, totpSecret: true, totpLastUsedStep: true },
  });
  if (!operator?.totpEnabled || !operator.totpSecret) {
    return NextResponse.json({ error: "Sign in with your operator account first." }, { status: 401 });
  }

  const accepted = await consumeOperatorTotp(
    { id: operator.id, totpSecret: operator.totpSecret, totpLastUsedStep: operator.totpLastUsedStep },
    parsed.data.code,
  );
  if (!accepted) {
    return NextResponse.json(
      { error: "That code was not accepted. Wait for the next code and try again." },
      { status: 401 },
    );
  }

  // The issuance row is DURABLE and written BEFORE the grant exists (review
  // finding D5, 6 Oct 2026): it used to be best-effort and after, so a grant
  // could be issued with no record of who asked for it. If the row cannot be
  // written, no grant is issued.
  try {
    await logAudit({
      tenantId: null,
      action: "admin.operator.step_up",
      entityType: "Operator",
      entityId: operator.id,
      metadata: { stepUpAction: parsed.data.action, targetId: parsed.data.targetId },
      actAsUserId: operator.id,
      req,
      durable: true,
      outcome: "authorised",
    });
  } catch (err) {
    console.error("[step-up] audit write failed; no grant issued", err);
    return NextResponse.json(
      { error: "The confirmation could not be recorded, so it was not issued. Try again with a new code." },
      { status: 500 },
    );
  }

  const { grant, expiresAt } = await issueStepUpGrant({
    operatorId: operator.id,
    action: parsed.data.action,
    targetId: parsed.data.targetId,
  });

  return NextResponse.json(
    { ok: true, grant, expiresAt: expiresAt.toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
