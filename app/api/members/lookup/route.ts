/**
 * GET /api/members/lookup?q=name&tenantSlug=slug
 * Public endpoint for QR check-in member lookup.
 * Returns short-lived HMAC tokens instead of raw member IDs to prevent enumeration.
 */
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { signCheckinToken } from "@/lib/checkin-token";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const tenantSlug = searchParams.get("tenantSlug")?.trim();

  if (!tenantSlug) return NextResponse.json({ error: "tenantSlug required" }, { status: 400 });
  if (!q || q.length < 3) return NextResponse.json([]);

  const ip = getClientIp(req);
  const rl = await checkRateLimit(`lookup:${tenantSlug}:${ip}`, 30, 5 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many lookups. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) return NextResponse.json({ error: "Gym not found" }, { status: 404 });

  try {
    const members = await prisma.member.findMany({
      where: {
        tenantId: tenant.id,
        status: { in: ["active", "taster"] },
        name: { contains: q },
      },
      select: { id: true, name: true },
      take: 5,
    });
    return NextResponse.json(
      members.map((m) => ({ token: signCheckinToken({ tenantId: tenant.id, memberId: m.id }), name: m.name })),
    );
  } catch {
    return NextResponse.json([]);
  }
}
