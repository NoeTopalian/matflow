import { NextResponse } from "next/server";

/**
 * Defence-in-depth same-origin check for non-GET API routes.
 *
 * MatFlow already gets significant CSRF protection from SameSite=Lax cookies
 * (NextAuth default) and the fact that most write endpoints accept JSON, which
 * triggers a CORS preflight that browsers refuse to send cross-origin without
 * explicit allow-list. This helper closes the residual gap for "simple request"
 * content types — `multipart/form-data` and `text/plain` POSTs, which browsers
 * send cross-origin without preflight — by verifying the Origin / Referer
 * header matches an allow-list of expected origins.
 *
 * Apply to:
 *   - File-upload routes (multipart): admin/import/upload, initiatives/[id]/attachments,
 *     waiver/sign, onboarding/csv-handoff, upload
 *
 * Do NOT apply to:
 *   - Webhook endpoints (Stripe, Resend) — they have no Origin header and
 *     authenticate via signature instead.
 *   - Cron endpoints — Bearer token auth.
 *   - Public form submissions (apply) — Origin enforcement would prevent
 *     marketing pages from posting to the API.
 *
 * Usage:
 *   export async function POST(req: Request) {
 *     const violation = assertSameOrigin(req);
 *     if (violation) return violation;
 *     // …rest of handler
 *   }
 */

function buildAllowedOrigins(req: Request): string[] {
  const origins = new Set<string>();

  if (process.env.NEXTAUTH_URL) {
    origins.add(process.env.NEXTAUTH_URL.replace(/\/+$/, ""));
  }
  if (process.env.VERCEL_URL) {
    origins.add(`https://${process.env.VERCEL_URL}`);
  }
  if (process.env.NEXT_PUBLIC_VERCEL_URL) {
    origins.add(`https://${process.env.NEXT_PUBLIC_VERCEL_URL}`);
  }
  if (process.env.NODE_ENV !== "production") {
    origins.add("http://localhost:3000");
    origins.add("http://localhost:3847"); // matflow dev port
  }

  // Trust the request's own host — covers custom domains we haven't enumerated.
  // The Origin header is set by the browser, not the attacker, so this is safe.
  const host = req.headers.get("host");
  if (host) {
    origins.add(`https://${host}`);
    origins.add(`http://${host}`);
  }

  return [...origins];
}

export function assertSameOrigin(req: Request): NextResponse | null {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return null;
  }

  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");

  if (!origin && !referer) {
    return NextResponse.json(
      { error: "Origin or Referer header required for this request" },
      { status: 403 },
    );
  }

  let sourceOrigin: string;
  if (origin) {
    sourceOrigin = origin;
  } else {
    try {
      sourceOrigin = new URL(referer!).origin;
    } catch {
      return NextResponse.json({ error: "Invalid Referer" }, { status: 403 });
    }
  }

  const allowed = buildAllowedOrigins(req);
  if (!allowed.includes(sourceOrigin)) {
    return NextResponse.json(
      { error: "Forbidden: cross-origin request rejected" },
      { status: 403 },
    );
  }

  return null;
}
