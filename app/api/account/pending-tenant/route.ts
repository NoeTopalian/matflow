/**
 * POST /api/account/pending-tenant
 *
 * Sets the HMAC-signed `pendingTenantSlug` cookie that the Google OAuth flow
 * reads in the auth.ts `signIn` callback. Called by the login page when the
 * user clicks "Continue with Google" — pins the tenant the user picked at
 * the club-code step before the OAuth round-trip.
 *
 * Auth: none (the cookie is bound to whichever tenant slug the user supplies;
 * the actual security comes from the User/Member existence check in the
 * `signIn` callback after Google returns. Without that, Google sign-in would
 * grant access to any gym.).
 *
 * Body: { tenantSlug: string }
 * Response: { ok: true } + Set-Cookie header
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { setPendingTenantSlug } from "@/lib/pending-tenant-cookie";
import { withRlsBypass } from "@/lib/prisma-tenant";

const schema = z.object({ tenantSlug: z.string().min(1).max(60) });

export const runtime = "nodejs";

export async function POST(req: Request) {
  // Only meaningful when Google OAuth is enabled — fail closed otherwise.
  if (process.env.ENABLE_GOOGLE_OAUTH !== "true") {
    return NextResponse.json({ error: "Google sign-in not enabled" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid tenantSlug" }, { status: 400 });
  }

  const slug = parsed.data.tenantSlug.toLowerCase().trim();

  // Verify the tenant exists before signing — bypass needed because there's
  // no session yet. This avoids minting a cookie for a non-existent gym.
  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { slug }, select: { id: true } }),
  );
  if (!tenant) {
    return NextResponse.json({ error: "Gym not found" }, { status: 404 });
  }

  await setPendingTenantSlug(slug);
  return NextResponse.json({ ok: true });
}
