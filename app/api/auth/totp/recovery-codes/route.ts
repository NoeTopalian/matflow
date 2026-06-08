/**
 * POST /api/auth/totp/recovery-codes
 *
 * Generate (or regenerate) 8 one-time TOTP recovery codes for the
 * authenticated user. Used in:
 *   - Wizard v2 Step 2: shown immediately after TOTP enrolment
 *   - Settings → Account: "Regenerate recovery codes" button
 *
 * Returns the raw codes ONCE in the response body. They are never returned
 * again — the DB only stores HMAC hashes. If the user loses them, they
 * regenerate (which invalidates the previous set).
 *
 * Auth: requires an active session AND `User.totpEnabled === true` (no
 * point generating codes for an account that doesn't use TOTP).
 *
 * Lane 1 iter-2 L1-I2-S-01 [Critical] fix (V-04(a)): the body must now
 * include a fresh 6-digit `totpCode`. This is a step-up auth gate so a
 * session-hijacked attacker cannot silently rotate the legitimate user's
 * recovery codes — they'd need a live TOTP from the authenticator app too.
 * The first-enrolment caller (wizard step 2) passes the code they just
 * verified in setup; the Settings → Regenerate caller must prompt for one.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { z } from "zod";
import { verifySync } from "otplib";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { generateRecoveryCodes } from "@/lib/recovery-codes";
import { assertSameOrigin } from "@/lib/csrf";

export const runtime = "nodejs";

const bodySchema = z.object({
  totpCode: z.string().regex(/^\d{6}$/, "Six-digit TOTP code required"),
});

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Lane 1 iter-2 L1-I2-S-01 fix: parse + reject if no fresh TOTP supplied.
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Six-digit TOTP code required" },
      { status: 400 },
    );
  }
  const { totpCode } = parsed.data;

  try {
    const result = await withTenantContext(session.user.tenantId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: session.user.id, tenantId: session.user.tenantId },
        select: { id: true, totpEnabled: true, totpSecret: true },
      });
      if (!user) return { kind: "no-user" as const };
      if (!user.totpEnabled || !user.totpSecret) return { kind: "no-totp" as const };

      // Lane 1 iter-2 L1-I2-S-01 fix: verify the supplied code against the
      // user's live TOTP secret BEFORE generating. window=1 matches the
      // login challenge (~30s grace either side of the current step).
      // Matches the verifier used by /api/auth/totp/setup + /api/auth/totp/verify.
      const verified = verifySync({
        token: totpCode,
        secret: user.totpSecret,
      });
      if (!verified.valid) return { kind: "bad-code" as const };

      const codes = generateRecoveryCodes();
      const hashes = codes.map((c) => c.hash);
      await tx.user.update({
        where: { id: user.id },
        data: { totpRecoveryCodes: hashes },
      });
      return { kind: "ok" as const, user, codes };
    });

    if (result.kind === "no-user") return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (result.kind === "no-totp") {
      return NextResponse.json(
        { error: "Enable two-factor authentication before generating recovery codes." },
        { status: 400 },
      );
    }
    if (result.kind === "bad-code") {
      return NextResponse.json(
        { error: "Invalid TOTP code. Open your authenticator app and try again." },
        { status: 401 },
      );
    }
    const { user, codes } = result;
    const display = codes.map((c) => c.display);

    await logAudit({
      tenantId: session.user.tenantId,
      userId: user.id,
      action: "auth.totp.recovery_codes.generated",
      entityType: "User",
      entityId: user.id,
      metadata: { count: codes.length, regenerated: true, stepUpVerified: true },
      req,
    });

    return NextResponse.json({ codes: display });
  } catch (e) {
    return apiError("Failed to generate recovery codes", 500, e, "[totp.recovery-codes]");
  }
}
