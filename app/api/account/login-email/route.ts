/**
 * /api/account/login-email — the signed-in staff user's own login email
 * (7 Oct 2026; US-001/US-002).
 *
 * GET  → { email, provisional, provisionalSince, totpEnabled, emailDelivery: "on" | "off" }
 * POST { newEmail, currentPassword, totpCode } → change it.
 *
 * The change needs BOTH the current password and a fresh authenticator code.
 * The code is single use (`User.totpLastUsedStep`, spent with a conditional
 * update — lib/login-email.ts consumeUserTotp). The new address is normalised
 * and must be free for login in THIS club across staff AND members (login is
 * per club, and a staff row shadows a member with the same address); a
 * collision is a 409 that does not say whose the address is.
 *
 * On success, in ONE transaction: the email changes; `loginEmailProvisionalSince`
 * is set (no verification flow exists — with email on or off — so the new
 * address is an identifier, not a proven mailbox); reset codes and sign-in links
 * for the old AND new address are retired; `sessionVersion` is bumped; the audit
 * row carries SHA-256 digests of both addresses. Unchanged: user id, role,
 * tenant, password, authenticator, recovery codes, password history.
 *
 * Sessions: EVERY session, this one included, is signed out — the response
 * clears this device's cookie and says `signInAgain: true`, and the person
 * signs in with the new address, password and authenticator code. Chosen over
 * re-issuing this device's token so the new identifier is proven to work at
 * once and no token carries the old address.
 *
 * Refused: support sessions, sign-ins still owing their code, temporary-password
 * sessions, accounts without an authenticator.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { requireApiStaff, refuseSupportSession } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { withTenantContext } from "@/lib/prisma-tenant";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit-log";
import { emailField } from "@/lib/email-normalise";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE } from "@/lib/auth-cookie";
import { emailDeliveryMode } from "@/lib/email-delivery";
import {
  consumeUserTotp,
  emailDigest,
  isLoginEmailProvisional,
  loginEmailTaken,
  retireEmailBoundTokens,
} from "@/lib/login-email";

export const runtime = "nodejs";

const bodySchema = z.object({
  newEmail: emailField(120),
  currentPassword: z.string().min(1).max(128),
  totpCode: z.string().regex(/^\d{6}$/),
});

const RL_MAX = 5;
const RL_WINDOW_MS = 15 * 60 * 1000;
const REFUSED = "Your current password or authenticator code was not accepted.";

class Collision extends Error {}

export async function GET() {
  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const row = await withTenantContext(gate.tenantId, (tx) =>
    tx.user.findFirst({
      where: { id: gate.userId, tenantId: gate.tenantId },
      select: { email: true, loginEmailProvisionalSince: true, totpEnabled: true },
    }),
  );
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(
    {
      email: row.email,
      provisional: isLoginEmailProvisional(row),
      provisionalSince: row.loginEmailProvisionalSince?.toISOString() ?? null,
      totpEnabled: row.totpEnabled,
      // The global mail switch (not per account), so the card says whether
      // email is actually off instead of assuming it (review defect 3).
      emailDelivery: emailDeliveryMode(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  // Staff role, no code owed, no temporary password, authenticator enrolled
  // where the role requires it (lib/api-authz.ts).
  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const support = refuseSupportSession(gate.session);
  if (support) return support;

  const { tenantId, userId } = gate;
  const rl = await checkRateLimit(`login-email:${userId}`, RL_MAX, RL_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Enter a valid new email address, your current password and a 6-digit code." },
      { status: 400 },
    );
  }
  const { newEmail, currentPassword, totpCode } = parsed.data;

  const user = await withTenantContext(tenantId, (tx) =>
    tx.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, email: true, passwordHash: true, totpEnabled: true, totpSecret: true, totpLastUsedStep: true },
    }),
  );
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!user.totpEnabled || !user.totpSecret) {
    return NextResponse.json(
      { error: "Set up your authenticator before changing your login email." },
      { status: 403 },
    );
  }
  if (newEmail === user.email) {
    return NextResponse.json({ error: "That is already your login email." }, { status: 400 });
  }
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return NextResponse.json({ error: REFUSED }, { status: 400 });
  }

  const totpSecret = user.totpSecret;
  try {
    const outcome = await withTenantContext(tenantId, async (tx) => {
      // Spent before the collision check: every probe of an address costs a
      // fresh code (and a rate-limit slot).
      const spent = await consumeUserTotp(
        tx,
        { id: user.id, totpSecret, totpLastUsedStep: user.totpLastUsedStep },
        totpCode,
      );
      if (!spent) return "bad-code" as const;
      if (await loginEmailTaken(tx, { tenantId, userId: user.id, email: newEmail })) return "collision" as const;
      await tx.user.update({
        where: { id: user.id },
        data: {
          email: newEmail,
          loginEmailProvisionalSince: new Date(),
          sessionVersion: { increment: 1 },
        },
      });
      const retired = await retireEmailBoundTokens(tx, { tenantId, emails: [user.email, newEmail] });
      await logAudit({
        tx,
        tenantId,
        userId: user.id,
        action: "user.login_email.changed",
        entityType: "User",
        entityId: user.id,
        metadata: {
          oldEmailSha256: emailDigest(user.email),
          newEmailSha256: emailDigest(newEmail),
          provisional: true,
          confirmedWith: "password+totp",
          retired,
        },
        req,
      });
      return "ok" as const;
    });
    if (outcome === "bad-code") return NextResponse.json({ error: REFUSED }, { status: 400 });
    if (outcome === "collision") throw new Collision();
  } catch (err) {
    if (err instanceof Collision || (err as { code?: string })?.code === "P2002") {
      return NextResponse.json(
        { error: "That email address can't be used for this account. Choose another." },
        { status: 409 },
      );
    }
    console.error("[account/login-email] change failed; nothing changed", err);
    return NextResponse.json({ error: "Your login email could not be changed. Nothing was changed." }, { status: 500 });
  }

  const res = NextResponse.json({ ok: true, signInAgain: true, provisional: true });
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: SESSION_COOKIE_SECURE,
    path: "/",
    maxAge: 0,
  });
  return res;
}
