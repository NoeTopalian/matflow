import { createHmac } from "crypto";
import { prisma } from "@/lib/prisma";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { normaliseIp } from "@/lib/login-fingerprint";

/**
 * Password-failure lockout, v2 (SF-35 + SF-59, security campaign iteration 2,
 * lane A2, 9 Oct 2026).
 *
 * WHAT IT REPLACES. Ten consecutive wrong passwords set `lockedUntil` on the
 * account row for an hour, and the sign-in form then said "This account is
 * temporarily locked" — only for an account that EXISTS (SEC-002: after ten
 * guesses the message is an existence oracle). And anyone who knew an address
 * could re-lock it every ~75 minutes with ~10 requests, from anywhere, keeping
 * the real person out indefinitely (SEC-079); in front of it a per-address
 * attempt limit (5 per 15 minutes from ALL sources) let five requests do the
 * same for a quarter of an hour.
 *
 * THE MODEL NOW. Failures are counted against the ADDRESS STRING (club +
 * normalised email), never against a row, so an address with no account
 * reaches exactly the same state after exactly the same requests: the answer
 * cannot depend on whether the account exists. Two counters, one hour each:
 *
 *   pair  — failures for this address from this network (/24 IPv4, /48 IPv6).
 *           PAIR_MAX reached → refused from this network. Applies to everyone.
 *   addr  — failures for this address from all networks. ADDR_MAX reached →
 *           refused from any network that is NOT a known device of the
 *           account (a LoginEvent for this person on this device fingerprint,
 *           not disowned, seen in the last KNOWN_DEVICE_DAYS). The person keeps
 *           signing in from the phone and laptop they always use while an
 *           attacker elsewhere holds the counter up; the attacker gains nothing
 *           from that exemption, because their own network is still capped by
 *           `pair`, and a guess from a known device must also come from the
 *           victim's own network AND browser family.
 *
 * Only FAILURES count (a correct password spends nothing), and a success
 * clears this network's `pair` counter. The `addr` counter is not cleared by a
 * success: it is shared, and resetting it whenever the real person signs in
 * would hand a distributed guesser a fresh budget.
 *
 * The refusal is ONE generic answer for every throttle and lock, worded so it
 * is true whether or not the account exists; the detail (which counter, the
 * hashed subject) goes to the server log only.
 *
 * FAIL CLOSED. Every read here throws on a database error and the caller
 * refuses the sign-in. The counters live in RateLimitHit (lane F's table and
 * pruning: rows older than an hour are swept, which matches WINDOW_MS); the
 * bucket names carry an HMAC of the address, not the address.
 */

export const LOCKOUT_WINDOW_MS = 60 * 60 * 1000;
export const PAIR_MAX = 10;
export const ADDR_MAX = 10;
export const KNOWN_DEVICE_DAYS = 90;

/** The words a person sees for every lockout / throttle. True whether or not the account exists. */
export const SIGN_IN_THROTTLED_MESSAGE =
  "Too many sign-in attempts for this email. Wait up to an hour and try again, sign in from a device you've used before, or use a sign-in link or password reset instead.";

/**
 * The client IP for sign-in, by the same trust order as getClientIp() in
 * lib/rate-limit.ts (x-vercel-forwarded-for, then x-real-ip, then the LAST
 * x-forwarded-for hop; "unknown" otherwise). A copy rather than an import so
 * the many unit tests that replace lib/rate-limit wholesale do not silently
 * change how sign-in reads the network; tests/unit/sec-a2-lockout-oracle.test.ts
 * pins the two to the same answers.
 */
export function requestClientIp(headers: Headers): string {
  const vercel = headers.get("x-vercel-forwarded-for")?.trim();
  if (vercel) return vercel.split(",")[0].trim();
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return "unknown";
}

function keyed(kind: string, ...parts: string[]): string {
  const mac = createHmac("sha256", AUTH_SECRET_VALUE ?? "")
    .update(`auth-lockout.v2.${kind}\u0000${parts.join("\u0000")}`)
    .digest("hex")
    .slice(0, 40);
  return `authfail:${kind}:${mac}`;
}

export interface LockoutKeys {
  pair: string;
  addr: string;
}

export function lockoutKeys(tenantSlug: string, email: string, clientIp: string): LockoutKeys {
  const slug = tenantSlug.toLowerCase().trim();
  const addr = email.toLowerCase().trim();
  return {
    pair: keyed("pair", slug, addr, normaliseIp(clientIp)),
    addr: keyed("addr", slug, addr),
  };
}

async function countRecent(bucket: string): Promise<number> {
  return prisma.rateLimitHit.count({
    where: { bucket, hitAt: { gte: new Date(Date.now() - LOCKOUT_WINDOW_MS) } },
  });
}

export type LockoutState =
  | { blocked: false; addrCapped: boolean }
  | { blocked: true; reason: "pair" | "addr" };

/**
 * Where this address stands, BEFORE the password is looked at. `isKnownDevice`
 * is consulted only when the address-wide cap is reached; it must not throw
 * for an address with no account (the caller passes a resolver that answers
 * false without a lookup difference — see auth.ts).
 */
export async function lockoutState(
  keys: LockoutKeys,
  isKnownDevice: () => Promise<boolean>,
): Promise<LockoutState> {
  const [pair, addr] = await Promise.all([countRecent(keys.pair), countRecent(keys.addr)]);
  if (pair >= PAIR_MAX) return { blocked: true, reason: "pair" };
  if (addr >= ADDR_MAX) {
    // Always resolved, so the known and unknown paths cost the same.
    const known = await isKnownDevice();
    if (!known) return { blocked: true, reason: "addr" };
    return { blocked: false, addrCapped: true };
  }
  return { blocked: false, addrCapped: false };
}

/** A wrong password: one row in each counter. Returns the address-wide count after it. */
export async function recordFailure(keys: LockoutKeys): Promise<number> {
  await prisma.rateLimitHit.createMany({ data: [{ bucket: keys.pair }, { bucket: keys.addr }] });
  return countRecent(keys.addr);
}

/** A correct password: this network's counter starts again. */
export async function clearPairOnSuccess(keys: LockoutKeys): Promise<void> {
  await prisma.rateLimitHit.deleteMany({ where: { bucket: keys.pair } });
}
