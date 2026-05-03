import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "crypto";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

// 5-minute lifetime is enough for the round-trip to Google + callback. Longer
// would let an attacker race a stolen cookie against a legitimate sign-in.
const TTL_SECONDS = 5 * 60;
const COOKIE_NAME = "pendingTenantSlug";

function sign(slug: string): string {
  const sig = createHmac("sha256", AUTH_SECRET_VALUE).update(slug).digest("base64url");
  return `${slug}.${sig}`;
}

function verify(value: string): string | null {
  const idx = value.lastIndexOf(".");
  if (idx <= 0 || idx === value.length - 1) return null;
  const slug = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  const expected = createHmac("sha256", AUTH_SECRET_VALUE).update(slug).digest("base64url");
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
 * returns. HMAC-signed with `AUTH_SECRET` so an attacker can't forge a
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
