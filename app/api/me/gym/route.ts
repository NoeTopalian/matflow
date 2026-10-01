import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";

// Branding/config changes monthly, was read per member-app open (speed pass
// B3). 60s server cache keyed by tenantId; the settings PATCH revalidates the
// tag so a branding save shows up immediately. Safe to share across users —
// the payload is tenant-level, never user-level.
const getGymBranding = (tenantId: string) =>
  unstable_cache(
    () =>
      withTenantContext(tenantId, (tx) =>
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: {
            name: true,
            logoUrl: true,
            primaryColor: true,
            secondaryColor: true,
            textColor: true,
            bgColor: true,
            fontFamily: true,
            memberSelfBilling: true,
            contactEmail: true,
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
            groupChatUrl: true,
          },
        }),
      ),
    [`gym-branding-${tenantId}`],
    { revalidate: 60, tags: [`gym-branding-${tenantId}`] },
  )();

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
    contactEmail: null,
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
    groupChatUrl: null,
  };

  if (session.user.tenantId === "demo-tenant") {
    return NextResponse.json(fallback);
  }

  try {
    const tenant = await getGymBranding(session.user.tenantId);
    if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // The club's one public address stands in for the two specific contacts
    // when the owner has not set them (1 Oct 2026): a member always has
    // somewhere to write, and it is the same inbox their replies reach.
    const payload = {
      ...tenant,
      billingContactEmail: tenant.billingContactEmail ?? tenant.contactEmail,
      privacyContactEmail: tenant.privacyContactEmail ?? tenant.contactEmail,
    };
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=300" },
    });
  } catch (e) {
    console.error("[me/gym] DB error, falling back to session data", e);
    return NextResponse.json(fallback);
  }
}
