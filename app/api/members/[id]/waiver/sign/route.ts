/**
 * POST /api/members/[id]/waiver/sign
 *
 * Staff-supervised waiver collection. Owner/manager/coach/admin opens this on a
 * device, hands it to the member, member signs. The audit trail records
 * collectedBy = "admin_device:{staffUserId}" so it is honest about HOW the
 * waiver was collected (not self-serve).
 *
 * Sprint 2 gate mitigations applied:
 *  - B-5: member lookup uses findFirst({where:{id, tenantId}}) — no bare findUnique
 *  - collectedBy format: "admin_device:{userId}"
 *  - PNG magic-byte check reused from /api/waiver/sign
 *  - addRandomSuffix:true on Vercel Blob upload
 *  - rate-limit on staff user id (5 req / 15 min)
 *  - logAudit called with action "waiver.sign.supervised"
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
import { apiError } from "@/lib/api-error";

const schema = z.object({
  signatureDataUrl: z.string().min(50).max(300_000),
  signerName: z.string().min(1).max(120),
  emergencyContactName: z.string().min(1).max(120),
  emergencyContactPhone: z.string().min(1).max(30),
  emergencyContactRelation: z.string().min(1).max(60),
  agreedTo: z.literal(true),
});

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function decodePngDataUrl(dataUrl: string): Buffer | null {
  const m = dataUrl.match(/^data:image\/png;base64,([a-zA-Z0-9+/=]+)$/);
  if (!m) return null;
  let buf: Buffer;
  try { buf = Buffer.from(m[1], "base64"); } catch { return null; }
  if (buf.length < 8) return null;
  for (let i = 0; i < PNG_MAGIC.length; i++) if (buf[i] !== PNG_MAGIC[i]) return null;
  return buf;
}

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isStaff = ["owner", "manager", "admin", "coach"].includes(session.user.role);
  if (!isStaff) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: memberId } = await params;
  const tenantId = session.user.tenantId;

  // Tenant-scope enforcement (Sprint 2 gate B-5 mitigation)
  const member = await prisma.member.findFirst({
    where: { id: memberId, tenantId },
    select: { id: true, name: true },
  });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  const rl = await checkRateLimit(`waiver:supervised:${session.user.id}`, 5, 15 * 60 * 1000);
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
      { access: "public", contentType: "image/png", addRandomSuffix: true },
    );

    const signed = await prisma.signedWaiver.create({
      data: {
        memberId: member.id,
        tenantId,
        titleSnapshot: tenant?.waiverTitle ?? buildDefaultWaiverTitle(tenant?.name),
        contentSnapshot: tenant?.waiverContent ?? buildDefaultWaiverContent(tenant?.name),
        signerName: parsed.data.signerName.trim(),
        signatureImageUrl: blob.url,
        collectedBy: `admin_device:${session.user.id}`,
        ipAddress: getClientIp(req),
        userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
      },
    });

    await prisma.member.update({
      where: { id: member.id },
      data: {
        emergencyContactName: parsed.data.emergencyContactName.trim(),
        emergencyContactPhone: parsed.data.emergencyContactPhone.trim(),
        emergencyContactRelation: parsed.data.emergencyContactRelation.trim(),
        waiverAccepted: true,
        waiverAcceptedAt: new Date(),
      },
    });

    await logAudit({
      tenantId,
      userId: session.user.id,
      action: "waiver.sign.supervised",
      entityType: "Member",
      entityId: member.id,
      metadata: {
        signedWaiverId: signed.id,
        collectedBy: `admin_device:${session.user.id}`,
        staffSupervisedBy: session.user.id,
      },
      req,
    });

    return NextResponse.json(
      { ok: true, signedWaiverId: signed.id, signatureImageUrl: signed.signatureImageUrl },
      { status: 201, headers: { "X-Content-Type-Options": "nosniff" } },
    );
  } catch (e) {
    return apiError("Failed to record signature", 500, e, "[members/[id]/waiver/sign]");
  }
}
