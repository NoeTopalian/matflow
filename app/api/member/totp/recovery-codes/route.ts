/**
 * Member-side recovery codes (2FA-optional spec, 2026-05-07).
 * Mirrors /api/auth/totp/recovery-codes for the Member table.
 *
 * Generates 8 one-time codes, returned exactly once. DB stores HMAC hashes.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { generateRecoveryCodes } from "@/lib/recovery-codes";
import { assertSameOrigin } from "@/lib/csrf";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session?.user?.memberId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const memberId = session.user.memberId;

  try {
    const result = await withTenantContext(session.user.tenantId, async (tx) => {
      const member = await tx.member.findFirst({
        where: { id: memberId, tenantId: session.user.tenantId },
        select: { id: true, totpEnabled: true },
      });
      if (!member) return { kind: "no-member" as const };
      if (!member.totpEnabled) return { kind: "no-totp" as const };

      const codes = generateRecoveryCodes();
      const hashes = codes.map((c) => c.hash);
      await tx.member.update({
        where: { id: member.id },
        data: { totpRecoveryCodes: hashes },
      });
      return { kind: "ok" as const, member, codes };
    });

    if (result.kind === "no-member") return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (result.kind === "no-totp") {
      return NextResponse.json(
        { error: "Enable two-factor authentication before generating recovery codes." },
        { status: 400 },
      );
    }
    const { member, codes } = result;
    const display = codes.map((c) => c.display);

    await logAudit({
      tenantId: session.user.tenantId,
      userId: null,
      action: "auth.member.totp.recovery_codes.generated",
      entityType: "Member",
      entityId: member.id,
      metadata: { count: codes.length, regenerated: true },
      req,
    });

    return NextResponse.json({ codes: display });
  } catch (e) {
    return apiError("Failed to generate recovery codes", 500, e, "[member.totp.recovery-codes]");
  }
}
