import { NextResponse } from "next/server";
import { z } from "zod";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { buildDefaultWaiverTitle, buildDefaultWaiverContent } from "@/lib/default-waiver";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

const bodySchema = z.object({
  token: z.string().min(20).max(200),
  signerName: z.string().min(1).max(120),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawToken = url.searchParams.get("token");
  if (!rawToken || rawToken.length < 20) {
    return NextResponse.json({ error: "Invalid token" }, { status: 400 });
  }

  const tokenHash = hashToken(rawToken);
  const tokenRow = await withRlsBypass((tx) =>
    tx.magicLinkToken.findUnique({
      where: { tokenHash },
      select: { id: true, tenantId: true, email: true, purpose: true, used: true, expiresAt: true },
    }),
  );

  if (!tokenRow || tokenRow.purpose !== "waiver_open") {
    return NextResponse.json({ error: "Invalid or expired waiver link" }, { status: 404 });
  }
  if (tokenRow.used) {
    return NextResponse.json({ error: "This waiver link has already been used" }, { status: 410 });
  }
  if (tokenRow.expiresAt < new Date()) {
    return NextResponse.json({ error: "This waiver link has expired" }, { status: 410 });
  }

  const tenant = await withTenantContext(tokenRow.tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: tokenRow.tenantId },
      select: { name: true, waiverTitle: true, waiverContent: true },
    }),
  );

  return NextResponse.json({
    gymName: tenant?.name ?? "",
    waiverTitle: tenant?.waiverTitle ?? buildDefaultWaiverTitle(tenant?.name),
    waiverContent: tenant?.waiverContent ?? buildDefaultWaiverContent(tenant?.name),
  });
}

export async function POST(req: Request) {
  const ip = getClientIp(req);
  const rl = await checkRateLimit(`waiver:open:${ip}`, 10, 15 * 60 * 1000, { failClosed: true });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }
  const { token: rawToken, signerName } = parsed.data;

  const tokenHash = hashToken(rawToken);
  const tokenRow = await withRlsBypass((tx) =>
    tx.magicLinkToken.findUnique({
      where: { tokenHash },
      select: { id: true, tenantId: true, email: true, purpose: true, used: true, expiresAt: true },
    }),
  );

  if (!tokenRow || tokenRow.purpose !== "waiver_open") {
    return NextResponse.json({ error: "Invalid or expired waiver link" }, { status: 404 });
  }
  if (tokenRow.used) {
    return NextResponse.json({ error: "This waiver link has already been used" }, { status: 410 });
  }
  if (tokenRow.expiresAt < new Date()) {
    return NextResponse.json({ error: "This waiver link has expired" }, { status: 410 });
  }

  const ua = req.headers.get("user-agent");

  try {
    await withTenantContext(tokenRow.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tokenRow.tenantId },
        select: { name: true, waiverTitle: true, waiverContent: true },
      });

      const member = await tx.member.findFirst({
        where: { tenantId: tokenRow.tenantId, email: tokenRow.email },
        select: { id: true },
      });
      if (!member) throw new Error("member_not_found");

      await tx.signedWaiver.create({
        data: {
          memberId: member.id,
          tenantId: tokenRow.tenantId,
          titleSnapshot: tenant?.waiverTitle ?? buildDefaultWaiverTitle(tenant?.name),
          contentSnapshot: tenant?.waiverContent ?? buildDefaultWaiverContent(tenant?.name),
          signerName,
          collectedBy: "kiosk_waiver_link",
          ipAddress: ip === "unknown" ? null : ip,
          userAgent: ua,
        },
      });

      await tx.member.update({
        where: { id: member.id },
        data: { waiverAccepted: true, waiverAcceptedAt: new Date() },
      });

      await tx.magicLinkToken.update({
        where: { id: tokenRow.id },
        data: { used: true, usedAt: new Date(), ipAddress: ip === "unknown" ? null : ip, userAgent: ua },
      });
    });

    await logAudit({
      tenantId: tokenRow.tenantId,
      userId: null,
      action: "member.waiver.signed_via_kiosk",
      entityType: "Member",
      entityId: tokenRow.email,
      metadata: { signerName, method: "kiosk_waiver_link" },
      req,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof Error && e.message === "member_not_found") {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }
    return apiError("Waiver signing failed", 500, e, "[waiver/open]");
  }
}
