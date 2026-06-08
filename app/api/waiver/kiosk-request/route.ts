import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { verifyKioskMemberToken } from "@/lib/kiosk-token";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { sendEmail } from "@/lib/email";
import { getBaseUrl } from "@/lib/env-url";

export const runtime = "nodejs";

const bodySchema = z.object({
  kioskDeviceToken: z.string().min(16),
  kioskMemberToken: z.string().min(8),
});

function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***@***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const first = local.charAt(0);
  const last = local.length > 1 ? local.charAt(local.length - 1) : "";
  return `${first}***${last}@${domain}`;
}

export async function POST(req: Request) {
  const ip = getClientIp(req);
  const rl = await checkRateLimit(`waiver:kiosk-request:${ip}`, 20, 60_000, { failClosed: true });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  }
  const { kioskDeviceToken, kioskMemberToken } = parsed.data;

  const deviceTokenHash = hashToken(kioskDeviceToken);
  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findFirst({
      where: { kioskTokenHash: deviceTokenHash },
      select: { id: true, name: true },
    }),
  );
  if (!tenant) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const verified = verifyKioskMemberToken(kioskMemberToken, tenant.id);
  if (!verified.ok) {
    return NextResponse.json({ error: "Member token invalid or expired" }, { status: 400 });
  }
  const { memberId } = verified;

  const member = await withTenantContext(tenant.id, (tx) =>
    tx.member.findFirst({
      where: { id: memberId, tenantId: tenant.id, status: { in: ["active", "taster"] } },
      select: { id: true, email: true },
    }),
  );
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const created = await withTenantContext(tenant.id, async (tx) => {
    // Invalidate prior unused waiver_open tokens for this member
    await tx.magicLinkToken.updateMany({
      where: { email: member.email, tenantId: tenant.id, purpose: "waiver_open", used: false },
      data: { used: true, usedAt: new Date() },
    });
    return tx.magicLinkToken.create({
      data: {
        tenantId: tenant.id,
        email: member.email,
        tokenHash,
        purpose: "waiver_open",
        expiresAt,
        ipAddress: ip === "unknown" ? null : ip,
      },
      select: { id: true },
    });
  });

  const baseUrl = getBaseUrl(req);
  const link = `${baseUrl}/waiver/open?token=${rawToken}`;

  await sendEmail({
    tenantId: tenant.id,
    templateId: "kiosk_waiver",
    to: member.email,
    vars: {
      gymName: tenant.name,
      link,
      expiresIn: "24 hours",
    },
  });

  return NextResponse.json({
    maskedEmail: maskEmail(member.email),
    tokenId: created.id,
  });
}
