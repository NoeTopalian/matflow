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
 *     passwordHash, notes, waiverIpAddress, stripeCustomerId,
 *     stripeSubscriptionId, totpSecret, totpRecoveryCodes → null/empty
 *   - Member.status → "cancelled" (Member has no deletedAt column; status
 *     is the soft-delete signal — consumers default-filter status='active')
 *   - All linked passwords/tokens invalidated (sessionVersion bumped)
 *
 * Audit P0-3 (storage/memory audit 2026-08-16 §5): the erase used to touch
 * the Member row and nothing else, so a "completed" Article 17 request left
 * behind face photos (rows + blob files), signature PNGs, a live TOTP secret,
 * EmailLog recipients, LoginEvent device history, live push channels and
 * email-keyed auth tokens. The erase now sweeps every one of those surfaces:
 *   - MemberPhoto — rows deleted, blob files deleted best-effort
 *   - SignedWaiver — signer name/IP/UA/signature nulled, signature blob
 *     deleted; contentSnapshot/titleSnapshot/acceptedAt/memberId RETAINED
 *     under legal hold (see the comment at the scrub site)
 *   - LoginEvent, PushSubscription, Notification — rows deleted
 *   - Task (kind=member_note) — staff notes addressed to the member, deleted
 *   - MagicLinkToken, PasswordResetToken — rows for the ORIGINAL email deleted
 *   - EmailLog.recipient — rewritten to the sentinel address
 *   - RankHistory.notes — free-text promotion notes nulled (GDPR NEW-2)
 *
 * Audit-logged as `member.dsar_erase`. Owner retains the audit row as
 * evidence of fulfilment per GDPR fulfilment-record retention guidance.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { del } from "@vercel/blob";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { isVercelBlobUrl } from "@/lib/blob-url";
import { hashToken } from "@/lib/token-hash";
import { cancelSubscriptionAtPeriodEnd } from "@/lib/stripe/subscriptions";
import { checkRateLimit } from "@/lib/rate-limit";

const querySchema = z.object({ memberId: z.string().min(1) });

export async function POST(req: Request) {
  const { session } = await requireRole(["owner"]);
  const tenantId = session!.user.tenantId;
  const ownerUserId = session!.user.id;

  // Audit iter-1-dashboard M-A4-3: rate-limit the irreversible erase action.
  // Without this, a compromised owner session could bulk-erase every member
  // in the tenant before detection. 5/hr per tenant is generous for the
  // legitimate worst case (responding to multiple GDPR Article 17 requests
  // in a short window).
  const rl = await checkRateLimit(`dsar:erase:${tenantId}`, 5, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many DSAR erase requests. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const { searchParams } = new URL(req.url);
  const parsed = querySchema.safeParse({ memberId: searchParams.get("memberId") });
  if (!parsed.success) {
    return NextResponse.json({ error: "memberId is required" }, { status: 400 });
  }
  const { memberId } = parsed.data;

  // Audit iter-4-database A8I4-V-1 [High]: explicit select. Bare findFirst
  // pulled passwordHash + totpSecret + totpRecoveryCodes into server memory
  // on every Right-to-Erasure request. Not a wire-leak (response shape is
  // controlled below) but GDPR Article 25 data-minimisation gap at the
  // query boundary. Only id/status/email/stripeSubscriptionId are actually
  // consumed.
  const member = await withTenantContext(tenantId, (tx) =>
    tx.member.findFirst({
      where: { id: memberId, tenantId },
      select: { id: true, status: true, email: true, stripeSubscriptionId: true },
    }),
  );
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }
  if (member.status === "cancelled" && member.email.startsWith("deleted-")) {
    return NextResponse.json({ error: "Member already erased" }, { status: 409 });
  }

  // Audit iter-1-member-lifecycle A3H-7: cancel the Stripe subscription
  // BEFORE anonymising the member. GDPR Article 17 fulfilment requires the
  // data-minimisation outcome: Stripe stops charging the (still-stored) card
  // and stops holding active payment data for an "erased" member. Strictest
  // interpretation per user decision 2026-05-31: if the Stripe cancel fails
  // for any reason, refuse the erase. The operator can fix the Stripe state
  // (network, dispute, expired key) and retry, OR cancel manually in Stripe
  // and then re-issue the erase. Failing closed avoids the dispute risk of
  // a "deleted" member whose card keeps getting charged.
  let stripeCancelOutcome: { performed: boolean; cancelAt: number | null } = {
    performed: false,
    cancelAt: null,
  };
  if (member.stripeSubscriptionId) {
    const tenantStripe = await withTenantContext(tenantId, (tx) =>
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: { stripeAccountId: true },
      }),
    );
    if (!tenantStripe?.stripeAccountId) {
      return NextResponse.json(
        {
          error:
            "Cannot erase: this member has an active Stripe subscription but the gym has no connected Stripe account. " +
            "Cancel the subscription directly in Stripe first, then retry.",
        },
        { status: 422 },
      );
    }
    const cancelResult = await cancelSubscriptionAtPeriodEnd({
      tenant: { stripeAccountId: tenantStripe.stripeAccountId },
      stripeSubscriptionId: member.stripeSubscriptionId,
    });
    if (!cancelResult.ok) {
      return NextResponse.json(
        {
          error:
            "Cannot erase: Stripe subscription cancellation failed (" +
            cancelResult.error +
            "). Cancel manually in Stripe, then retry.",
        },
        { status: cancelResult.status },
      );
    }
    stripeCancelOutcome = { performed: true, cancelAt: cancelResult.cancelAt };
  }

  // Audit P0-3: pre-flight tally of everything the erase is about to destroy.
  // Two things need this read pass:
  //   1. The blob URLs — MemberPhoto.url and SignedWaiver.signatureImageUrl
  //      must be captured before their rows are deleted/nulled, otherwise the
  //      files are orphaned in Vercel Blob forever (Blob never GCs).
  //   2. The counts for the fulfilment record. The audit row must be written
  //      BEFORE the destruction (see below), so the numbers it carries are
  //      necessarily measured pre-erase. They are the rows targeted by the
  //      erase transaction, which — for an owner-only, 5/hr action on a single
  //      member — is the same set the transaction deletes.
  const originalEmail = member.email;
  const sentinelEmail = `deleted-${memberId}@deleted.invalid`;

  const scope = await withTenantContext(tenantId, async (tx) => {
    const [
      photos,
      waivers,
      loginEvents,
      pushSubscriptions,
      notifications,
      memberNoteTasks,
      magicLinkTokens,
      passwordResetTokens,
      emailLogs,
      rankHistoryNotes,
    ] = await Promise.all([
      tx.memberPhoto.findMany({
        where: { memberId, tenantId },
        select: { id: true, url: true },
      }),
      tx.signedWaiver.findMany({
        where: { memberId, tenantId },
        select: { id: true, signatureImageUrl: true },
      }),
      tx.loginEvent.count({ where: { memberId, tenantId } }),
      tx.pushSubscription.count({ where: { memberId, tenantId } }),
      tx.notification.count({ where: { memberId, tenantId } }),
      tx.task.count({ where: { tenantId, assigneeMemberId: memberId, kind: "member_note" } }),
      // GDPR obs-3: the counts must use the same case-insensitive predicate as
      // the deletes below, or the fulfilment record understates what was
      // destroyed.
      tx.magicLinkToken.count({
        where: { tenantId, email: { equals: originalEmail, mode: "insensitive" } },
      }),
      tx.passwordResetToken.count({
        where: { tenantId, email: { equals: originalEmail, mode: "insensitive" } },
      }),
      tx.emailLog.count({
        where: { tenantId, recipient: { equals: originalEmail, mode: "insensitive" } },
      }),
      // GDPR NEW-2: free-text promotion notes. The SAR export hands these to
      // the subject as their own personal data (export/route.ts selects
      // RankHistory.notes), so leaving them untouched under Article 17 is
      // self-inconsistent — and it is exactly the coach-typed-their-name risk
      // that justified scrubbing Member.notes. RankHistory has no tenantId
      // column; it is reached through MemberRank.memberId (RLS policy
      // 20260503100000 joins the same way), and memberId is a global cuid.
      tx.rankHistory.count({ where: { memberRank: { memberId }, notes: { not: null } } }),
    ]);
    return {
      photos,
      waivers,
      loginEvents,
      pushSubscriptions,
      notifications,
      memberNoteTasks,
      magicLinkTokens,
      passwordResetTokens,
      emailLogs,
      rankHistoryNotes,
    };
  });

  const erasedCounts = {
    memberPhotos: scope.photos.length,
    signedWaiversScrubbed: scope.waivers.length,
    loginEvents: scope.loginEvents,
    pushSubscriptions: scope.pushSubscriptions,
    notifications: scope.notifications,
    memberNoteTasks: scope.memberNoteTasks,
    magicLinkTokens: scope.magicLinkTokens,
    passwordResetTokens: scope.passwordResetTokens,
    emailLogsRedacted: scope.emailLogs,
    rankHistoryNotesScrubbed: scope.rankHistoryNotes,
  };

  // P1 (assessment item #4, 2026-05-07): write the audit row BEFORE the
  // destructive erasure, with both awaited. If the audit-log write throws,
  // we refuse to erase — the GDPR Article 17 fulfilment evidence must exist
  // before the data is destroyed. Previously this was fire-and-forget
  // (`void logAudit(...).catch(() => {})`), which meant a failed audit
  // write could silently swallow the only proof-of-fulfilment.
  try {
    await logAudit({
      tenantId,
      userId: ownerUserId,
      action: "member.dsar_erase",
      entityType: "Member",
      entityId: memberId,
      metadata: {
        // Audit P3-6: HMAC-SHA256 (lib/token-hash), not the old 32-bit
        // hashSnippet — that one was brute-forceable over the email space,
        // i.e. weak pseudonymisation in the fulfilment record itself.
        originalEmailHash: member.email ? hashToken(member.email) : null,
        gdprBasis: "Article 17 right to erasure",
        // Audit iter-1-member-lifecycle A3H-7: capture the Stripe-side
        // outcome so the fulfilment record proves the card stopped being
        // charged. cancelAt is the period-end timestamp (Unix seconds) at
        // which Stripe will close the subscription.
        stripeSubscriptionCancelled: stripeCancelOutcome.performed,
        stripeSubscriptionCancelAt: stripeCancelOutcome.cancelAt,
        // Audit P0-3: per-surface scope of the erase, so the fulfilment
        // record proves WHAT was destroyed, not just that an erase ran.
        erasedCounts,
      },
      req,
    });
  } catch (err) {
    console.error("[dsar/erase] audit-log write failed; refusing to erase", err);
    return NextResponse.json(
      { error: "Audit-log write failed; erasure not performed. Try again." },
      { status: 500 },
    );
  }

  // Every DB scrub/delete runs inside ONE tenant transaction: a partial erase
  // is worse than no erase (it reports success while PII survives on some
  // surfaces). Blob deletion is deliberately NOT in here — the Blob API is not
  // transactional and a network blip there must not roll back the DB erase.
  await withTenantContext(tenantId, async (tx) => {
    await tx.member.update({
      where: { id: memberId },
      data: {
        name: "Deleted member",
        // Sentinel keeps the (tenantId, email) composite unique constraint
        // satisfied while making the row clearly inert.
        email: sentinelEmail,
        phone: null,
        dateOfBirth: null,
        emergencyContactName: null,
        emergencyContactPhone: null,
        emergencyContactRelation: null,
        medicalConditions: null,
        passwordHash: null,
        // Audit P0-3: free-text staff notes hold the most sensitive residue on
        // the row (injuries, disputes, safeguarding remarks).
        notes: null,
        waiverIpAddress: null,
        // Safe to null now — the Stripe cancellation above has already used
        // stripeSubscriptionId. Left in place, these two IDs still resolve to
        // the member's full identity inside the Stripe dashboard.
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        // A live TOTP secret on an "erased" member is both a credential and
        // PII. totpEnabled must drop with it, or the row claims 2FA is on with
        // no secret to verify against.
        // (Plain `null` is a Prisma no-op on a Json column. `DbNull` writes a
        // real SQL NULL — the erased state — rather than the JSON literal
        // `null` that `JsonNull` would store.)
        totpEnabled: false,
        totpSecret: null,
        totpRecoveryCodes: Prisma.DbNull,
        status: "cancelled",
        // Bump sessionVersion to invalidate any existing JWT.
        sessionVersion: { increment: 1 },
      },
    });

    // Face photos (including a junior member's, uploaded by a parent).
    await tx.memberPhoto.deleteMany({ where: { memberId, tenantId } });

    // SignedWaiver: scrub the identifying columns but KEEP contentSnapshot,
    // titleSnapshot, acceptedAt and memberId. Those four are the legal hold —
    // the gym's evidence that *this* member accepted *these* terms on *that*
    // date, needed to defend an injury claim for the statutory limitation
    // period. GDPR Article 17(3)(e) (legal claims) covers retaining them; the
    // signer name, IP, user-agent and signature image are not needed for that
    // defence and so are erased.
    await tx.signedWaiver.updateMany({
      where: { memberId, tenantId },
      data: {
        signatureImageUrl: null,
        signerName: null,
        ipAddress: null,
        userAgent: null,
      },
    });

    // Device/login history and live push channels. PushSubscription carries a
    // nullable memberId AND a nullable userId (schema: one of the two is set);
    // members subscribe through the member portal, so member-owned rows exist
    // and are deleted here by memberId. Staff (User) rows are a different
    // subject and are untouched.
    await tx.loginEvent.deleteMany({ where: { memberId, tenantId } });
    await tx.pushSubscription.deleteMany({ where: { memberId, tenantId } });

    // Notification bodies name the member. No writer exists today, but the
    // model and the rows can outlive that — delete defensively.
    await tx.notification.deleteMany({ where: { memberId, tenantId } });

    // member_note Tasks are staff-authored notes ADDRESSED TO the member
    // (body required, rendered on their action list) — subject data, deleted.
    // staff_task rows never reference members and are untouched.
    await tx.task.deleteMany({
      where: { tenantId, assigneeMemberId: memberId, kind: "member_note" },
    });

    // GDPR NEW-2: free-text staff notes on each promotion/demotion. Disclosed
    // to the subject by the SAR export as their personal data, so they must go
    // under Article 17 too. RankHistory carries no tenantId — it is reached
    // through MemberRank.memberId, the same join the RLS policy uses
    // (migration 20260503100000). Only `notes` is nulled: the promotion dates
    // and rank ids are the gym's grading record, and the Member row itself is
    // already pseudonymised by the update above.
    await tx.rankHistory.updateMany({
      where: { memberRank: { memberId } },
      data: { notes: null },
    });

    // Auth tokens are keyed by EMAIL, not memberId, so they must be matched on
    // the original address before the sentinel overwrite above lands — hence
    // originalEmail, captured pre-erase. They also carry IP + user-agent.
    //
    // GDPR obs-3: matched case-INSENSITIVELY. Email local parts are formally
    // case-sensitive but no mail provider treats them that way, and MatFlow's
    // own sign-up/login paths do not force a canonical case — so a token issued
    // to "Alice@example.com" would have escaped an exact-equality redaction and
    // survived the erasure.
    await tx.magicLinkToken.deleteMany({
      where: { tenantId, email: { equals: originalEmail, mode: "insensitive" } },
    });
    await tx.passwordResetToken.deleteMany({
      where: { tenantId, email: { equals: originalEmail, mode: "insensitive" } },
    });

    // EmailLog: redact the recipient to the sentinel rather than delete the
    // rows — the send/bounce history is the tenant's deliverability record and
    // its aggregate integrity matters. `subject` is left untouched on purpose:
    // rewriting it would mean parsing and mutating historical copy for an
    // unbounded set of templates, and the residual risk (a name inside a
    // subject line) is bounded next to the certainty of corrupting the log.
    // (GDPR obs-3: case-insensitive, same reasoning as the tokens above.)
    await tx.emailLog.updateMany({
      where: { tenantId, recipient: { equals: originalEmail, mode: "insensitive" } },
      data: { recipient: sentinelEmail },
    });
  });

  // Blob files, AFTER the DB commit. Best-effort per file: the rows are
  // already gone/nulled, so a Blob API failure leaves an orphaned file, not
  // surviving PII linked to the member. Never abort the erase for it — the
  // warning names the row so an operator can clean up by hand.
  for (const photo of scope.photos) {
    await deleteBlobBestEffort(photo.url, `MemberPhoto ${photo.id}`);
  }
  for (const waiver of scope.waivers) {
    await deleteBlobBestEffort(waiver.signatureImageUrl, `SignedWaiver ${waiver.id}`);
  }

  return NextResponse.json({
    ok: true,
    memberId,
    erasedAt: new Date().toISOString(),
    erased: erasedCounts,
  });
}

/**
 * Delete one blob, never throwing. Non-blob URLs are skipped: MemberPhoto.url
 * and SignedWaiver.signatureImageUrl both accept an inline `data:` fallback,
 * which has no file behind it and must not be handed to the Blob API.
 */
async function deleteBlobBestEffort(url: string | null, label: string): Promise<void> {
  if (!url || !isVercelBlobUrl(url)) return;
  try {
    await del(url);
  } catch (err) {
    console.warn(`[dsar/erase] blob delete failed for ${label}; file orphaned`, err);
  }
}
