/**
 * /api/account/profile — the signed-in staff user's OWN profile (8 Oct 2026,
 * account-editing lane R, story C1).
 *
 * GET   → { name, email, role, loginEmailProvisional, totpEnabled }
 * PATCH { name } → change it.
 *
 * Who: any staff role — owner, manager, coach, admin (requireApiStaff: no code
 * owed, no temporary password, authenticator enrolled where the role needs
 * one). Members have their own profile routes. The route acts on the SESSION
 * user only: there is no id in the path or body, so another user — in this
 * club or any other — cannot be targeted.
 *
 * Editable: `name` (the display name). It is the only genuinely personal,
 * non-security column on User. Everything else is either an identity or a
 * security setting with its own guarded flow:
 *   email (login)            → /api/account/login-email (password + code)
 *   password                 → /api/account/password (password + code)
 *   authenticator, recovery  → /api/auth/totp/* (code)
 *   role, tenant, verification flags, session/lockout state → never here.
 * The body schema is `.strict()`: ANY other key (role, tenantId, email,
 * loginEmailProvisionalSince, totp*, mustChangePassword, sessionVersion …)
 * is a 400 and nothing is written — no mass assignment.
 *
 * Audit: `user.profile.updated` in the SAME transaction as the change, with
 * before/after of the changed field only. No secrets.
 *
 * Session: the top bar reads the name from the session token, which is minted
 * at sign-in. This device's token is re-issued with the new name (same
 * re-encode /api/auth/set-password uses; sessionVersion is NOT bumped — a name
 * is not a credential). Other devices show the new name after their next
 * sign-in; the response says whether this device was refreshed.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getToken, encode } from "next-auth/jwt";
import { requireApiStaff, refuseSupportSession } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { withTenantContext } from "@/lib/prisma-tenant";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit-log";
import { isLoginEmailProvisional } from "@/lib/login-email";
import { displayNameSchema } from "@/lib/account-profile";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE } from "@/lib/auth-cookie";

export const runtime = "nodejs";

const patchSchema = z.object({ name: displayNameSchema }).strict();

const RL_MAX = 20;
const RL_WINDOW_MS = 15 * 60 * 1000;

export async function GET() {
  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const row = await withTenantContext(gate.tenantId, (tx) =>
    tx.user.findFirst({
      where: { id: gate.userId, tenantId: gate.tenantId },
      select: { name: true, email: true, role: true, loginEmailProvisionalSince: true, totpEnabled: true },
    }),
  );
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(
    {
      name: row.name,
      email: row.email,
      role: row.role,
      loginEmailProvisional: isLoginEmailProvisional(row),
      totpEnabled: row.totpEnabled,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PATCH(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const support = refuseSupportSession(gate.session);
  if (support) return support;

  const { tenantId, userId } = gate;
  const rl = await checkRateLimit(`account-profile:${userId}`, RL_MAX, RL_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many changes. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const unknownKeys = parsed.error.issues.some((i) => i.code === "unrecognized_keys");
    return NextResponse.json(
      {
        error: unknownKeys
          ? "Only your name can be changed here. Your login email, password and authenticator have their own steps."
          : (parsed.error.issues[0]?.message ?? "Enter your name."),
      },
      { status: 400 },
    );
  }
  const { name } = parsed.data;

  let outcome: { kind: "missing" } | { kind: "unchanged"; name: string } | { kind: "ok"; name: string };
  try {
    outcome = await withTenantContext(tenantId, async (tx) => {
      const current = await tx.user.findFirst({ where: { id: userId, tenantId }, select: { id: true, name: true } });
      if (!current) return { kind: "missing" as const };
      if (current.name === name) return { kind: "unchanged" as const, name };
      // tenantId in the WHERE as well as the read: the write cannot land on a
      // row of another club whatever happens in between.
      const updated = await tx.user.updateMany({ where: { id: userId, tenantId }, data: { name } });
      if (updated.count !== 1) return { kind: "missing" as const };
      await logAudit({
        tx,
        tenantId,
        userId,
        action: "user.profile.updated",
        entityType: "User",
        entityId: userId,
        metadata: { changed: ["name"], before: { name: current.name }, after: { name } },
        req,
      });
      return { kind: "ok" as const, name };
    });
  } catch (err) {
    console.error("[account/profile] update failed; nothing changed", err);
    return NextResponse.json({ error: "Your profile could not be saved. Nothing was changed." }, { status: 500 });
  }

  if (outcome.kind === "missing") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (outcome.kind === "unchanged") return NextResponse.json({ ok: true, name: outcome.name, unchanged: true, sessionRefreshed: true });

  // Re-issue THIS device's token with the new name so the top bar is right on
  // the next render. Explicit cookie name + secure flag, as set-password does.
  const token = await getToken({
    req,
    secret: AUTH_SECRET_VALUE,
    cookieName: SESSION_COOKIE_NAME,
    secureCookie: SESSION_COOKIE_SECURE,
  }).catch(() => null);
  if (!token || token.id !== userId) {
    return NextResponse.json({ ok: true, name: outcome.name, sessionRefreshed: false });
  }
  const encoded = await encode({
    token: { ...token, name: outcome.name },
    secret: AUTH_SECRET_VALUE,
    maxAge: 30 * 24 * 60 * 60,
    salt: SESSION_COOKIE_NAME,
  });
  const res = NextResponse.json({ ok: true, name: outcome.name, sessionRefreshed: true });
  res.cookies.set(SESSION_COOKIE_NAME, encoded, {
    httpOnly: true,
    sameSite: "lax",
    secure: SESSION_COOKIE_SECURE,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return res;
}
