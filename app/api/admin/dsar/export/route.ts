/**
 * GET /api/admin/dsar/export?memberId=...
 *
 * Owner-only Subject Access Request export. Returns a single JSON file
 * containing every PII row MatFlow holds for the named member, served
 * with Content-Disposition: attachment so it downloads immediately.
 *
 * Covers (all tenant-scoped via the Member.tenantId):
 *   - Member row itself
 *   - Family: parent + children
 *   - AttendanceRecord history
 *   - Payment + Order history
 *   - SignedWaiver records (signature URL is the authed proxy URL — the
 *     raw blob is reachable separately if the owner copy-clicks it from
 *     the export)
 *   - ClassSubscription + MemberClassPack + ClassPackRedemption
 *   - MemberRank current + RankHistory
 *   - EmailLog entries addressed to the member's email (tenant-scoped)
 *   - AuditLog entries where entityType='Member' and entityId=memberId
 *
 * Audit-logged as `member.dsar_export` so the owner has a record of
 * having fulfilled the request (GDPR requires retention of fulfilment
 * evidence for a reasonable period).
 *
 * Closes assessment Section 4 amber (DSAR scripted flow) — owner can
 * answer a Subject Access Request in 30 seconds instead of hand-querying
 * 8 different tables.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireOwner } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const querySchema = z.object({
  memberId: z.string().min(1).max(50),
});

export async function GET(req: Request) {
  const { tenantId, userId } = await requireOwner();

  // Audit iter-1-dashboard M-A4-2: rate-limit before expensive multi-table
  // join + PII serialisation. Without this, a compromised owner session could
  // iterate member IDs to enumerate full PII for every member at high rate.
  // 10/hr per tenant is generous for legitimate DSAR fulfilment workflows.
  const rl = await checkRateLimit(`dsar:export:${tenantId}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many DSAR export requests. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({ memberId: url.searchParams.get("memberId") });
  if (!parsed.success) {
    return NextResponse.json({ error: "Missing memberId query parameter" }, { status: 400 });
  }
  const memberId = parsed.data.memberId;

  try {
    const data = await withTenantContext(tenantId, async (tx) => {
      // Audit iter-3-database A8I3-V-H-2 [High]: explicit top-level select.
      // Bare `include:` was returning passwordHash + totpSecret +
      // totpRecoveryCodes + sessionVersion + failedLoginCount + lockedUntil
      // verbatim in the DSAR download. GDPR exports go to the data
      // subject — they could then crack their own bcrypt hash offline,
      // and the file is a credential-theft vector if intercepted in
      // storage. `waiverIpAddress` IS included (it's PII the subject is
      // entitled to under Article 15) — the credential material is NOT.
      const member = await tx.member.findFirst({
        where: { id: memberId, tenantId },
        select: {
          id: true, tenantId: true, email: true, name: true, phone: true,
          membershipType: true, status: true, paymentStatus: true,
          notes: true, onboardingCompleted: true,
          emergencyContactName: true, emergencyContactPhone: true,
          emergencyContactRelation: true, medicalConditions: true,
          dateOfBirth: true, accountType: true,
          waiverAccepted: true, waiverAcceptedAt: true, waiverIpAddress: true,
          stripeCustomerId: true, stripeSubscriptionId: true,
          preferredPaymentMethod: true, lastAnnouncementSeenAt: true,
          parentMemberId: true, hasKidsHint: true,
          totpEnabled: true,  // boolean only; the secret stays server-side
          classReminders: true, beltPromotions: true,
          gymAnnouncements: true, notifyOnNewLogin: true,
          joinedAt: true, updatedAt: true,
          // EXCLUDED: passwordHash, totpSecret, totpRecoveryCodes,
          // sessionVersion, failedLoginCount, lockedUntil.
          parent: { select: { id: true, name: true, email: true } },
          children: {
            select: { id: true, name: true, email: true, accountType: true, dateOfBirth: true },
          },
        },
      });
      if (!member) return null;

      const [
        attendances,
        payments,
        orders,
        signedWaivers,
        subscriptions,
        classPacks,
        memberRanks,
        emailLogs,
        auditLogs,
      ] = await Promise.all([
        tx.attendanceRecord.findMany({
          where: { memberId },
          include: {
            classInstance: {
              select: { id: true, date: true, startTime: true, endTime: true, class: { select: { name: true } } },
            },
          },
          orderBy: { checkInTime: "desc" },
        }),
        tx.payment.findMany({
          where: { memberId, tenantId },
          orderBy: { createdAt: "desc" },
        }),
        tx.order.findMany({
          where: { memberId, tenantId },
          orderBy: { createdAt: "desc" },
        }),
        tx.signedWaiver.findMany({
          where: { memberId, tenantId },
          orderBy: { acceptedAt: "desc" },
        }),
        tx.classSubscription.findMany({
          where: { memberId },
          include: { class: { select: { id: true, name: true } } },
        }),
        tx.memberClassPack.findMany({
          where: { memberId, tenantId },
          include: {
            pack: { select: { id: true, name: true, totalCredits: true } },
            redemptions: true,
          },
        }),
        tx.memberRank.findMany({
          where: { memberId },
          include: {
            rankSystem: { select: { id: true, discipline: true, name: true } },
            rankHistory: { orderBy: { promotedAt: "desc" } },
          },
        }),
        tx.emailLog.findMany({
          where: { tenantId, recipient: member.email },
          orderBy: { createdAt: "desc" },
          take: 1000,
        }),
        tx.auditLog.findMany({
          where: { tenantId, entityType: "Member", entityId: memberId },
          orderBy: { createdAt: "desc" },
          take: 1000,
        }),
      ]);
      return { member, attendances, payments, orders, signedWaivers, subscriptions, classPacks, memberRanks, emailLogs, auditLogs };
    });
    if (!data) return NextResponse.json({ error: "Member not found" }, { status: 404 });
    const { member, attendances, payments, orders, signedWaivers, subscriptions, classPacks, memberRanks, emailLogs, auditLogs } = data;

    const exportPackage = {
      generatedAt: new Date().toISOString(),
      generatedBy: { userId, action: "dsar_export" },
      tenantId,
      memberId,
      member,
      attendances,
      payments,
      orders,
      signedWaivers,
      classSubscriptions: subscriptions,
      classPacks,
      ranks: memberRanks,
      emailLogs,
      auditLogs,
      counts: {
        attendances: attendances.length,
        payments: payments.length,
        orders: orders.length,
        signedWaivers: signedWaivers.length,
        classSubscriptions: subscriptions.length,
        classPacks: classPacks.length,
        ranks: memberRanks.length,
        emailLogs: emailLogs.length,
        auditLogs: auditLogs.length,
      },
      _meta: {
        format: "json",
        version: 1,
        notes: [
          "All timestamps are ISO-8601 UTC unless otherwise noted.",
          "signatureImageUrl in signedWaivers points to /api/waiver/{id}/signature — fetch separately with auth to get the actual PNG bytes.",
          "Soft-deleted rows (deletedAt != null) are included so the export reflects everything stored about this person.",
          "EmailLog excludes message bodies — only metadata is logged. If the data subject requests message bodies, query Resend directly using the resendId.",
        ],
      },
    };

    await logAudit({
      tenantId,
      userId,
      action: "member.dsar_export",
      entityType: "Member",
      entityId: memberId,
      metadata: {
        counts: exportPackage.counts,
        memberEmail: member.email,
      },
      req,
    });

    const filename = `dsar-${member.email.replace(/[^a-zA-Z0-9_-]/g, "_")}-${new Date().toISOString().split("T")[0]}.json`;
    return new NextResponse(JSON.stringify(exportPackage, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  } catch (e) {
    return apiError("DSAR export failed", 500, e, "[admin/dsar/export]");
  }
}
