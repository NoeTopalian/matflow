/**
 * POST /api/waiver/sign
 *
 * Member-side waiver sign with a drawn signature image. Decodes the data-URL,
 * verifies it's a real PNG via magic bytes, uploads to Vercel Blob, then
 * creates an immutable SignedWaiver row using the current tenant's waiver
 * title/content snapshot (or default if not set).
 *
 * Used by:
 *   - Member onboarding step 7 (member is logged in)
 *   - The /api/members/[id]/waiver/sign route delegates the upload portion
 *     here? No — that one handles its own auth model. This route is member-self.
 */
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import { put } from "@vercel/blob";
import { randomBytes } from "crypto";
import { logAudit } from "@/lib/audit-log";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { buildDefaultWaiverTitle, buildDefaultWaiverContent } from "@/lib/default-waiver";

const schema = z.object({
  signatureDataUrl: z.string().min(50).max(300_000), // ~200 KB cap on dataURL
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
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json({ error: "No member account linked" }, { status: 400 });

  const tenantId = session.user.tenantId;

  const rl = await checkRateLimit(`waiver:sign:${memberId}`, 5, 15 * 60 * 1000);
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

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "File storage not configured" }, { status: 503 });
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, waiverTitle: true, waiverContent: true },
  });

  try {
    const cuid = randomBytes(12).toString("hex");
    const blob = await put(
      `tenants/${tenantId}/signatures/${cuid}.png`,
      png as unknown as Blob,
      {
        access: "public",
        contentType: "image/png",
        addRandomSuffix: true,
      },
    );

    const signed = await prisma.signedWaiver.create({
      data: {
        memberId,
        tenantId,
        titleSnapshot: tenant?.waiverTitle ?? buildDefaultWaiverTitle(tenant?.name),
        contentSnapshot: tenant?.waiverContent ?? buildDefaultWaiverContent(tenant?.name),
        signerName: parsed.data.signerName.trim(),
        signatureImageUrl: blob.url,
        collectedBy: "self",
        ipAddress: getClientIp(req),
        userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
      },
    });

    await prisma.member.update({
      where: { id: memberId },
      data: { waiverAccepted: true, waiverAcceptedAt: new Date() },
    });

    await logAudit({
      tenantId,
      userId: null,
      action: "waiver.sign",
      entityType: "Member",
      entityId: memberId,
      metadata: { signedWaiverId: signed.id, collectedBy: "self" },
      req,
    });

    return NextResponse.json(
      { ok: true, signedWaiverId: signed.id, signatureImageUrl: signed.signatureImageUrl },
      { status: 201, headers: { "X-Content-Type-Options": "nosniff" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to record signature";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
