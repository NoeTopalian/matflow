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
// The scanner surface that consumes these tokens is task 5c-2 and does not
// exist yet. It will be staff-authenticated, and it must compare the decoded
// `cardVersion` against `Member.cardVersion` so a lost or reprinted card can be
// revoked by bumping the column — which is why `verifyCardToken` returns the
// version rather than swallowing it.

import { createHmac, timingSafeEqual } from "crypto";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

export type CardTokenPayload = {
  tenantId: string;
  memberId: string;
  cardVersion: number;
  purpose: "card";
  exp: number; // unix-seconds
};

/**
 * Key-separation context. Changing this string invalidates every card in
 * circulation, so it is versioned: a future `matflow.card.v2` is a deliberate
 * mass-reprint, never a refactor.
 */
const CARD_KEY_CONTEXT = "matflow.card.v1";

/**
 * Five years. A laminated card is reprinted when a member is promoted or the
 * card is lost, not on a schedule, so the expiry is a backstop against a card
 * found in a drawer a decade later — not the revocation mechanism. Revocation
 * is `Member.cardVersion`.
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
  const payload: CardTokenPayload = {
    tenantId: args.tenantId,
    memberId: args.memberId,
    cardVersion: args.cardVersion,
    purpose: "card",
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
  | { ok: true; memberId: string; cardVersion: number }
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
  return { ok: true, memberId: payload.memberId, cardVersion: payload.cardVersion };
}
