/**
 * POST /api/member/totp/recover
 *
 * PUBLIC (no auth) recovery flow for a member who's lost their TOTP device.
 * Mirrors /api/auth/totp/recover but operates on the Member table.
 *
 * On success: clears Member.totpEnabled, totpSecret, removes the consumed
 * recovery code from the array, bumps sessionVersion, audit-logs. The member
 * can then sign in normally with password — no TOTP challenge — and re-enrol
 * a new authenticator from their account settings.
 *
 * Rate-limited per-email + per-IP. Always returns 200 to avoid revealing
 * whether the email is valid (no enumeration). Mirrors the User-side opaque
 * response pattern.
 *
 * Audit iter-1-auth-boundary AH-4 (2026-05-30): closes the gap where members
 * who enrolled in TOTP had no self-service recovery path after losing their
 * device. Previously the only recourse was contacting gym staff or operator.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
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

  const ipRl = await checkRateLimit(
    `member-totp-recover:ip:${ip}`,
    RATE_LIMIT_MAX_PER_IP,
    RATE_LIMIT_WINDOW_MS,
  );
  const emailRl = await checkRateLimit(
    `member-totp-recover:${tenantSlug}:${email}`,
    RATE_LIMIT_MAX_PER_EMAIL,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!ipRl.allowed || !emailRl.allowed) {
    const retryAfter = Math.max(ipRl.retryAfterSeconds, emailRl.retryAfterSeconds);
    return NextResponse.json(
      { error: "Too many recovery attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  try {
    // Pre-session tenant lookup uses bypass.
    const tenant = await withRlsBypass((tx) =>
      tx.tenant.findUnique({ where: { slug: tenantSlug } }),
    );
    if (!tenant) return NextResponse.json({ ok: true });

    const member = await withTenantContext(tenant.id, (tx) =>
      tx.member.findFirst({
        where: { tenantId: tenant.id, email },
        select: { id: true, totpRecoveryCodes: true, totpEnabled: true },
      }),
    );
    if (!member) return NextResponse.json({ ok: true });

    const stored = recoveryCodeArrayFromJson(member.totpRecoveryCodes);
    const result = consumeRecoveryCode(parsed.data.recoveryCode, stored);
    if (!result.ok) {
      // Audit even the failed attempt — repeated failures are useful signal.
      await logAudit({
        tenantId: tenant.id,
        userId: null,
        action: "auth.member.totp.recovery.failed",
        entityType: "Member",
        entityId: member.id,
        metadata: { reason: "code_mismatch_or_invalid_format" },
        req,
      });
      return NextResponse.json({ ok: true });
    }

    await withTenantContext(tenant.id, (tx) =>
      tx.member.update({
        where: { id: member.id },
        data: {
          totpEnabled: false,
          totpSecret: null,
          totpRecoveryCodes: result.remaining,
          sessionVersion: { increment: 1 },
        },
      }),
    );

    await logAudit({
      tenantId: tenant.id,
      userId: null,
      action: "auth.member.totp.recovery.used",
      entityType: "Member",
      entityId: member.id,
      metadata: { remainingCodes: result.remaining.length },
      req,
    });

    // Always return identical shape regardless of success/failure to prevent
    // the response acting as a recovery-success oracle. Client signals
    // success by attempting normal login (TOTP will now be disabled).
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError("Recovery flow failed", 500, e, "[member.totp.recover]");
  }
}
