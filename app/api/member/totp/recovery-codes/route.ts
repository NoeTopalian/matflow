/**
 * Member-side recovery codes (2FA-optional spec, 2026-05-07).
 * Mirrors /api/auth/totp/recovery-codes for the Member table.
 *
 * Generates 8 one-time codes, returned exactly once. DB stores HMAC hashes.
 *
 * Round 5 (11 Nov 2026): the body must carry a current six-digit `totpCode`
 * from the member's authenticator, as the staff route has required since
 * L1-I2-S-01, so a stolen session cannot replace the member's recovery codes
 * with a set the thief holds. Attempts are rate limited per member, so the
 * code cannot be guessed. Enrolment now gets its codes from the setup POST
 * (issueRecoveryCodes); this route replaces a set later. Members have no
 * `totpLastUsedStep` column, so the code is checked, not spent: single use for
 * members needs that column (Round 5 finding, migration not made here).
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { generateRecoveryCodes } from "@/lib/recovery-codes";
import { assertSameOrigin } from "@/lib/csrf";
import { refuseSupportSession } from "@/lib/support-session";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifySync } from "otplib";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({ totpCode: z.string().regex(/^\d{6}$/) });
const ATTEMPTS_PER_WINDOW = 5;
const WINDOW_MS = 15 * 60 * 1000;

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  const support = refuseSupportSession(session); if (support) return support; // read-only support session (lib/support-session.ts)
  if (!session?.user?.memberId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const memberId = session.user.memberId;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter the six-digit code from your authenticator app." }, { status: 400 });
  }
  const rl = await checkRateLimit(`member-totp-recovery-codes:${memberId}`, ATTEMPTS_PER_WINDOW, WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  try {
    const result = await withTenantContext(session.user.tenantId, async (tx) => {
      const member = await tx.member.findFirst({
        where: { id: memberId, tenantId: session.user.tenantId },
        select: { id: true, totpEnabled: true, totpSecret: true },
      });
      if (!member) return { kind: "no-member" as const };
      if (!member.totpEnabled || !member.totpSecret) return { kind: "no-totp" as const };
      // The previous 30-second step is accepted too: a code typed as the step rolls over (otplib's default checks the
      // current step only) is not refused.
      if (!verifySync({ token: parsed.data.totpCode, secret: member.totpSecret, epochTolerance: [30, 0] }).valid) return { kind: "bad-code" as const };

      const codes = generateRecoveryCodes();
      const hashes = codes.map((c) => c.hash);
      await tx.member.update({
        where: { id: member.id },
        data: { totpRecoveryCodes: hashes },
      });
      return { kind: "ok" as const, member: { id: member.id }, codes };
    });

    if (result.kind === "no-member") return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (result.kind === "no-totp") {
      return NextResponse.json(
        { error: "Enable two-factor authentication before generating recovery codes." },
        { status: 400 },
      );
    }
    if (result.kind === "bad-code") {
      return NextResponse.json({ error: "That code is not right. Open your authenticator app and try again." }, { status: 401 });
    }
    const { member, codes } = result;
    const display = codes.map((c) => c.display);

    await logAudit({
      tenantId: session.user.tenantId,
      userId: null,
      action: "auth.member.totp.recovery_codes.generated",
      entityType: "Member",
      entityId: member.id,
      metadata: { count: codes.length, regenerated: true, stepUpVerified: true },
      req,
    });

    return NextResponse.json({ codes: display });
  } catch (e) {
    return apiError("Failed to generate recovery codes", 500, e, "[member.totp.recovery-codes]");
  }
}
