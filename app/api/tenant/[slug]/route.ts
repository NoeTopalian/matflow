import { withRlsBypass } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// Rate-limit slug lookups so an attacker can't enumerate the customer
// directory by hammering this endpoint. 30/min/IP is generous for a real
// user typing their club code (auto-submits at >=4 chars + 600ms debounce
// per app/login/page.tsx).
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

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

const NOT_FOUND_RESPONSE = { error: "Gym not found" } as const;

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const ip = getClientIp(req);
  const { allowed, retryAfterSeconds } = await checkRateLimit(
    `tenant-lookup:${ip}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }

  const { slug } = await params;
  const normalised = slug.toLowerCase().replace(/[^a-z0-9-]/g, "");

  try {
    // Public lookup: caller has no session yet, so RLS context isn't available.
    // Bypass is intentional here — slug is a deliberate identifier the user
    // already knows, and the response excludes anything sensitive.
    const tenant = await withRlsBypass((tx) =>
      tx.tenant.findUnique({
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
          deletedAt: true,
        },
      }),
    );

    // Soft-deleted, suspended, or cancelled tenants must look identical to
    // "doesn't exist" so an attacker can't enumerate state. Same response
    // shape, same status code, no extra signal.
    if (
      !tenant ||
      tenant.deletedAt !== null ||
      tenant.subscriptionStatus === "cancelled" ||
      tenant.subscriptionStatus === "suspended"
    ) {
      throw new Error("not found");
    }

    // Strip deletedAt + subscriptionStatus from the response — they're for
    // the gate above, not the client.
    const { deletedAt: _d, subscriptionStatus: _s, ...publicBranding } = tenant;
    void _d; void _s;
    return NextResponse.json(publicBranding);
  } catch {
    if (DEMO_TENANTS[normalised]) {
      return NextResponse.json(DEMO_TENANTS[normalised]);
    }
    return NextResponse.json(NOT_FOUND_RESPONSE, { status: 404 });
  }
}
