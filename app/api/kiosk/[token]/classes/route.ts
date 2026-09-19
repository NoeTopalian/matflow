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
import { tenantAdmission, admissionMessage } from "@/lib/tenant-admission";
import { todayWindow, usableTimezone } from "@/lib/class-time";

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
      select: { id: true, name: true, primaryColor: true, secondaryColor: true, textColor: true, bgColor: true, logoUrl: true, fontFamily: true, subscriptionStatus: true, deletedAt: true, timezone: true },
    }),
  );
  if (!tenant) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // The kiosk is a door, and `lib/tenant-admission.ts` is the one place that
  // decides which doors a paused club's account opens. Every other entrance
  // asks it; this one did not, so suspending a club left the tablet on its
  // front desk still taking attendance and still showing the club's branding.
  // Refuse BEFORE the timetable read, so nothing about the club leaves here.
  const admission = tenantAdmission(tenant);
  if (!admission.admits) {
    return NextResponse.json(
      { error: admissionMessage(admission.reason, "member") },
      { status: 403 },
    );
  }

  // Today's classes for this tenant. No need for capacity yet — kiosk page
  // shows them as a list, picks one, then names; the picker is the only
  // interaction so we don't need to gate.
  //
  // "Today" is the CLUB's day, resolved by the same helper the register uses.
  // This was `new Date(); setHours(0,0,0,0)` and a band of PROCESS-local
  // instants, which did two silent wrong things at once: a club west of the
  // host saw tomorrow's timetable all day, and the day markers writers
  // actually store (the cron's 00:00Z, a BST laptop's 23:00Z of the day
  // before) fell outside the band, so the class was simply missing from the
  // tablet. See lib/class-time#todayWindow for the two spellings it admits.
  const { start, end } = todayWindow(new Date(), usableTimezone(tenant.timezone));

  const instances = await withTenantContext(tenant.id, (tx) =>
    tx.classInstance.findMany({
      where: {
        date: { gte: start, lt: end },
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
