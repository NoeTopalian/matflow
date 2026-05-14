/**
 * POST /api/waiver/sign-for-child
 *
 * US-5: parent signs the waiver on behalf of one of their kids.
 *
 * Mirrors POST /api/waiver/sign but for the parent-of-kid flow:
 *   - Body adds `childMemberId` to the existing { signatureDataUrl,
 *     signerName, agreedTo } shape.
 *   - Guard: childMember.parentMemberId === session.memberId AND same
 *     tenant — same composite predicate used everywhere in Session E.
 *   - Side effect: creates a SignedWaiver row with memberId=kid.id,
 *     collectedBy=parent.memberId, AND flips kid.waiverAccepted=true.
 *
 * Notes:
 *   - The kid waiver shares the tenant's waiverTitle / waiverContent
 *     snapshot. Kid-specific waiver text is a separate spec item; for
 *     now the same legal language applies (the parent is the
 *     signatory).
 *   - The parent's emergency contact trio satisfies the safeguarding
 *     pre-condition. The kid inherits the parent's emergency contact
 *     for waiver purposes — if the gym wants kid-specific emergency
 *     info, that's collected on the kid Member row at creation time.
 */

import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { uploadSignatureWithFallback } from "@/lib/waiver-signature-upload";
import { logAudit } from "@/lib/audit-log";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { buildDefaultWaiverTitle, buildDefaultWaiverContent } from "@/lib/default-waiver";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";

const schema = z.object({
  childMemberId: z.string().min(1).max(50),
  signatureDataUrl: z.string().min(50).max(300_000),
  signerName: z.string().min(1).max(120),
  agreedTo: z.literal(true),
});

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function decodePngDataUrl(dataUrl: string): Buffer | null {
  const m = dataUrl.match(/^data:image\/png;base64,([a-zA-Z0-9+/=]+)$/);
  if (!m) return null;
  let buf: Buffer;
  try { buf = Buffer.from(m[1], "base64"); } catch { return null; }
  if (buf.length < 8) return null;
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (buf[i] !== PNG_MAGIC[i]) return null;
  }
  return buf;
}

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parentMemberId = session.user.memberId as string | undefined;
  if (!parentMemberId) return NextResponse.json({ error: "Not a member account" }, { status: 403 });
  const tenantId = session.user.tenantId;

  // Same rate-limit ceiling as /api/waiver/sign, keyed by parent so a parent
  // signing multiple kids doesn't bleed into another parent's bucket.
  const rl = await checkRateLimit(`waiver:sign-for-child:${parentMemberId}`, 5, 15 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many sign attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });

  const png = decodePngDataUrl(parsed.data.signatureDataUrl);
  if (!png) return NextResponse.json({ error: "Signature is not a valid PNG" }, { status: 400 });

  const { tenant, kid, parent } = await withTenantContext(tenantId, async (tx) => {
    const t = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, waiverTitle: true, waiverContent: true },
    });
    // Composite guard: kid.id AND tenantId AND parentMemberId — never reveal
    // existence of someone else's child.
    const k = await tx.member.findFirst({
      where: { id: parsed.data.childMemberId, tenantId, parentMemberId },
      select: { id: true, name: true, waiverAccepted: true },
    });
    const p = await tx.member.findFirst({
      where: { id: parentMemberId, tenantId },
      select: {
        emergencyContactName: true,
        emergencyContactPhone: true,
        emergencyContactRelation: true,
      },
    });
    return { tenant: t, kid: k, parent: p };
  });

  if (!kid) return apiError("Not found", 404);
  if (!parent?.emergencyContactName?.trim() || !parent.emergencyContactPhone?.trim() || !parent.emergencyContactRelation?.trim()) {
    return NextResponse.json(
      { error: "Add your emergency contact details first — required before signing for a child." },
      { status: 400 },
    );
  }

  try {
    // Vercel Blob upload with data: URL fallback — keeps the route working
    // when BLOB_READ_WRITE_TOKEN is unset or Blob is transiently down.
    const signatureUrl = await uploadSignatureWithFallback(png, tenantId);

    const signed = await withTenantContext(tenantId, async (tx) => {
      const sw = await tx.signedWaiver.create({
        data: {
          memberId: kid.id,
          tenantId,
          titleSnapshot: tenant?.waiverTitle ?? buildDefaultWaiverTitle(tenant?.name),
          contentSnapshot: tenant?.waiverContent ?? buildDefaultWaiverContent(tenant?.name),
          signerName: parsed.data.signerName.trim(),
          signatureImageUrl: signatureUrl,
          collectedBy: parentMemberId,
          ipAddress: getClientIp(req),
          userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
        },
      });
      await tx.member.update({
        where: { id: kid.id },
        data: { waiverAccepted: true, waiverAcceptedAt: new Date() },
      });
      return sw;
    });

    await logAudit({
      tenantId,
      userId: null,
      action: "waiver.sign-for-child",
      entityType: "Member",
      entityId: kid.id,
      metadata: { signedWaiverId: signed.id, collectedBy: parentMemberId, childName: kid.name },
      req,
    });

    return NextResponse.json(
      {
        ok: true,
        signedWaiverId: signed.id,
        signatureImageUrl: `/api/waiver/${signed.id}/signature`,
      },
      { status: 201, headers: { "X-Content-Type-Options": "nosniff" } },
    );
  } catch (e) {
    return apiError("Failed to record signature", 500, e, "[waiver/sign-for-child]");
  }
}
