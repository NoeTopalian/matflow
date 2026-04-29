import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Members are allowed — they need gym branding + billing contact info

  const fallback = {
    name: session.user.tenantName,
    logoUrl: null,
    primaryColor: session.user.primaryColor ?? "#3b82f6",
    secondaryColor: session.user.secondaryColor ?? "#2563eb",
    textColor: session.user.textColor ?? "#ffffff",
    bgColor: "#111111",
    fontFamily: "'Inter', sans-serif",
    memberSelfBilling: false,
    billingContactEmail: null,
    billingContactUrl: null,
    privacyContactEmail: null,
    privacyPolicyUrl: null,
    instagramUrl: null,
    facebookUrl: null,
    tiktokUrl: null,
    youtubeUrl: null,
    twitterUrl: null,
    websiteUrl: null,
  };

  if (session.user.tenantId === "demo-tenant") {
    return NextResponse.json(fallback);
  }

  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: session.user.tenantId },
      select: {
        name: true,
        logoUrl: true,
        primaryColor: true,
        secondaryColor: true,
        textColor: true,
        bgColor: true,
        fontFamily: true,
        memberSelfBilling: true,
        billingContactEmail: true,
        billingContactUrl: true,
        privacyContactEmail: true,
        privacyPolicyUrl: true,
        instagramUrl: true,
        facebookUrl: true,
        tiktokUrl: true,
        youtubeUrl: true,
        twitterUrl: true,
        websiteUrl: true,
      },
    });
    if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(tenant);
  } catch (e) {
    console.error("[me/gym] DB error, falling back to session data", e);
    return NextResponse.json(fallback);
  }
}
