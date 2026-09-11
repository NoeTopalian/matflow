// Member card token — the long-lived signed payload printed as a QR code on a
// laminated member ID card. A coach scans a stack of cards to register a class.
//
// WHY THIS IS NOT `lib/kiosk-token.ts`
// ------------------------------------
// The kiosk token is signed with AUTH_SECRET_VALUE directly and is accepted by
// the PUBLIC kiosk check-in endpoint (`app/api/kiosk/[token]/checkin/route.ts`),
// which needs no session at all. A printed card is a physical object: it is
// photographed, left in a bag, posted on Instagram. If the card carried a token
// the kiosk endpoint would verify, every photograph of a card would be a bearer
// credential — anyone could forge attendance and burn the member's class-pack
// credits from outside the building.
//
// So the card token is signed with a SEPARATE key derived from
// AUTH_SECRET_VALUE under a fixed context string. Same root secret, different
// domain: a card token cannot verify as a kiosk token and a kiosk token cannot
// verify as a card token, without either surface having to know about the
// other. `tests/unit/card-token.test.ts` holds that boundary.
//
// The scanner surface that consumes these tokens is
// `app/api/checkin/card/route.ts`, driven by `components/dashboard/CardScanner`
// at /dashboard/scan. It is staff-authenticated and compares the decoded
// `cardVersion` against `Member.cardVersion`, which is why `verifyCardToken`
// returns the version rather than swallowing it.
//
// REVOCATION IS OPERABLE. `POST /api/members/[id]/card/revoke` increments the
// column (staff gate, same as the print page; audit row with a required
// reason), and the scanner refuses any card whose version disagrees. So a lost
// card is killed by revoking and reprinting, and the five-year expiry is a
// backstop against a card found in a drawer rather than the revocation path.
//
// ROTATION IS A MASS-REPRINT EVENT. The card key derives from
// AUTH_SECRET_VALUE, so rotating NEXTAUTH_SECRET / AUTH_SECRET invalidates
// every laminated card in circulation at once — and over a five-year card life
// that is close to certain to happen. `payload.keyId` records WHICH signing
// generation a card was minted under, so a future verifier can keep the
// previous secret alongside the new one and tell "printed under the old key,
// reprint it" apart from "forged", instead of reporting both as an invalid
// card. docs/RUNBOOK.md § Secret rotation carries the operational half.

import { createHmac, timingSafeEqual } from "crypto";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

export type CardTokenPayload = {
  tenantId: string;
  memberId: string;
  cardVersion: number;
  purpose: "card";
  /**
   * Fingerprint of the signing key this card was minted under — NOT the key.
   * A card outlives several rotations of the root secret, and without this a
   * card signed under the previous secret is indistinguishable from a forgery:
   * both fail on the signature and both would be reported to a coach as an
   * invalid card. See ROTATION in the module header.
   */
  keyId: string;
  exp: number; // unix-seconds
};

/**
 * Key-separation context. Changing this string invalidates every card in
 * circulation, so it is versioned: a future `matflow.card.v2` is a deliberate
 * mass-reprint, never a refactor.
 */
const CARD_KEY_CONTEXT = "matflow.card.v1";

/** Separate context so the fingerprint is a PRF output over the card key, not
 *  any part of the key itself. Six base64url characters — enough to tell two
 *  signing generations apart, far too few to attack. */
const CARD_KEYID_CONTEXT = "matflow.card.keyid";
const CARD_KEYID_LENGTH = 6;

/**
 * Five years. A laminated card is reprinted when a member is promoted or the
 * card is lost, not on a schedule, so the expiry is a backstop against a card
 * found in a drawer a decade later.
 *
 * It is a backstop and not the revocation path: `Member.cardVersion` is the
 * revocation handle, this module returns it, and both halves that make it work
 * now exist — the revoke endpoint that bumps the column and the scanner that
 * checks it. A lost card is cancelled immediately rather than waiting out the
 * five years.
 */
const DEFAULT_TTL_SECONDS = 5 * 365 * 24 * 60 * 60;

/**
 * HMAC-SHA256 of the context string keyed by the root secret. Deriving rather
 * than concatenating means the card key is not recoverable from a card token,
 * and a leak of one domain's signatures says nothing about the other's.
 */
function cardSigningKey(): Buffer {
  return createHmac("sha256", AUTH_SECRET_VALUE).update(CARD_KEY_CONTEXT).digest();
}

/** Which signing generation a card was minted under. Derived from the card key
 *  under its own context, so it is a one-way fingerprint. */
function cardKeyId(): string {
  return createHmac("sha256", cardSigningKey())
    .update(CARD_KEYID_CONTEXT)
    .digest()
    .toString("base64url")
    .slice(0, CARD_KEYID_LENGTH);
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Strict base64url decode: null unless `s` is the CANONICAL encoding of the
 * bytes it decodes to.
 *
 * `Buffer.from(s, "base64url")` never throws. It silently skips characters it
 * does not recognise and ignores padding, so the try/catch this replaces
 * caught nothing and the null it advertised could not occur — input validation
 * in appearance only. Worse, it made the token ENVELOPE malleable: `TOKEN`,
 * `TOKEN=` and `TOK EN` decoded to identical bytes, so one card yielded
 * unlimited distinct strings that all verify.
 *
 * Authenticity was never at risk — the payload is signed. IDENTITY was: the
 * batch scanner (task 5c-2) de-duplicates a stack of scans by the scanned
 * string before it can do a database round trip, so a scanner emitting a
 * trailing newline, or a member appending a character to a photographed card,
 * would register the same member twice and burn a second class-pack credit.
 * Any future rate limit or card blocklist keyed on the token string would be
 * defeated the same way. One card must mean exactly one string.
 */
function b64urlDecode(s: string): Buffer | null {
  const buf = Buffer.from(s, "base64url");
  return buf.toString("base64url") === s ? buf : null;
}

export function signCardToken(
  args: { tenantId: string; memberId: string; cardVersion: number },
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  // lib/auth-secret.ts only throws on an empty secret in production, which is
  // right for a session cookie and wrong for this: a card minted from a
  // misconfigured non-production build would be signed with an EMPTY HMAC key,
  // forgeable by anyone who reads this file, and then laminated and carried
  // around for five years. Refuse to mint one at all.
  if (!AUTH_SECRET_VALUE) {
    throw new Error(
      "NEXTAUTH_SECRET or AUTH_SECRET must be set before printing member cards — refusing to sign a physical credential with an empty key",
    );
  }

  const payload: CardTokenPayload = {
    tenantId: args.tenantId,
    memberId: args.memberId,
    cardVersion: args.cardVersion,
    purpose: "card",
    keyId: cardKeyId(),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = createHmac("sha256", cardSigningKey()).update(body).digest();
  return `${body}.${b64urlEncode(sig)}`;
}

export function verifyCardToken(
  raw: string,
  expectedTenantId: string,
):
  | { ok: true; memberId: string; cardVersion: number; keyId: string }
  | { ok: false; reason: "malformed" | "expired" | "bad-signature" | "tenant-mismatch" } {
  if (typeof raw !== "string") return { ok: false, reason: "malformed" };
  // `split(".", 2)` silently DISCARDED a third segment, so `TOKEN.junk`
  // verified as `TOKEN`. A card token has exactly two segments.
  const segments = raw.split(".");
  if (segments.length !== 2) return { ok: false, reason: "malformed" };
  const [body, providedSigB64] = segments;
  if (!body || !providedSigB64) return { ok: false, reason: "malformed" };

  const expectedSig = createHmac("sha256", cardSigningKey()).update(body).digest();
  // b64urlDecode is canonical-only, so a re-encoded or padded signature is
  // rejected here rather than quietly accepted as a second valid spelling of
  // the same card.
  const provided = b64urlDecode(providedSigB64);
  if (!provided || provided.length !== expectedSig.length) {
    return { ok: false, reason: "bad-signature" };
  }
  if (!timingSafeEqual(provided, expectedSig)) {
    return { ok: false, reason: "bad-signature" };
  }

  const decoded = b64urlDecode(body);
  if (!decoded) return { ok: false, reason: "malformed" };
  let payload: CardTokenPayload;
  try {
    payload = JSON.parse(decoded.toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload.tenantId !== "string" ||
    typeof payload.memberId !== "string" ||
    typeof payload.cardVersion !== "number" ||
    !Number.isInteger(payload.cardVersion) ||
    payload.purpose !== "card" ||
    typeof payload.keyId !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (Math.floor(Date.now() / 1000) > payload.exp) {
    return { ok: false, reason: "expired" };
  }
  if (payload.tenantId !== expectedTenantId) {
    return { ok: false, reason: "tenant-mismatch" };
  }
  return {
    ok: true,
    memberId: payload.memberId,
    cardVersion: payload.cardVersion,
    keyId: payload.keyId,
  };
}
