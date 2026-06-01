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
        originalEmailHash: member.email ? hashSnippet(member.email) : null,
        gdprBasis: "Article 17 right to erasure",
        // Audit iter-1-member-lifecycle A3H-7: capture the Stripe-side
        // outcome so the fulfilment record proves the card stopped being
        // charged. cancelAt is the period-end timestamp (Unix seconds) at
        // which Stripe will close the subscription.
        stripeSubscriptionCancelled: stripeCancelOutcome.performed,
        stripeSubscriptionCancelAt: stripeCancelOutcome.cancelAt,
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
