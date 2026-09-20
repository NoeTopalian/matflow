// POST /api/admin/impersonate — start an impersonation session
// DELETE /api/admin/impersonate — end the current session
//
// POST requires an operator credential (MATFLOW_ADMIN_SECRET cookie/header or
// an operator session). It mints a signed `matflow_impersonation` cookie which
// the auth.ts jwt() callback reads and uses to override the session identity to
// the target user.
//
// DELETE takes either credential — the operator's, or the impersonation cookie
// itself, so the in-app banner button works and an operator whose admin cookie
// expired mid-session can still get out — and refuses a caller holding
// neither. It clears the impersonation cookie AND the session token: the stop
// must not depend on the borrowed JWT ever being presented again.
//
// Every start/end is audit-logged.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { isAdminAuthed } from "@/lib/admin-auth";
import { SESSION_COOKIE_NAME } from "@/lib/auth-cookie";
import {
  setImpersonationCookie,
  clearImpersonationCookie,
  readImpersonationCookie,
} from "@/lib/impersonation";
import { logAudit } from "@/lib/audit-log";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getOperatorContext } from "@/lib/operator-context";
import { assertSameOrigin } from "@/lib/csrf";

export const runtime = "nodejs";

const startSchema = z.object({
  targetUserId: z.string().min(1),
  reason: z.string().min(5).max(500),
});

export async function POST(req: Request) {
  // CSRF. This is the single most dangerous mutation in the product: it mints a
  // session AS THE GYM OWNER. The operator session rides on a cookie, so
  // without this any page an operator had open could start an impersonation on
  // their behalf.
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
    return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  }
  const { targetUserId, reason } = parsed.data;

  // Look up target user pre-session via bypass — admin secret is the credential here.
  const target = await withRlsBypass((tx) =>
    tx.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, tenantId: true, email: true, name: true, role: true },
    }),
  );
  if (!target) {
    return NextResponse.json({ error: "Target user not found" }, { status: 404 });
  }

  // The shared admin secret has no individual identity in v1. Stamp a sentinel
  // adminUserId so audit rows still record "an admin acted" — distinguishable
  // from regular user actions but anonymous within the admin pool.
  const adminUserId = operator.operatorId;

  await setImpersonationCookie({
    adminUserId,
    targetUserId: target.id,
    targetTenantId: target.tenantId,
    reason,
  });

  await logAudit({
    tenantId: target.tenantId,
    userId: target.id,
    action: "admin.impersonate.start",
    entityType: "User",
    entityId: target.id,
    metadata: {
      reason,
      targetEmail: target.email,
      targetRole: target.role,
      operatorEmail: operator.operatorEmail,
    },
    actAsUserId: adminUserId,
    req,
  });

  return NextResponse.json({ ok: true, redirectTo: "/dashboard" });
}

export async function DELETE(req: Request) {
  // Guarded too, though the stakes are lower: ending impersonation is
  // fail-safe, so forging it is a nuisance rather than an escalation. Cheap,
  // and it keeps the rule "every mutation on this plane checks its origin"
  // free of exceptions a reader has to hold in their head.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  // End-impersonation does NOT require the admin secret — anyone holding the
  // impersonation cookie should be able to end it (banner button etc), and an
  // operator whose admin cookie expired mid-session must still be able to get
  // out. So the gate is the wider of the two: the cookie OR the operator
  // credential.
  //
  // What it is no longer is open to everyone. Until now a caller holding
  // neither got `200 { ok: true }` from a route on the operator plane —
  // nothing was written for them, but a tenant owner poking at
  // /api/admin/impersonate was told the platform's most dangerous door had
  // answered yes, and any probe mapping the plane read it as reachable.
  // Assessment finding, lane L-B, round 2.
  const current = await readImpersonationCookie();
  if (!current && !(await isAdminAuthed(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (current) {
    await logAudit({
      tenantId: current.targetTenantId,
      userId: current.targetUserId,
      action: "admin.impersonate.end",
      entityType: "User",
      entityId: current.targetUserId,
      metadata: { reason: current.reason },
      actAsUserId: current.adminUserId,
      req,
    });
  }
  await clearImpersonationCookie();

  // And the session with it. When this was written the identity swap was an
  // in-place overwrite (auth.ts) with nothing kept, so once the cookie was
  // gone the browser simply kept the target's identity — which is what the
  // round-2 e2e run measured (`impersonatedBy` still on the session after a
  // successful stop). Discarding the session token was the only thing that
  // could end an impersonation at this door.
  //
  // Since 68738cb the swap is a loan: auth.ts stashes the operator's own
  // claims and restores them on the first request after the cookie goes. That
  // covers the paths this route cannot reach — a cookie that expires, or a
  // browser that drops it — and it is asserted at
  // `lg-2-impersonation.spec.ts`, "losing the impersonation cookie hands the
  // operator their own claims back".
  //
  // The discard stays because it is the only end that does not depend on the
  // token being presented again, and it costs nothing: the operator is sent to
  // /admin/tenants, which is gated by the admin cookie and needs no NextAuth
  // session.
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);

  return NextResponse.json({ ok: true, redirectTo: "/admin/tenants" });
}
