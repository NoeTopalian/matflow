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

    // Audit iter-2 A2H2-1: atomic read-consume-update inside a single
    // withTenantContext transaction. Previously the findFirst (read codes
    // snapshot) and the member.update (write `remaining`) were in two
    // separate transactions — two concurrent requests with DIFFERENT valid
    // recovery codes could each read the same array and each write back
    // their own `remaining`, with the second write overwriting the first
    // (un-consuming the first code). Merging into one tx removes the race.
    const outcome = await withTenantContext(tenant.id, async (tx) => {
      const member = await tx.member.findFirst({
        where: { tenantId: tenant.id, email },
        select: { id: true, totpRecoveryCodes: true, totpEnabled: true },
      });
      if (!member) return { kind: "not-found" as const };
      const stored = recoveryCodeArrayFromJson(member.totpRecoveryCodes);
      const result = consumeRecoveryCode(parsed.data.recoveryCode, stored);
      if (!result.ok) {
        return { kind: "invalid" as const, memberId: member.id };
      }
      await tx.member.update({
        where: { id: member.id },
        data: {
          totpEnabled: false,
          totpSecret: null,
          totpRecoveryCodes: result.remaining,
          sessionVersion: { increment: 1 },
        },
      });
      return { kind: "ok" as const, memberId: member.id, remainingCount: result.remaining.length };
    });

    if (outcome.kind === "not-found") return NextResponse.json({ ok: true });
    if (outcome.kind === "invalid") {
      // Fire-and-forget audit (Low L-A2I2-1 — matches every other logAudit
      // call site; removes the weak timing oracle between "no member" and
      // "member exists, code wrong").
      void logAudit({
        tenantId: tenant.id,
        userId: null,
        action: "auth.member.totp.recovery.failed",
        entityType: "Member",
        entityId: outcome.memberId,
        metadata: { reason: "code_mismatch_or_invalid_format" },
        req,
      }).catch(() => {});
      return NextResponse.json({ ok: true });
    }

    void logAudit({
      tenantId: tenant.id,
      userId: null,
      action: "auth.member.totp.recovery.used",
      entityType: "Member",
      entityId: outcome.memberId,
      metadata: { remainingCodes: outcome.remainingCount },
      req,
    }).catch(() => {});

    // Always return identical shape regardless of success/failure to prevent
    // the response acting as a recovery-success oracle. Client signals
    // success by attempting normal login (TOTP will now be disabled).
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError("Recovery flow failed", 500, e, "[member.totp.recover]");
  }
}
