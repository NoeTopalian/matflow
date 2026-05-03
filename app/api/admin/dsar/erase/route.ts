/**
 * POST /api/admin/dsar/erase?memberId=...
 *
 * UK GDPR Article 17 right-to-erasure flow. Owner-only — the same role
 * that handles the SAR export. Performs an irreversible PII scrub on the
 * named Member row + soft-deletes them, while preserving aggregate
 * audit/finance integrity (AttendanceRecord rows stay so attendance
 * counts aren't silently corrupted; Payment rows stay for tax/dispute
 * purposes; only the PII columns on Member itself are nulled).
 *
 * After erasure:
 *   - Member.name → "Deleted member"
 *   - Member.email → "deleted-<id>@deleted.invalid" (kept unique-safe)
 *   - Member.phone, dateOfBirth, emergencyContact*, medicalConditions,
 *     passwordHash → null/empty
 *   - Member.status → "cancelled" (Member has no deletedAt column; status
 *     is the soft-delete signal — consumers default-filter status='active')
 *   - All linked passwords/tokens invalidated (sessionVersion bumped)
 *
 * Audit-logged as `member.dsar_erase`. Owner retains the audit row as
 * evidence of fulfilment per GDPR fulfilment-record retention guidance.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";

const querySchema = z.object({ memberId: z.string().min(1) });

export async function POST(req: Request) {
  const { session } = await requireRole(["owner"]);
  const tenantId = session!.user.tenantId;
  const ownerUserId = session!.user.id;

  const { searchParams } = new URL(req.url);
  const parsed = querySchema.safeParse({ memberId: searchParams.get("memberId") });
  if (!parsed.success) {
    return NextResponse.json({ error: "memberId is required" }, { status: 400 });
  }
  const { memberId } = parsed.data;

  const member = await withTenantContext(tenantId, (tx) =>
    tx.member.findFirst({ where: { id: memberId, tenantId } }),
  );
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }
  if (member.status === "cancelled" && member.email.startsWith("deleted-")) {
    return NextResponse.json({ error: "Member already erased" }, { status: 409 });
  }

  await withTenantContext(tenantId, (tx) =>
    tx.member.update({
      where: { id: memberId },
      data: {
        name: "Deleted member",
        // Sentinel keeps the (tenantId, email) composite unique constraint
        // satisfied while making the row clearly inert.
        email: `deleted-${memberId}@deleted.invalid`,
        phone: null,
        dateOfBirth: null,
        emergencyContactName: null,
        emergencyContactPhone: null,
        emergencyContactRelation: null,
        medicalConditions: null,
        passwordHash: null,
        status: "cancelled",
        // Bump sessionVersion to invalidate any existing JWT.
        sessionVersion: { increment: 1 },
      },
    }),
  );

  void logAudit({
    tenantId,
    userId: ownerUserId,
    action: "member.dsar_erase",
    entityType: "Member",
    entityId: memberId,
    metadata: {
      originalEmailHash: member.email ? hashSnippet(member.email) : null,
      gdprBasis: "Article 17 right to erasure",
    },
    req,
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    memberId,
    erasedAt: new Date().toISOString(),
  });
}

// Cheap one-way hash so the audit row notes "we erased member X.Y@email"
// without re-storing the cleartext email.
function hashSnippet(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `h${h.toString(36)}`;
}
