/**
 * GET /api/admin/dsar/export?memberId=...
 *
 * Owner-only UK GDPR Article 15 (right of access) export. Returns a single
 * JSON file for the named member, served with Content-Disposition:
 * attachment so it downloads immediately.
 *
 * WHAT IS INCLUDED (all scoped to the member inside their own tenant):
 *   - Member row (PII columns only — see the explicit select below for the
 *     credential material that is deliberately excluded)
 *   - Family: parent + children summaries
 *   - AttendanceRecord history                    [capped, see CAP_HISTORY]
 *   - Payment history                             [capped, see CAP_HISTORY]
 *   - Order history                               [capped, see CAP_HISTORY]
 *   - SignedWaiver records                        [capped, see CAP_HISTORY]
 *   - ClassSubscription + MemberClassPack + ClassPackRedemption
 *   - MemberRank current + RankHistory
 *   - MemberPhoto rows — METADATA ONLY (photoId, kind, caption, uploadedAt).
 *     No image URL of any kind is emitted: not the raw Vercel Blob URL, and
 *     not the /api/blob-image?url=… proxy form either, which embeds it.
 *   - LoginEvent device/login history (coarsened IP, derived UA summary,
 *     device hash)
 *   - PushSubscription channels — endpoint + createdAt ONLY
 *   - ClassWaitlist entries + ClassRoster memberships
 *   - Task rows of kind 'member_note' addressed to the member (staff notes
 *     the member is the subject of)
 *   - EmailLog entries addressed to the member's email  [capped, CAP_LOG]
 *   - AuditLog entries for entityType='Member', entityId=memberId [CAP_LOG]
 *   - MagicLinkToken + PasswordResetToken — SUMMARISED AS COUNTS plus the
 *     latest createdAt. Token hashes are never exported (see the query).
 *
 * WHAT IS NOT INCLUDED: passwordHash, totpSecret, totpRecoveryCodes,
 * sessionVersion, failedLoginCount, lockedUntil, push encryption keys
 * (p256dh/auth), auth-token hashes, raw Vercel Blob URLs, and EmailLog
 * message bodies (MatFlow never stores them — see _meta.notes).
 *
 * Every capped section is returned as `{ items, total, truncated }` so a
 * long-tenured member's SAR can never silently under-report (audit P1-7).
 *
 * Audit-logged as `member.dsar_export` so the owner has a record of
 * having fulfilled the request (GDPR requires retention of fulfilment
 * evidence for a reasonable period). The audit metadata carries an HMAC of
 * the member's email, never the address itself — an export run after an
 * Article 17 erasure must not re-plant the erased address in AuditLog
 * (audit P0-3 / §5).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { checkRateLimit } from "@/lib/rate-limit";
import { hashToken } from "@/lib/token-hash";

export const runtime = "nodejs";

const querySchema = z.object({
  memberId: z.string().min(1).max(50),
});

// Audit P2-9 (memory safety): the whole export is assembled in serverless
// memory as one JSON string, so every unbounded history is a spike that grows
// with member tenure. Caps bound the worst case; the accompanying `total` +
// `truncated` marker keeps the export honest about the cut (audit P1-7).
const CAP_HISTORY = 5000; // attendance / payments / orders / waivers
const CAP_LOG = 1000; // email + audit logs

type CappedSection<T> = { items: T[]; total: number; truncated: boolean };

/** Wrap a capped query result with its true row count and a truncation flag. */
function capped<T>(items: T[], total: number): CappedSection<T> {
  return { items, total, truncated: total > items.length };
}

export async function GET(req: Request) {
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

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
        attendancesTotal,
        payments,
        paymentsTotal,
        orders,
        ordersTotal,
        signedWaivers,
        signedWaiversTotal,
        subscriptions,
        classPacks,
        memberRanks,
        emailLogs,
        emailLogsTotal,
        auditLogs,
        auditLogsTotal,
        memberPhotos,
        loginEvents,
        pushSubscriptions,
        classWaitlists,
        classRosters,
        memberNotes,
        magicLinkTokenSummary,
        passwordResetTokenSummary,
      ] = await Promise.all([
        tx.attendanceRecord.findMany({
          where: { memberId },
          select: {
            id: true,
            tenantId: true,
            memberId: true,
            classInstanceId: true,
            checkInTime: true,
            checkInMethod: true,
            checkedInById: true,
            classInstance: {
              select: { id: true, date: true, startTime: true, endTime: true, class: { select: { name: true } } },
            },
          },
          orderBy: { checkInTime: "desc" },
          take: CAP_HISTORY,
        }),
        tx.attendanceRecord.count({ where: { memberId } }),
        tx.payment.findMany({
          where: { memberId, tenantId },
          select: {
            id: true,
            tenantId: true,
            memberId: true,
            stripeInvoiceId: true,
            stripePaymentIntentId: true,
            stripeChargeId: true,
            amountPence: true,
            currency: true,
            status: true,
            description: true,
            paidAt: true,
            refundedAt: true,
            refundedAmountPence: true,
            failureReason: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: CAP_HISTORY,
        }),
        tx.payment.count({ where: { memberId, tenantId } }),
        tx.order.findMany({
          where: { memberId, tenantId },
          select: {
            id: true,
            tenantId: true,
            memberId: true,
            orderRef: true,
            items: true,
            totalPence: true,
            currency: true,
            status: true,
            paymentMethod: true,
            paidAt: true,
            paidByUserId: true,
            stripeSessionId: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: CAP_HISTORY,
        }),
        tx.order.count({ where: { memberId, tenantId } }),
        tx.signedWaiver.findMany({
          where: { memberId, tenantId },
          select: {
            id: true,
            memberId: true,
            tenantId: true,
            titleSnapshot: true,
            contentSnapshot: true,
            version: true,
            signerName: true,
            signatureImageUrl: true,
            collectedBy: true,
            ipAddress: true,
            userAgent: true,
            acceptedAt: true,
          },
          orderBy: { acceptedAt: "desc" },
          take: CAP_HISTORY,
        }),
        tx.signedWaiver.count({ where: { memberId, tenantId } }),
        tx.classSubscription.findMany({
          where: { memberId },
          select: {
            id: true,
            memberId: true,
            classId: true,
            notificationsEnabled: true,
            createdAt: true,
            class: { select: { id: true, name: true } },
          },
        }),
        tx.memberClassPack.findMany({
          where: { memberId, tenantId },
          select: {
            id: true,
            tenantId: true,
            memberId: true,
            packId: true,
            creditsRemaining: true,
            purchasedAt: true,
            expiresAt: true,
            stripePaymentIntentId: true,
            status: true,
            pack: { select: { id: true, name: true, totalCredits: true } },
            redemptions: {
              select: {
                id: true,
                memberPackId: true,
                attendanceRecordId: true,
                redeemedAt: true,
              },
            },
          },
        }),
        tx.memberRank.findMany({
          where: { memberId },
          select: {
            id: true,
            memberId: true,
            rankSystemId: true,
            stripes: true,
            achievedAt: true,
            promotedById: true,
            rankSystem: { select: { id: true, discipline: true, name: true } },
            rankHistory: {
              select: {
                id: true,
                memberRankId: true,
                fromRankId: true,
                toRankId: true,
                promotedAt: true,
                promotedById: true,
                notes: true,
              },
              orderBy: { promotedAt: "desc" },
            },
          },
        }),
        tx.emailLog.findMany({
          where: { tenantId, recipient: member.email },
          select: {
            id: true,
            tenantId: true,
            templateId: true,
            recipient: true,
            subject: true,
            status: true,
            resendId: true,
            errorMessage: true,
            sentAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: CAP_LOG,
        }),
        tx.emailLog.count({ where: { tenantId, recipient: member.email } }),
        tx.auditLog.findMany({
          where: { tenantId, entityType: "Member", entityId: memberId },
          select: {
            id: true,
            userId: true,
            tenantId: true,
            action: true,
            entityType: true,
            entityId: true,
            metadata: true,
            ipAddress: true,
            userAgent: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: CAP_LOG,
        }),
        tx.auditLog.count({ where: { tenantId, entityType: "Member", entityId: memberId } }),

        // ---- Audit P1-7: surfaces the Article 15 export used to omit ----

        // Face photos — METADATA ONLY. Audit MED-2: `url` used to be selected
        // and emitted through toBlobProxyUrl(), i.e. `/api/blob-image?url=<raw
        // blob URL, percent-encoded>` — so the storage URL travelled inside the
        // SAR file after all. For any photo uploaded before efebb33 the store
        // was PUBLIC, making that embedded URL a permanent unauthenticated
        // download link to the member's (or their child's) face, in a file we
        // deliberately hand to the subject and which is typically forwarded by
        // email. The `data:` fallback is worse still — it IS the image.
        //
        // There is no id-addressed photo-serving route to point at instead
        // (app/api/members/[id]/photos is a staff list endpoint returning the
        // stored URLs, not a byte-serving handler), so the column is not read
        // at all: minimisation at the query boundary, not just at the wire.
        tx.memberPhoto.findMany({
          where: { memberId, tenantId },
          select: { id: true, tenantId: true, memberId: true, kind: true, caption: true, uploadedAt: true },
          orderBy: { uploadedAt: "desc" },
        }),
        // Login/device history. Bounded by design (one row per device), so no
        // cap is needed. deviceHash is the subject's own derived identifier.
        tx.loginEvent.findMany({
          where: { memberId, tenantId },
          select: {
            id: true,
            tenantId: true,
            deviceHash: true,
            ipApprox: true,
            uaSummary: true,
            firstSeenAt: true,
            lastSeenAt: true,
            disownedAt: true,
          },
          orderBy: { lastSeenAt: "desc" },
        }),
        // Push channels: endpoint + createdAt ONLY. p256dh and auth are live
        // Web Push encryption keys — anyone holding them plus the endpoint can
        // send the member notifications. Handing working crypto keys to a data
        // subject (over email, typically) is a security own-goal, and they are
        // not personal data the subject needs under Article 15. Excluded.
        tx.pushSubscription.findMany({
          where: { memberId, tenantId },
          select: { endpoint: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        }),
        // ClassWaitlist has no tenantId column; the memberId filter is already
        // tenant-bounded because `member` was resolved inside this tenant.
        tx.classWaitlist.findMany({
          where: { memberId },
          select: {
            id: true,
            memberId: true,
            classInstanceId: true,
            position: true,
            status: true,
            joinedAt: true,
            expiresAt: true,
            classInstance: {
              select: { id: true, date: true, startTime: true, class: { select: { name: true } } },
            },
          },
          orderBy: { joinedAt: "desc" },
        }),
        tx.classRoster.findMany({
          where: { memberId, tenantId },
          select: {
            id: true,
            tenantId: true,
            memberId: true,
            classId: true,
            addedAt: true,
            class: { select: { id: true, name: true } },
          },
          orderBy: { addedAt: "desc" },
        }),
        // Staff-authored notes ADDRESSED TO the member (kind='member_note').
        // The member is the subject of the body text, so Article 15 covers it.
        // staff_task rows never reference a member and are excluded.
        tx.task.findMany({
          where: { tenantId, assigneeMemberId: memberId, kind: "member_note" },
          select: {
            id: true,
            tenantId: true,
            title: true,
            body: true,
            status: true,
            createdAt: true,
            completedAt: true,
          },
          orderBy: { createdAt: "desc" },
        }),
        // Auth tokens are summarised, never listed. A token row is metadata
        // about an authentication attempt; its tokenHash is credential
        // material and exporting even the hash widens the blast radius of an
        // intercepted SAR file for no Article 15 benefit.
        tx.magicLinkToken.aggregate({
          where: { tenantId, email: member.email },
          _count: { _all: true },
          _max: { createdAt: true },
        }),
        tx.passwordResetToken.aggregate({
          where: { tenantId, email: member.email },
          _count: { _all: true },
          _max: { createdAt: true },
        }),
      ]);
      return {
        member,
        attendances,
        attendancesTotal,
        payments,
        paymentsTotal,
        orders,
        ordersTotal,
        signedWaivers,
        signedWaiversTotal,
        subscriptions,
        classPacks,
        memberRanks,
        emailLogs,
        emailLogsTotal,
        auditLogs,
        auditLogsTotal,
        memberPhotos,
        loginEvents,
        pushSubscriptions,
        classWaitlists,
        classRosters,
        memberNotes,
        magicLinkTokenSummary,
        passwordResetTokenSummary,
      };
    });
    if (!data) return NextResponse.json({ error: "Member not found" }, { status: 404 });
    const {
      member,
      attendances,
      attendancesTotal,
      payments,
      paymentsTotal,
      orders,
      ordersTotal,
      signedWaivers,
      signedWaiversTotal,
      subscriptions,
      classPacks,
      memberRanks,
      emailLogs,
      emailLogsTotal,
      auditLogs,
      auditLogsTotal,
      memberPhotos,
      loginEvents,
      pushSubscriptions,
      classWaitlists,
      classRosters,
      memberNotes,
      magicLinkTokenSummary,
      passwordResetTokenSummary,
    } = data;

    // Audit P2-10: the raw `signatureImageUrl` was being handed over verbatim
    // while _meta already claimed it was the proxy URL. Legacy signatures live
    // in public blobs, so that made the SAR file an auth-free copy of the
    // member's signature image. Emit the authed proxy path instead — the
    // handler at app/api/waiver/[signedWaiverId]/signature resolves the bytes
    // for staff or the member themselves.
    const signedWaiversForExport = signedWaivers.map((w) => ({
      ...w,
      signatureImageUrl: w.signatureImageUrl ? `/api/waiver/${w.id}/signature` : null,
    }));

    // Audit MED-2: id-based reference only, no URL key at all — see the
    // reasoning on the memberPhoto.findMany select above.
    const memberPhotosForExport = memberPhotos.map((p) => ({
      photoId: p.id,
      tenantId: p.tenantId,
      memberId: p.memberId,
      kind: p.kind,
      caption: p.caption,
      uploadedAt: p.uploadedAt,
      note: "image retrievable via the member profile",
    }));

    const tokenSummaries = {
      magicLinkTokens: {
        count: magicLinkTokenSummary._count._all,
        latestCreatedAt: magicLinkTokenSummary._max.createdAt,
      },
      passwordResetTokens: {
        count: passwordResetTokenSummary._count._all,
        latestCreatedAt: passwordResetTokenSummary._max.createdAt,
      },
    };

    const exportPackage = {
      generatedAt: new Date().toISOString(),
      generatedBy: { userId, action: "dsar_export" },
      tenantId,
      memberId,
      member,
      // Capped sections carry { items, total, truncated } — see _meta.
      attendances: capped(attendances, attendancesTotal),
      payments: capped(payments, paymentsTotal),
      orders: capped(orders, ordersTotal),
      signedWaivers: capped(signedWaiversForExport, signedWaiversTotal),
      classSubscriptions: subscriptions,
      classPacks,
      ranks: memberRanks,
      emailLogs: capped(emailLogs, emailLogsTotal),
      auditLogs: capped(auditLogs, auditLogsTotal),
      // Audit P1-7: surfaces added 2026-08-16.
      memberPhotos: memberPhotosForExport,
      loginEvents,
      pushSubscriptions,
      classWaitlists,
      classRosters,
      memberNotes,
      authTokens: tokenSummaries,
      counts: {
        // True row totals, not the possibly-capped page length.
        attendances: attendancesTotal,
        payments: paymentsTotal,
        orders: ordersTotal,
        signedWaivers: signedWaiversTotal,
        classSubscriptions: subscriptions.length,
        classPacks: classPacks.length,
        ranks: memberRanks.length,
        emailLogs: emailLogsTotal,
        auditLogs: auditLogsTotal,
        memberPhotos: memberPhotos.length,
        loginEvents: loginEvents.length,
        pushSubscriptions: pushSubscriptions.length,
        classWaitlists: classWaitlists.length,
        classRosters: classRosters.length,
        memberNotes: memberNotes.length,
        magicLinkTokens: tokenSummaries.magicLinkTokens.count,
        passwordResetTokens: tokenSummaries.passwordResetTokens.count,
      },
      _meta: {
        format: "json",
        // v2 (audit P1-7/P2-9/P2-10, 2026-08-16): added memberPhotos,
        // loginEvents, pushSubscriptions, classWaitlists, classRosters,
        // memberNotes and authTokens; capped sections changed shape from a
        // bare array to { items, total, truncated }.
        version: 2,
        cappedSections: {
          shape: "{ items, total, truncated } — `total` is the true row count; `truncated` is true when rows were left out.",
          caps: {
            attendances: CAP_HISTORY,
            payments: CAP_HISTORY,
            orders: CAP_HISTORY,
            signedWaivers: CAP_HISTORY,
            emailLogs: CAP_LOG,
            auditLogs: CAP_LOG,
          },
        },
        notes: [
          "All timestamps are ISO-8601 UTC unless otherwise noted.",
          "attendances, payments, orders, signedWaivers, emailLogs and auditLogs are { items, total, truncated }. If truncated is true, ask the gym for the remainder — the rows exist and are listed newest-first.",
          "signatureImageUrl in signedWaivers points to /api/waiver/{id}/signature — fetch separately with auth to get the actual PNG bytes. The underlying storage URL is never included.",
          "memberPhotos lists each photo's metadata only — no image URL of any kind is included, because a storage URL is itself an unauthenticated copy of the image. Ask the gym for the image files, or view them on the member profile.",
          "pushSubscriptions lists the endpoint and creation date only. The p256dh/auth encryption keys are deliberately withheld: they are live credentials for sending you notifications, not information about you.",
          "authTokens summarises magic-link and password-reset tokens as a count plus the most recent creation date. Token hashes are credential material and are never exported.",
          "memberNotes are staff-authored notes addressed to you (Task rows of kind 'member_note'). Internal staff tasks that do not reference you are not included.",
          "Soft-deleted rows (deletedAt != null) are included so the export reflects everything stored about this person.",
          "EmailLog excludes message bodies — only metadata is logged. If the data subject requests message bodies, query Resend directly using the resendId.",
          "Credential material on the Member row (password hash, TOTP secret and recovery codes, session/lockout counters) is excluded by design.",
        ],
      },
    };

    // Audit P0-3 / §5: the fulfilment record used to write `memberEmail` in
    // cleartext, so running a SAR for an already-erased member re-planted
    // their address in AuditLog — and the next SAR handed back proof the
    // erasure was incomplete. Store an HMAC instead: it still correlates two
    // exports of the same subject, but it is not the address and (unlike the
    // 32-bit hashSnippet used elsewhere) is not brute-forceable back to one.
    await logAudit({
      tenantId,
      userId,
      action: "member.dsar_export",
      entityType: "Member",
      entityId: memberId,
      metadata: {
        counts: exportPackage.counts,
        memberEmailHash: hashToken(member.email),
      },
      req,
    });

    const filename = `dsar-${member.email.replace(/[^a-zA-Z0-9_-]/g, "_")}-${new Date().toISOString().split("T")[0]}.json`;
    return new NextResponse(JSON.stringify(exportPackage, null, 2), {
      status: 200,
      headers: {
        // charset matters: without it some viewers decode the em-dashes in
        // _meta.notes as Windows-1252 mojibake in the downloaded file.
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  } catch (e) {
    return apiError("DSAR export failed", 500, e, "[admin/dsar/export]");
  }
}
