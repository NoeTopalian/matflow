import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "crypto";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

// 5-minute lifetime is enough for the round-trip to Google + callback. Longer
// would let an attacker race a stolen cookie against a legitimate sign-in.
const TTL_SECONDS = 5 * 60;
const COOKIE_NAME = "pendingTenantSlug";

/**
 * The cookie's own key and message (R6-N2, security campaign iteration 2, lane A4, 10 Oct 2026).
 *
 * This signed HMAC(root, slug) and handed the signature to whoever asked. Sub-keys are HMAC(root, context), so a
 * Tenant whose slug equals a context — a raw INSERT; the API slug validators refuse dots, the database does not —
 * made the cookie the provenance ("matflow.import-mapping-provenance.v2"), kiosk ("matflow.kiosk.v1") or card
 * ("matflow.card.v1") sub-key whenever Google sign-in is on (R6 bound a forged provenance decision with it).
 * Now: key = HMAC(root, "matflow.pending-tenant-cookie.v1"), signature = HMAC(key, "pending-tenant:v1:" + slug).
 * Neither the key nor any signature can equal another sub-key, and no other derivation changed.
 *
 * Cookies minted before this change stop verifying: they live TTL_SECONDS (300 s) and the only effect is one more
 * "Continue with Google" click.
 */
export const PENDING_TENANT_KEY_CONTEXT = "matflow.pending-tenant-cookie.v1";
const MESSAGE_PREFIX = "pending-tenant:v1:";

function cookieMac(slug: string): string {
  const key = createHmac("sha256", AUTH_SECRET_VALUE).update(PENDING_TENANT_KEY_CONTEXT).digest();
  return createHmac("sha256", key).update(`${MESSAGE_PREFIX}${slug}`).digest("base64url");
}

function sign(slug: string): string {
  return `${slug}.${cookieMac(slug)}`;
}

function verify(value: string): string | null {
  const idx = value.lastIndexOf(".");
  if (idx <= 0 || idx === value.length - 1) return null;
  const slug = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  const expected = cookieMac(slug);
  if (sig.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return slug;
}

/**
 * Pin the tenant the user picked at the club-code step before redirecting to
 * Google. Read by the NextAuth `signIn` callback when the OAuth callback
 * returns. HMAC-signed with a sub-key of `AUTH_SECRET` (above) so an attacker can't forge a
 * different gym's slug into a victim's session.
 */
export async function setPendingTenantSlug(slug: string): Promise<void> {
  const store = await cookies();
  store.set({
    name: COOKIE_NAME,
    value: sign(slug),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: TTL_SECONDS,
    path: "/",
  });
}

export async function readPendingTenantSlug(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(COOKIE_NAME)?.value;
  if (!value) return null;
  return verify(value);
}

export async function clearPendingTenantSlug(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
