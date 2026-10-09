// POST /api/admin/impersonate — start a SUPPORT session (read-only "log in as")
// DELETE /api/admin/impersonate — end it
//
// Start conditions (remediation lane B, 6 Oct 2026):
//   - a named, MFA-verified operator session (the shared secret — development
//     and test only since lane A — cannot start one: it has no person behind it);
//   - a fresh step-up code for action "support.impersonate" bound to this club
//     and this person (lib/operator-step-up.ts; header x-matflow-step-up);
//   - a reason of at least 10 characters;
//   - the target is a User in a club that admits sign-in (not suspended,
//     cancelled or deleted — lib/tenant-admission.ts);
//   - no support session already live in this browser, and not from inside one
//     (proxy.ts refuses the operator plane to a support session — no nesting).
// The session is bound to the operator's own session and to a nonce on the
// Operator row, lasts 30 minutes, and is READ-ONLY (lib/impersonation.ts,
// lib/support-session.ts).
//
// DELETE takes either credential — the operator's, or the support cookie
// itself, so the in-app banner button works and an operator whose session
// expired mid-support can still get out — and refuses a caller holding
// neither. It clears the nonce on the Operator row (so a copied cookie is dead
// everywhere), the support cookie AND the session token.
//
// In a browser with no Auth.js session the start also sets an identity-less
// CARRIER session token so auth.ts can perform the swap (see below).
//
// Every start/end is audit-logged.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { isAdminAuthed } from "@/lib/admin-auth";
import { encode, getToken } from "next-auth/jwt";
import { SESSION_COOKIE_NAME } from "@/lib/auth-cookie";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import {
  startSupportSession,
  endSupportSession,
  clearImpersonationCookie,
  readImpersonationCookie,
  readImpersonationCookieForStop,
} from "@/lib/impersonation";
import { logAudit } from "@/lib/audit-log";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getOperatorContext } from "@/lib/operator-context";
import { OP_SESSION_COOKIE, resolveOperatorFromCookie } from "@/lib/operator-auth";
import {
  StepUpRefusedError,
  consumeStepUpGrant,
  refuseStepUp,
  requireStepUp,
  stepUpTarget,
} from "@/lib/operator-step-up";
import { tenantAdmission, admissionMessage } from "@/lib/tenant-admission";
import { assertSameOrigin } from "@/lib/csrf";
import { emailDigest } from "@/lib/login-email";

export const runtime = "nodejs";

// Not exported: a route file may export only HTTP handlers and route config.
const SUPPORT_REASON_MIN = 10;

// THE SUPPORT CARRIER (E2E flow 6, 6 Oct 2026). auth.ts jwt() — where the swap
// to the target happens — runs only when the request carries an Auth.js
// session-token cookie, and operator sign-in never mints one, so in a clean
// operator browser the start returned 200 and /dashboard bounced to /login.
// When the browser holds no readable Auth.js session, the start also sets a
// CARRIER token: { supportCarrier: true }, NO identity, support lifetime. auth.ts
// treats it as a vehicle for the swap only and signs it out (null) whenever
// support is not active. Same encode, salt and cookie name as Auth.js's own
// writes (app/api/auth/set-password/route.ts). The claim literal and the
// lifetime mirror auth.ts SUPPORT_CARRIER_CLAIM and lib/impersonation.ts
// SUPPORT_SESSION_TTL_SECONDS (tests/unit/support-carrier-start.test.ts pins both).
const CARRIER_MAX_AGE_SECONDS = 30 * 60;
const SESSION_COOKIE_SECURE_FLAG = process.env.NODE_ENV === "production";

async function hasAuthJsSession(req: Request): Promise<boolean> {
  const token = await getToken({
    req,
    secret: AUTH_SECRET_VALUE,
    cookieName: SESSION_COOKIE_NAME,
    secureCookie: SESSION_COOKIE_SECURE_FLAG,
  }).catch(() => null);
  // A leftover CARRIER is not a club session (review of lane I): counting it
  // as one skipped writing a fresh carrier for the new start.
  return !!token && token.supportCarrier !== true;
}

async function mintSupportCarrier(): Promise<string> {
  return encode({
    token: { supportCarrier: true },
    secret: AUTH_SECRET_VALUE,
    maxAge: CARRIER_MAX_AGE_SECONDS,
    salt: SESSION_COOKIE_NAME,
  });
}

const startSchema = z.object({
  targetUserId: z.string().min(1).max(200),
  reason: z.string().trim().min(SUPPORT_REASON_MIN).max(500),
});

export async function POST(req: Request) {
  // CSRF. This mints a session AS THE GYM OWNER. The operator session rides on
  // a cookie, so without this any page an operator had open could start one.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const operator = await getOperatorContext(req);
  if (!operator.authed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const ip = getClientIp(req);
  const rl = await checkRateLimit(`admin:impersonate:${ip}`, 30, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = startSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Choose the person and give a reason of at least ${SUPPORT_REASON_MIN} characters.` },
      { status: 400 },
    );
  }
  const { targetUserId, reason } = parsed.data;

  // A named operator with a live MFA session, and its sessionVersion — the
  // support session is bound to it. The shared-secret sentinel is refused.
  const store = await cookies();
  const named = operator.named
    ? await resolveOperatorFromCookie(store.get(OP_SESSION_COOKIE)?.value)
    : null;
  if (!named || named.id !== operator.operatorId) {
    return NextResponse.json(
      { error: "Support access needs a named operator account with an authenticator." },
      { status: 403 },
    );
  }

  // No second support session in this browser, and none from inside one.
  if (await readImpersonationCookie()) {
    return NextResponse.json(
      { error: "A support session is already active in this browser. End it first." },
      { status: 409 },
    );
  }

  const target = await withRlsBypass((tx) =>
    tx.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true, tenantId: true, email: true, name: true, role: true, sessionVersion: true,
        tenant: { select: { subscriptionStatus: true, deletedAt: true } },
      },
    }),
  );
  if (!target) {
    return NextResponse.json({ error: "Target user not found" }, { status: 404 });
  }
  const admission = tenantAdmission(target.tenant);
  if (!admission.admits) {
    return NextResponse.json({ error: admissionMessage(admission.reason, "staff") }, { status: 409 });
  }

  // Fresh operator MFA, bound to this club and this person, this operator
  // session and the person's role/sessionVersion as confirmed. VERIFIED here,
  // after the refusals above; SPENT below in the same transaction as the
  // durable start row (lane C, 9 Oct 2026).
  const stepUp = await requireStepUp(
    req,
    { operatorId: named.id, named: true, sessionVersion: named.sessionVersion },
    "support.impersonate",
    stepUpTarget(target.tenantId, target.id),
    { change: {} },
  );
  if (stepUp instanceof Response) return stepUp;

  // The carrier, if this browser needs one. Failing to mint it is not a
  // security failure — it grants nothing — so it does not stop the start; the
  // browser then simply lands on /login, as it did before the carrier existed.
  let carrier: string | null = null;
  if (!(await hasAuthJsSession(req))) {
    try {
      carrier = await mintSupportCarrier();
    } catch (err) {
      console.error("[impersonate] support carrier could not be minted; this browser will not enter the club view", err);
    }
  }

  // ORDER (operator audit 5 Oct 2026, Q9-3; lane C 9 Oct 2026):
  //   1. ONE transaction: spend the grant (the person's version re-checked)
  //      and write the durable start row ("authorised", with the grant's
  //      request id). If the row cannot be written the spend rolls back and
  //      nothing is granted.
  //   2. Bind the support session on the Operator row, then set the cookies.
  // A failure in 2 leaves a spent grant and a start row with no live support
  // session (the Operator row's support nonce is the truth): the operator gets
  // a 500, never a success, and starts again with a new code. NO replay: a
  // support session lives in this browser's cookies, which a replayed request
  // cannot honestly hand back — the same grant again is refused as used.
  const adminUserId = named.id;
  try {
    await withRlsBypass((tx) => consumeStepUpGrant(tx, stepUp).then(() => logAudit({
      tx,
      outcome: "authorised",
      tenantId: target.tenantId,
      userId: target.id,
      action: "admin.impersonate.start",
      entityType: "User",
      entityId: target.id,
      metadata: {
        reason,
        targetEmailSha256: emailDigest(target.email),
        targetRole: target.role,
        operatorEmail: operator.operatorEmail,
      },
      actAsUserId: adminUserId,
      operatorId: adminUserId,
      requestId: stepUp.requestId,
      req,
    })));
  } catch (err) {
    if (err instanceof StepUpRefusedError) return refuseStepUp(err, req);
    console.error("[impersonate] audit write failed; support session not started", err);
    return NextResponse.json(
      { error: "The support session could not be recorded, so it was not started. Try again with a new authenticator code." },
      { status: 500 },
    );
  }

  let expiresAt: Date;
  try {
    ({ expiresAt } = await startSupportSession({
      operatorId: named.id,
      operatorSessionVersion: named.sessionVersion,
      target: { id: target.id, tenantId: target.tenantId, sessionVersion: target.sessionVersion },
      reason,
    }));
  } catch (err) {
    console.error("[impersonate] support session could not be bound after its start row was written", err);
    return NextResponse.json(
      { error: "The support session was not started. Your confirmation was used; start again with a new authenticator code." },
      { status: 500 },
    );
  }

  // A browser that already has a club session keeps it (jwt() stashes those
  // claims, as before); one without gets the carrier. The stop (DELETE below)
  // clears the session cookie either way.
  if (carrier) {
    store.set(SESSION_COOKIE_NAME, carrier, {
      httpOnly: true,
      sameSite: "lax",
      secure: SESSION_COOKIE_SECURE_FLAG,
      path: "/",
      maxAge: CARRIER_MAX_AGE_SECONDS,
    });
  }

  return NextResponse.json({ ok: true, redirectTo: "/dashboard", expiresAt: expiresAt.toISOString(), readOnly: true });
}

export async function DELETE(req: Request) {
  // Guarded too, though ending support is fail-safe: it keeps the rule "every
  // mutation on this plane checks its origin" free of exceptions.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  // The gate is the wider of two credentials: the support cookie (signature
  // verified, even if it has just expired) OR the operator credential. A caller
  // holding neither is refused (assessment finding, lane L-B, round 2).
  const current = await readImpersonationCookieForStop();
  if (!current && !(await isAdminAuthed(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (current) {
    // Server-side end: this cookie's nonce stops matching the Operator row, so
    // a copy of it is dead in every browser, not just this one.
    await endSupportSession({ operatorId: current.adminUserId, nonce: current.n });
    // Awaited and durable, but never allowed to block the stop: ending support
    // is the safe direction, so a failed write is logged loudly and the
    // session still ends (operator audit Q9).
    try {
      await logAudit({
        durable: true,
        outcome: "ended",
        tenantId: current.targetTenantId,
        userId: current.targetUserId,
        action: "admin.impersonate.end",
        entityType: "User",
        entityId: current.targetUserId,
        metadata: { reason: current.reason },
        actAsUserId: current.adminUserId,
        req,
      });
    } catch (err) {
      console.error("[impersonate] support session ended but its audit row could not be written", err);
    }
  } else {
    // No cookie in this browser: end whatever support session this named
    // operator has elsewhere.
    const operator = await getOperatorContext(req);
    if (operator.named) {
      const ended = await endSupportSession({ operatorId: operator.operatorId });
      if (ended > 0) {
        // Durable but non-blocking, like the cookie path above: the stop
        // already happened server-side and must not be undone by a failed write.
        try {
          await logAudit({
            durable: true,
            outcome: "ended",
            tenantId: null,
            action: "admin.impersonate.end",
            entityType: "Operator",
            entityId: operator.operatorId,
            metadata: { endedFrom: "operator-without-support-cookie" },
            actAsUserId: operator.operatorId,
            req,
          });
        } catch (err) {
          console.error("[impersonate] support session ended but its audit row could not be written", err);
        }
      }
    }
  }
  await clearImpersonationCookie();

  // And the session with it. auth.ts restores the operator's own claims on the
  // first request without a valid support session (asserted at
  // `lg-2-impersonation.spec.ts`, "losing the impersonation cookie hands the
  // operator their own claims back"); discarding the token is the end that
  // does not depend on it ever being presented again. The operator is sent to
  // /admin/tenants, gated by the operator session, not by NextAuth.
  //
  // Not store.delete(): that sends Set-Cookie without `Secure`, and browsers
  // ignore such a write for a `__Secure-` cookie, so in production the token
  // survived the stop (review of lane I, D-I1). Clear it with the attributes it
  // was written with.
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: SESSION_COOKIE_SECURE_FLAG,
    path: "/",
    maxAge: 0,
  });

  return NextResponse.json({ ok: true, redirectTo: "/admin/tenants" });
}
