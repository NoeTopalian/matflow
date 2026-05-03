/**
 * POST /api/admin/auth/login
 * Body: { secret: string }
 * Sets the matflow_admin cookie on success. Used by /admin/login page to gate /admin/*.
 *
 * Rate-limited per IP to prevent brute force.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { constantTimeEq, adminCookieSetHeaders } from "@/lib/admin-auth";

const schema = z.object({ secret: z.string().min(1).max(200) });

export async function POST(req: Request) {
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
    // Audit failed admin-login attempts so brute-force surfaces in logs.
    console.warn(`[admin/auth/login] failed admin login attempt from ip=${ip}`);
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  // Super-admin events have no tenant context — log to console (visible in
  // Vercel logs / Sentry) instead of the tenant-scoped AuditLog table.
  console.warn(`[admin/auth/login] successful admin login from ip=${ip}`);

  return NextResponse.json({ ok: true }, { status: 200, headers: adminCookieSetHeaders(expected) });
}
