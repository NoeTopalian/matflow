// P1.6 Login Notifications — disown endpoint ("Wasn't me?" link from email).
//
// Public-by-design: the legitimate user might be locked out of the JWT path
// by the attacker, so we can't require an authenticated session here. Token
// is HMAC-signed (AUTH_SECRET) with a 7-day TTL — see lib/login-event.ts.
//
// On valid token:
//   1. Bump the subject's sessionVersion (kicks every existing JWT — same
//      mechanism as logout-all).
//   2. Set lockedUntil = now + 1h so the original password no longer works
//      until the user goes through the forgot-password flow.
//   3. Mark the LoginEvent.disownedAt — replay protection (a second click is
//      a no-op) and ensures the *next* sign-in from that fingerprint will
//      again be considered "new" and re-notify.
//   4. Audit log auth.login.disowned.
//
// Rate-limited to 10/h per IP to slow enumeration of LoginEvent IDs.

import { NextResponse } from "next/server";
import { withTenantContext, withRlsBypass } from "@/lib/prisma-tenant";
import { verifyDisownToken } from "@/lib/login-event";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit-log";

const ACCOUNT_LOCK_AFTER_DISOWN_MS = 60 * 60 * 1000; // 1 hour

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const ip = getClientIp(req);
  const rl = await checkRateLimit(`disown:ip:${ip}`, 10, 60 * 60 * 1000);
  const baseUrl = new URL(req.url).origin;
  const fail = () => NextResponse.redirect(`${baseUrl}/login?disowned=invalid`);
  const ok = () => NextResponse.redirect(`${baseUrl}/login?disowned=1`);

  if (!rl.allowed) return fail();

  const { token } = await params;
  if (!token) return fail();

  const verified = verifyDisownToken(token);
  if (!verified.ok) return fail();

  // Find the LoginEvent. We don't have a session yet, so go through bypass to
  // resolve tenant + subject, then switch to tenant-scoped writes.
  const event = await withRlsBypass((tx) =>
    tx.loginEvent.findUnique({ where: { id: verified.loginEventId } }),
  );
  if (!event) return fail();

  // Replay protection: an already-disowned event's link is a no-op success.
  // We deliberately do NOT differentiate this from "good link, first click"
  // in the response — both redirect the same way to avoid leaking state.
  if (event.disownedAt) return ok();

  try {
    await withTenantContext(event.tenantId, async (tx) => {
      const lockedUntil = new Date(Date.now() + ACCOUNT_LOCK_AFTER_DISOWN_MS);
      if (event.userId) {
        await tx.user.update({
          where: { id: event.userId },
          data: {
            sessionVersion: { increment: 1 },
            lockedUntil,
          },
        });
      } else if (event.memberId) {
        await tx.member.update({
          where: { id: event.memberId },
          data: {
            sessionVersion: { increment: 1 },
            lockedUntil,
          },
        });
      }
      await tx.loginEvent.update({
        where: { id: event.id },
        data: { disownedAt: new Date() },
      });
    });

    await logAudit({
      tenantId: event.tenantId,
      userId: event.userId ?? null,
      action: "auth.login.disowned",
      entityType: event.userId ? "User" : "Member",
      entityId: event.userId ?? event.memberId ?? event.id,
      metadata: { loginEventId: event.id, ipApprox: event.ipApprox, uaSummary: event.uaSummary },
      req,
    });
  } catch {
    return fail();
  }

  return ok();
}
