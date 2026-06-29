/**
 * POST /api/payments/chase — owner only.
 *
 * Sends an overdue member a payment-reminder email (the existing payment_failed
 * template) straight from the payments "who owes me" view, so staff can chase
 * without opening each member. CSRF-guarded + rate-limited; audit-logged.
 * Body: { memberId: string }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { sendEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { checkRateLimit } from "@/lib/rate-limit";
import { getBaseUrl } from "@/lib/env-url";

const bodySchema = z.object({ memberId: z.string().min(1) });

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const { tenantId, userId } = await requireOwner();

  let body: unknown;
  try { body = await req.json(); } catch { return apiError("Invalid JSON", 400); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return apiError("Invalid data", 400);
  const { memberId } = parsed.data;

  // Cap chases so the button can't be used to spam a member's inbox.
  const rl = await checkRateLimit(`payment-chase:${tenantId}:${memberId}`, 3, 24 * 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: "This member was already reminded recently." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const data = await withTenantContext(tenantId, async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: memberId, tenantId },
      select: { id: true, name: true, email: true, tenant: { select: { name: true } } },
    });
    if (!member) return null;
    const lastFailed = await tx.payment.findFirst({
      where: { tenantId, memberId, status: "failed" },
      select: { amountPence: true, currency: true },
      orderBy: { createdAt: "desc" },
    });
    return { member, lastFailed };
  });

  if (!data?.member) return apiError("Member not found", 404);
  if (!data.member.email) return apiError("Member has no email on file", 422);

  const amountPence = data.lastFailed?.amountPence ?? null;
  const currency = (data.lastFailed?.currency ?? "GBP").toUpperCase();
  const symbol = currency === "GBP" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  const amount = amountPence != null ? `${symbol}${(amountPence / 100).toFixed(2)}` : "your membership fee";

  const result = await sendEmail({
    tenantId,
    templateId: "payment_failed",
    to: data.member.email,
    vars: {
      memberName: data.member.name,
      gymName: data.member.tenant.name,
      portalUrl: `${getBaseUrl(req)}/member/profile`,
      amount,
    },
  });

  await logAudit({
    tenantId,
    userId,
    action: "payment.chase",
    entityType: "Member",
    entityId: memberId,
    metadata: { amountPence, emailSent: result.ok },
    req,
  });

  if (!result.ok) return apiError("Couldn't send the reminder email", 502);
  return NextResponse.json({ ok: true });
}
