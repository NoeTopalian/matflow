/**
 * POST /api/auth/totp/recover
 *
 * PUBLIC (no auth) recovery flow for an owner who's lost their TOTP device.
 * Mirrors the forgot-password fail-safe pattern.
 *
 * On success: clears `User.totpEnabled`, `totpSecret`, removes the consumed
 * recovery code from the array, bumps `sessionVersion` (kicks any stuck JWT),
 * audit-logs. The user can then sign in normally — the proxy gate from Fix 4
 * (`requireTotpSetup: true` because totpEnabled is false again) routes them
 * through Wizard Step 2 to re-enrol with their new device.
 *
 * Rate-limited per-email + per-IP. Always returns 200 to avoid revealing
 * whether the email is valid — even on failure (no enumeration).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { consumeRecoveryCode, recoveryCodeArrayFromJson } from "@/lib/recovery-codes";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().email().max(120),
  tenantSlug: z.string().min(1).max(60),
  recoveryCode: z.string().min(8).max(40),
});

const RATE_LIMIT_MAX_PER_EMAIL = 5;
const RATE_LIMIT_MAX_PER_IP = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function POST(req: Request) {
  const ip = getClientIp(req);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // Same opaque response — don't leak which field failed.
    return NextResponse.json({ ok: true });
  }

  const email = parsed.data.email.toLowerCase().trim();
  const tenantSlug = parsed.data.tenantSlug.toLowerCase().trim();

  const ipRl = await checkRateLimit(`totp-recover:ip:${ip}`, RATE_LIMIT_MAX_PER_IP, RATE_LIMIT_WINDOW_MS);
  const emailRl = await checkRateLimit(`totp-recover:${tenantSlug}:${email}`, RATE_LIMIT_MAX_PER_EMAIL, RATE_LIMIT_WINDOW_MS);
  if (!ipRl.allowed || !emailRl.allowed) {
    const retryAfter = Math.max(ipRl.retryAfterSeconds, emailRl.retryAfterSeconds);
    return NextResponse.json(
      { error: "Too many recovery attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  try {
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) return NextResponse.json({ ok: true });

    const user = await prisma.user.findFirst({
      where: { tenantId: tenant.id, email },
      select: { id: true, totpRecoveryCodes: true, totpEnabled: true },
    });
    if (!user) return NextResponse.json({ ok: true });

    const stored = recoveryCodeArrayFromJson(user.totpRecoveryCodes);
    const result = consumeRecoveryCode(parsed.data.recoveryCode, stored);
    if (!result.ok) {
      // Audit even the failed attempt — repeated failures are useful signal.
      await logAudit({
        tenantId: tenant.id,
        userId: user.id,
        action: "auth.totp.recovery.failed",
        entityType: "User",
        entityId: user.id,
        metadata: { reason: "code_mismatch_or_invalid_format" },
        req,
      });
      return NextResponse.json({ ok: true });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        totpEnabled: false,
        totpSecret: null,
        totpRecoveryCodes: result.remaining,
        sessionVersion: { increment: 1 },
      },
    });

    await logAudit({
      tenantId: tenant.id,
      userId: user.id,
      action: "auth.totp.recovery.used",
      entityType: "User",
      entityId: user.id,
      metadata: { remainingCodes: result.remaining.length },
      req,
    });

    return NextResponse.json({ ok: true, recovered: true });
  } catch (e) {
    return apiError("Recovery flow failed", 500, e, "[totp.recover]");
  }
}
