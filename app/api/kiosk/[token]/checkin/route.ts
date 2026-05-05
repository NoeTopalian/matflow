// POST /api/kiosk/[token]/checkin
//
// Public-by-design — kiosk URL token IS the auth. Body: { kioskMemberToken,
// classInstanceId }. The kioskMemberToken is HMAC-signed by the lookup
// endpoint and binds memberId → tenantId → 10-min expiry.
//
// Reuses the shared performCheckin() helper so business rules (rank gates,
// duplicate prevention, opportunistic class-pack redemption) match the
// staff-side path. Per the kiosk defaults: enforce rank gates, skip
// time-window, do NOT require coverage (forgiving — gym reconciles).

import { NextResponse } from "next/server";
import { z } from "zod";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { verifyKioskMemberToken } from "@/lib/kiosk-token";
import { performCheckin } from "@/lib/checkin";
import { logAudit } from "@/lib/audit-log";
import { normaliseIp, summariseUa } from "@/lib/login-fingerprint";

export const runtime = "nodejs";

const bodySchema = z.object({
  kioskMemberToken: z.string().min(8),
  classInstanceId: z.string().min(1),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token || token.length < 16) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ip = getClientIp(req);
  const ua = req.headers.get("user-agent");
  const tokenHash = hashToken(token);
  const rl = await checkRateLimit(`kiosk:checkin:${tokenHash.slice(0, 12)}:${ip}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  }
  const { kioskMemberToken, classInstanceId } = parsed.data;

  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findFirst({
      where: { kioskTokenHash: tokenHash },
      select: { id: true },
    }),
  );
  if (!tenant) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const verified = verifyKioskMemberToken(kioskMemberToken, tenant.id);
  if (!verified.ok) {
    return NextResponse.json({ error: "Member token invalid or expired" }, { status: 400 });
  }

  const result = await performCheckin({
    tenantId: tenant.id,
    memberId: verified.memberId,
    classInstanceId,
    method: "kiosk",
    enforceRankGate: true,        // default #1: rank gates enforced
    enforceTimeWindow: false,     // kiosk is on-site; pick any class today
    requireCoverage: false,       // default #2: forgiving on subs
  });

  switch (result.kind) {
    case "success": {
      // Audit the kiosk check-in with /24 IP + UA summary so owners can see
      // kiosk activity in the audit-log viewer.
      await logAudit({
        tenantId: tenant.id,
        userId: null,
        action: "auth.checkin.kiosk",
        entityType: "AttendanceRecord",
        entityId: result.record.id,
        metadata: {
          kioskIpApprox: normaliseIp(ip),
          kioskUaSummary: summariseUa(ua),
          coverage: result.coverage.kind,
          memberId: verified.memberId,
          classInstanceId,
        },
      });
      return NextResponse.json(
        { success: true, coverage: result.coverage },
        { status: 201 },
      );
    }
    case "class_not_found":
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    case "class_cancelled":
      return NextResponse.json({ error: "This class has been cancelled" }, { status: 409 });
    case "rank_below":
      return NextResponse.json(
        { error: "This class is for a higher belt — please ask staff." },
        { status: 403 },
      );
    case "rank_above":
      return NextResponse.json(
        { error: "This class is for a lower belt — please ask staff." },
        { status: 403 },
      );
    case "duplicate":
      return NextResponse.json({ error: "Already checked in" }, { status: 409 });
    case "member_not_found":
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    case "outside_window":
    case "no_coverage":
    case "error":
    default:
      return NextResponse.json({ error: "Could not check in — please ask staff." }, { status: 500 });
  }
}
