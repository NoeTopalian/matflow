/**
 * GET /api/members/lookup?q=name_or_email&tenantSlug=slug
 * Public endpoint for QR check-in member lookup (no auth required, limited data returned).
 */
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const tenantSlug = searchParams.get("tenantSlug")?.trim();

  if (!q || q.length < 2) return NextResponse.json([]);
  if (!tenantSlug) return NextResponse.json({ error: "tenantSlug required" }, { status: 400 });

  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) return NextResponse.json({ error: "Gym not found" }, { status: 404 });

  try {
    const members = await prisma.member.findMany({
      where: {
        tenantId: tenant.id,
        status: { in: ["active", "taster"] },
        OR: [
          { name: { contains: q } },
          { email: { contains: q } },
        ],
      },
      select: { id: true, name: true }, // minimal — no sensitive data
      take: 5,
    });
    return NextResponse.json(members);
  } catch {
    return NextResponse.json([]);
  }
}
