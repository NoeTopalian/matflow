/**
 * POST /api/admin/auth/login
 * Body: { secret: string }
 *
 * DEVELOPMENT / TEST ONLY (operator auth hardening, 6 Oct 2026). Sets the
 * `matflow_admin` shared-secret cookie for local tooling.
 *
 * Wherever `sharedAdminSecretPermitted()` is false — Vercel production, any
 * NODE_ENV=production build, anything on the production database — this route
 * refuses BEFORE reading the body: it does not compare the secret, so it can
 * neither grant access nor confirm a guess. Operators sign in with their own
 * account and authenticator (/api/admin/auth/operator-login).
 *
 * Rate-limited per IP to prevent brute force where it is still live.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import { constantTimeEq, adminCookieSetHeaders, sharedAdminSecretPermitted } from "@/lib/admin-auth";

const schema = z.object({ secret: z.string().min(1).max(200) });

export async function POST(req: Request) {
  if (!sharedAdminSecretPermitted()) {
    return NextResponse.json(
      { error: "Shared-secret sign-in is disabled. Sign in with your operator account." },
      { status: 403 },
    );
  }

  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const ip = getClientIp(req);
  const rl = await checkRateLimit(`admin:login:${ip}`, 5, 15 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const expected = process.env.MATFLOW_ADMIN_SECRET;
  if (!expected) {
    console.error("[admin/auth/login] MATFLOW_ADMIN_SECRET unset in env");
    return NextResponse.json({ error: "Admin auth not configured" }, { status: 503 });
  }

  if (!constantTimeEq(parsed.data.secret, expected)) {
    console.warn(`[admin/auth/login] failed admin login attempt from ip=${ip}`);
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  console.warn(`[admin/auth/login] successful development admin login from ip=${ip}`);

  return NextResponse.json({ ok: true }, { status: 200, headers: adminCookieSetHeaders(expected) });
}
