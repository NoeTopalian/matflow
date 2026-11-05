/**
 * GET /api/tenant/[slug]/logo — a PUBLISHED club's logo as an image file.
 *
 * T9c: Open Graph and JSON-LD need an absolute image URL, and a club logo is
 * stored inline as a raster `data:` URL (T9b), which a crawler cannot fetch.
 * This serves those bytes, and only for a club whose public page is switched
 * on and which admits sign-in. Every other case (unknown, unpublished,
 * suspended, cancelled, deleted, a blob or external logo, no logo) gets the
 * same 404, so the route says nothing a visitor could not already see on the
 * public page itself. Under /api/tenant, which proxy.ts already treats as a
 * public prefix.
 */
import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { resolvePublishedClubId } from "@/lib/public-club-page-server";
import { decodeInlineLogo } from "@/lib/public-club-page";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const NOT_FOUND = () => NextResponse.json({ error: "Not found" }, { status: 404 });

// Each request is a by-slug lookup, so it is rate-limited like the branding
// lookup next door (app/api/tenant/[slug]/route.ts). A link-preview fetcher
// asks once per share; 60 a minute per IP is generous.
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { allowed, retryAfterSeconds } = await checkRateLimit(`tenant-logo:${getClientIp(req)}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }
  const { slug } = await params;
  const tenantId = await resolvePublishedClubId(slug, { fresh: true });
  if (!tenantId) return NOT_FOUND();

  let logoUrl: string | null = null;
  try {
    const row = await withTenantContext(tenantId, (tx) =>
      tx.tenant.findFirst({ where: { id: tenantId }, select: { logoUrl: true } }),
    );
    logoUrl = row?.logoUrl ?? null;
  } catch (e) {
    console.error("[public-club-logo] read failed", { slug }, e);
    return NextResponse.json({ error: "Couldn't load the logo right now." }, { status: 503 });
  }

  const logo = decodeInlineLogo(logoUrl);
  if (!logo) return NOT_FOUND();

  return new NextResponse(Buffer.from(logo.bytes), {
    status: 200,
    headers: {
      "Content-Type": logo.contentType,
      // E-11 proposed default: a 60 s shared cache, no stale-while-revalidate,
      // so an unpublished club's logo stops being served within a minute.
      "Cache-Control": "public, max-age=60, s-maxage=60",
      "Content-Disposition": "inline",
    },
  });
}
