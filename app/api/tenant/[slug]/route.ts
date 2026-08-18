import { withRlsBypass } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// Rate-limit slug lookups so an attacker can't enumerate the customer
// directory by hammering this endpoint. 30/min/IP is generous for a real
// user typing their club code (auto-submits at >=4 chars + 600ms debounce
// per app/login/page.tsx).
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// Fabricated branding for running the login page without a database. Guarded
// by NODE_ENV at its only use site below — it must never answer a production
// request. See the catch block for the full reasoning.
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
const LOOKUP_FAILED_RESPONSE = {
  error: "Couldn't look up that club right now. Please try again shortly.",
} as const;

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
      // Returned here, not thrown: the catch below now means "the lookup
      // itself failed", and an unknown slug is a perfectly successful lookup
      // with a negative answer. Conflating the two is what let a database
      // outage answer with fabricated branding.
      return NextResponse.json(NOT_FOUND_RESPONSE, { status: 404 });
    }

    // Strip deletedAt + subscriptionStatus from the response — they're for
    // the gate above, not the client.
    const { deletedAt: _d, subscriptionStatus: _s, ...publicBranding } = tenant;
    void _d; void _s;
    // Edge cache: branding rarely changes; 60s freshness + 10 min SWR keeps
    // the login-page typeahead snappy without forcing a DB hit per keystroke.
    // Only the success response is cached — 404s stay live so a new tenant
    // can claim a previously-unused slug without a stale cache window.
    return NextResponse.json(publicBranding, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600" },
    });
  } catch (e) {
    // Only a genuine lookup failure reaches here (database unreachable, RLS
    // bypass rejected, and so on) — never "no such slug".
    //
    // DEMO_TENANTS fabricates a real club's identity. Serving it in
    // production would hand one club's branding to whoever asked, which
    // UI-RULES §7 forbids outright ("no fabricated placeholder data"), and
    // would make an outage look like a working login page. It is a
    // developer convenience for running the login screen with no database,
    // so it is confined to non-production and nothing else.
    if (process.env.NODE_ENV !== "production" && DEMO_TENANTS[normalised]) {
      return NextResponse.json(DEMO_TENANTS[normalised]);
    }

    // UI-RULES §7: an HTTP error is never an empty state. A 404 here would
    // tell a real member of a real club "Gym not found" during an outage and
    // send them away believing they mistyped their own club code. 503 is the
    // honest answer and lets the client show a retry instead.
    console.error("[tenant-lookup] branding lookup failed", { slug: normalised }, e);
    return NextResponse.json(LOOKUP_FAILED_RESPONSE, { status: 503 });
  }
}
