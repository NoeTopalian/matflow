/**
 * POST /api/members/[id]/hold { until?: ISO date }
 *
 * Put a membership on hold: paymentStatus → "paused", holdUntil → the date
 * (or null for open-ended), and, when the member has a Stripe subscription,
 * Stripe's pause_collection with behavior "void" so nothing is invoiced until
 * it resumes (lib/member-hold.ts). Stripe is updated FIRST: if it refuses,
 * nothing local changes and the owner sees why, rather than a member who
 * reads "paused" here while Stripe keeps charging.
 *
 * Owner + manager (the desk), CSRF, audit `member.hold.start`. The reverse
 * is /resume. Check-in refuses a member on hold on the self and kiosk paths.
 */
import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { assertSameOrigin } from "@/lib/csrf";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { parseHoldUntil, pauseCollectionParams } from "@/lib/member-hold";
import { refuseSupportSession } from "@/lib/support-session";
import { z } from "zod";

// Lane C2 (9 Oct 2026): a JSON object with at most { until } — an ISO date, or null/absent for an
// open-ended hold (tests/unit/member-hold.test.ts pins `{}` as open-ended). A body that is missing,
// unparsable, not an object, or carries any other key is refused: it used to be read as {} and so
// placed an OPEN-ENDED hold that pauses Stripe collection.
const bodySchema = z.strictObject({ until: z.union([z.string().max(64), z.null()]).optional() });

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const support = refuseSupportSession(gate.session); if (support) return support; // read-only support session: in-route backstop to proxy.ts (security lane B, SEC-023)
  const { tenantId, userId } = gate;
  const { id: memberId } = await params;

  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }); }
  const body = bodySchema.safeParse(raw); // SF-C5 shape kept: never a 500
  if (!body.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const now = new Date();
  const parsed = parseHoldUntil(body.data.until, now);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const found = await withTenantContext(tenantId, async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: memberId, tenantId },
      select: { id: true, name: true, paymentStatus: true, stripeSubscriptionId: true, status: true },
    });
    if (!member) return null;
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { stripeAccountId: true, stripeConnected: true } });
    return { member, tenant };
  });
  if (!found) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  const { member, tenant } = found;
  if (member.status === "cancelled") {
    return NextResponse.json({ error: "A cancelled membership cannot be put on hold" }, { status: 409 });
  }
  if (member.paymentStatus === "paused") {
    return NextResponse.json({ error: "This membership is already on hold" }, { status: 409 });
  }

  let stripePaused = false;
  if (member.stripeSubscriptionId) {
    if (!process.env.STRIPE_SECRET_KEY) return apiError("Stripe is not configured", 503);
    if (!tenant?.stripeConnected || !tenant.stripeAccountId) {
      return NextResponse.json({ error: "This member has a Stripe subscription but the club's Stripe is not connected — reconnect under Settings → Revenue first" }, { status: 409 });
    }
    try {
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });
      await stripe.subscriptions.update(member.stripeSubscriptionId, pauseCollectionParams(parsed.until), { stripeAccount: tenant.stripeAccountId });
      stripePaused = true;
    } catch (e) {
      return apiError("Stripe would not pause this subscription — nothing was changed", 502, e, "[members/hold]");
    }
  }

  // Compare-and-set, not a plain update: two clicks on the same confirm button
  // arrive together, both read paymentStatus before either writes, and both
  // used to succeed — two audit rows for one hold (lh-4 C13.02, 25 Sep 2026).
  // The second writer finds the row already paused and is told so.
  const written = await withTenantContext(tenantId, (tx) =>
    tx.member.updateMany({
      where: { id: member.id, tenantId, paymentStatus: { not: "paused" } },
      data: { paymentStatus: "paused", holdUntil: parsed.until, holdPriorStatus: member.paymentStatus },
    }),
  );
  if (written.count === 0) {
    return NextResponse.json({ error: "This membership is already on hold" }, { status: 409 });
  }

  await logAudit({
    tenantId,
    userId,
    action: "member.hold.start",
    entityType: "Member",
    entityId: member.id,
    metadata: {
      holdUntil: parsed.until ? parsed.until.toISOString() : null,
      priorPaymentStatus: member.paymentStatus,
      stripeSubscriptionId: member.stripeSubscriptionId,
      stripePaused,
    },
    req,
  });

  return NextResponse.json({
    ok: true,
    memberId: member.id,
    paymentStatus: "paused",
    holdUntil: parsed.until ? parsed.until.toISOString() : null,
    stripePaused,
  });
}
