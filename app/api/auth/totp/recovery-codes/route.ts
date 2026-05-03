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
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { generateRecoveryCodes } from "@/lib/recovery-codes";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const result = await withTenantContext(session.user.tenantId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: session.user.id, tenantId: session.user.tenantId },
        select: { id: true, totpEnabled: true },
      });
      if (!user) return { kind: "no-user" as const };
      if (!user.totpEnabled) return { kind: "no-totp" as const };

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
    const { user, codes } = result;
    const display = codes.map((c) => c.display);

    await logAudit({
      tenantId: session.user.tenantId,
      userId: user.id,
      action: "auth.totp.recovery_codes.generated",
      entityType: "User",
      entityId: user.id,
      metadata: { count: codes.length, regenerated: true },
      req,
    });

    return NextResponse.json({ codes: display });
  } catch (e) {
    return apiError("Failed to generate recovery codes", 500, e, "[totp.recovery-codes]");
  }
}
