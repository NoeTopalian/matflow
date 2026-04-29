import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

const DEMO_TENANTS: Record<string, object> = {
  totalbjj: {
    name: "Total BJJ",
    slug: "totalbjj",
    logoUrl: null,
    primaryColor: "#3b82f6",
    secondaryColor: "#2563eb",
    textColor: "#ffffff",
    bgColor: "#111111",
    fontFamily: "'Inter', sans-serif",
    demo: false,
  },
};

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const normalised = slug.toLowerCase().replace(/[^a-z0-9-]/g, "");

  try {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: normalised },
      select: {
        name: true,
        slug: true,
        logoUrl: true,
        primaryColor: true,
        secondaryColor: true,
        textColor: true,
        bgColor: true,
        fontFamily: true,
        subscriptionStatus: true,
      },
    });

    if (!tenant || tenant.subscriptionStatus === "cancelled") {
      // Fall through to demo check below
      throw new Error("not found");
    }

    return NextResponse.json(tenant);
  } catch {
    // DB not connected or tenant not found — return demo data if slug matches
    if (DEMO_TENANTS[normalised]) {
      return NextResponse.json(DEMO_TENANTS[normalised]);
    }
    return NextResponse.json({ error: "Gym not found" }, { status: 404 });
  }
}
