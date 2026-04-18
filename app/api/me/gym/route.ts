import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Demo fallback
  if (session.user.tenantId === "demo-tenant") {
    return NextResponse.json({
      name: session.user.tenantName,
      logoUrl: null,
      primaryColor: session.user.primaryColor ?? "#3b82f6",
      secondaryColor: session.user.secondaryColor ?? "#2563eb",
      textColor: session.user.textColor ?? "#ffffff",
      bgColor: "#111111",
      fontFamily: "'Inter', sans-serif",
    });
  }

  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: session.user.tenantId },
      select: { name: true, logoUrl: true, primaryColor: true, secondaryColor: true, textColor: true, bgColor: true, fontFamily: true },
    });
    if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(tenant);
  } catch {
    return NextResponse.json({
      name: session.user.tenantName,
      logoUrl: null,
      primaryColor: session.user.primaryColor ?? "#3b82f6",
      secondaryColor: session.user.secondaryColor ?? "#2563eb",
      textColor: session.user.textColor ?? "#ffffff",
      bgColor: "#111111",
      fontFamily: "'Inter', sans-serif",
    });
  }
}
