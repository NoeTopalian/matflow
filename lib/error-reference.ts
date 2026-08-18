/**
 * Error references — the short id a member reads out to their gym owner.
 *
 * When something fails, the client is shown a friendly message plus a
 * reference like `MF-4K7P3R`. The same reference is written into the server
 * log (and onto the Sentry event) next to the real error, stack, route,
 * tenant and user. Nothing internal crosses the wire: the reference is the
 * ONLY thing that correlates "what the user saw" with "what the server knew".
 *
 * Deliberately dependency-free (no `next/*`, no Node built-ins) so the same
 * module can be imported by route handlers, by `instrumentation.ts`, and by
 * client components inside the browser bundle.
 */

/**
 * 27 characters, chosen so a reference survives being read down a phone or
 * typed by someone who did not write it down carefully.
 *
 * The letters B G I L O Q S U Z are excluded because each one is confusable
 * with a character that IS in the set (8, 6, 1, 1, 0, 0, 5, V, 2). Excluding
 * one member of every confusable pair — rather than both — is what makes a
 * mistyped reference *repairable*: `normaliseErrorReference` maps each
 * excluded character back onto its partner, so "MF-O1SG44" typed for
 * "MF-01644" still resolves instead of failing the owner's search.
 *
 * 27^6 ≈ 387 million references. Collisions are irrelevant in practice
 * because the log line also carries a timestamp and route.
 */
export const ERROR_REFERENCE_ALPHABET = "0123456789ACDEFHJKMNPRTVWXY";
export const ERROR_REFERENCE_LENGTH = 6;
export const ERROR_REFERENCE_PREFIX = "MF-";

/** Matches a canonical, already-normalised reference. */
export const ERROR_REFERENCE_PATTERN = /^MF-[0-9ACDEFHJKMNPRTVWXY]{6}$/;

/** Excluded character → the in-alphabet character it is confused with. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  B: "8",
  G: "6",
  I: "1",
  L: "1",
  O: "0",
  Q: "0",
  S: "5",
  U: "V",
  Z: "2",
};

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const webcrypto = globalThis.crypto;
  if (webcrypto && typeof webcrypto.getRandomValues === "function") {
    webcrypto.getRandomValues(out);
    return out;
  }
  // No WebCrypto (very old runtime). A reference is a diagnostic label, never
  // a secret or a capability — a weaker source costs collision odds, nothing
  // else — so degrade rather than throw on the error path.
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/**
 * A fresh reference for one occurrence of a failure. Use this at the point
 * the failure is caught, then log it and return it to the client.
 */
export function newErrorReference(): string {
  const base = ERROR_REFERENCE_ALPHABET.length; // 27
  // Reject bytes at or above 243 so `% 27` stays uniform (256 % 27 = 13,
  // otherwise the first 13 characters of the alphabet would be favoured).
  const limit = 256 - (256 % base);
  let body = "";
  while (body.length < ERROR_REFERENCE_LENGTH) {
    const buf = randomBytes(ERROR_REFERENCE_LENGTH * 2);
    for (let i = 0; i < buf.length && body.length < ERROR_REFERENCE_LENGTH; i++) {
      if (buf[i] < limit) body += ERROR_REFERENCE_ALPHABET[buf[i] % base];
    }
  }
  return ERROR_REFERENCE_PREFIX + body;
}

// FNV-1a, 32-bit. `Math.imul` keeps the multiply in 32-bit range; BigInt is
// unavailable to us because tsconfig targets ES2017.
function fnv1a(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function encode(value: number, chars: number): string {
  const base = ERROR_REFERENCE_ALPHABET.length;
  let v = value >>> 0;
  let out = "";
  for (let i = 0; i < chars; i++) {
    out = ERROR_REFERENCE_ALPHABET[v % base] + out;
    v = Math.floor(v / base);
  }
  return out;
}

/**
 * Derive a reference deterministically from a Next.js error `digest`.
 *
 * Next generates a digest for every server-side render/route error, hands it
 * to `instrumentation.ts`'s `onRequestError` on the server AND to the route
 * segment `error.tsx` boundary on the client. It is the only value that
 * crosses that boundary, so hashing it on both sides is what lets the screen
 * the member is looking at and the server log agree on one reference —
 * without wrapping a single one of the app's 167 route handlers.
 *
 * Consequence worth knowing: a digest is a hash of the error message and
 * stack, so the same bug always yields the same reference. The reference
 * identifies the *failure*, not the occurrence; the log timestamp separates
 * occurrences. References minted by `newErrorReference()` (the `apiError`
 * path) are per-occurrence.
 */
export function errorReferenceFromDigest(digest: string): string {
  return (
    ERROR_REFERENCE_PREFIX +
    encode(fnv1a(digest, 0x811c9dc5), 3) +
    encode(fnv1a(digest, 0x9e3779b1), 3)
  );
}

/**
 * Repair a reference a human typed or dictated, returning the canonical form
 * (`MF-XXXXXX`) or null if it cannot be one. Case-insensitive; tolerates
 * missing/extra prefix, spaces, hyphens, and the confusable characters the
 * alphabet deliberately never emits.
 */
export function normaliseErrorReference(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  // Only strip a leading "MF" when what remains is exactly a body — M and F
  // are both valid body characters, so a bare "MFXXXX" body must survive.
  if (s.length === ERROR_REFERENCE_LENGTH + 2 && s.startsWith("MF")) s = s.slice(2);
  if (s.length !== ERROR_REFERENCE_LENGTH) return null;
  let body = "";
  for (const ch of s) body += CONFUSABLES[ch] ?? ch;
  const candidate = ERROR_REFERENCE_PREFIX + body;
  return ERROR_REFERENCE_PATTERN.test(candidate) ? candidate : null;
}

/** True when `raw` is already a canonical reference. */
export function isErrorReference(raw: unknown): raw is string {
  return typeof raw === "string" && ERROR_REFERENCE_PATTERN.test(raw);
}
