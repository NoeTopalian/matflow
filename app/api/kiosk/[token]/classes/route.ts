// GET /api/kiosk/[token]/classes
//
// Public-by-design — the kiosk URL token IS the auth. The page-server
// resolves the tenant from Tenant.kioskTokenHash before any DB read; if the
// token doesn't match, return 404 (constant-time, generic message — don't
// reveal whether the token is malformed vs not-found).
//
// Returns today's class instances for the tenant. NO member roster. NO PII.

import { NextResponse } from "next/server";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token || token.length < 16) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ip = getClientIp(req);
  const tokenHash = hashToken(token);
  const rl = await checkRateLimit(`kiosk:classes:${tokenHash.slice(0, 12)}:${ip}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }

  // Tenant lookup pre-tenant-context — token IS the credential.
  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findFirst({
      where: { kioskTokenHash: tokenHash },
      select: { id: true, name: true, primaryColor: true, secondaryColor: true, textColor: true, bgColor: true, logoUrl: true, fontFamily: true },
    }),
  );
  if (!tenant) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Today's classes for this tenant. No need for capacity yet — kiosk page
  // shows them as a list, picks one, then names; the picker is the only
  // interaction so we don't need to gate.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const instances = await withTenantContext(tenant.id, (tx) =>
    tx.classInstance.findMany({
      where: {
        date: { gte: today, lt: tomorrow },
        isCancelled: false,
        class: { tenantId: tenant.id },
      },
      include: {
        class: {
          select: {
            id: true,
            name: true,
            requiredRank: { select: { name: true, color: true } },
            maxRank: { select: { name: true, color: true } },
          },
        },
      },
      orderBy: { startTime: "asc" },
    }),
  );

  return NextResponse.json({
    tenant: {
      id: tenant.id,
      name: tenant.name,
      primaryColor: tenant.primaryColor,
      secondaryColor: tenant.secondaryColor,
      textColor: tenant.textColor,
      bgColor: tenant.bgColor,
      logoUrl: tenant.logoUrl,
      fontFamily: tenant.fontFamily,
    },
    classes: instances.map((i) => ({
      id: i.id,
      name: i.class.name,
      startTime: i.startTime,
      endTime: i.endTime,
      date: i.date.toISOString(),
      requiredRank: i.class.requiredRank?.name ?? null,
      maxRank: i.class.maxRank?.name ?? null,
    })),
  });
}
