// Kiosk member token — short-TTL signed envelope used between the kiosk
// autocomplete (`GET /api/kiosk/[token]/members`) and the kiosk check-in
// (`POST /api/kiosk/[token]/checkin`).
//
// The autocomplete returns these tokens INSTEAD of raw memberIds so an
// attacker scraping the lookup endpoint can't enumerate member IDs and
// re-use them to post arbitrary check-ins later. The token bakes in the
// tenant id + a 10-minute expiry, HMAC-SHA256-signed with a key derived from
// AUTH_SECRET (see KEY SEPARATION below).
//
// Mirrors the pattern of the deleted `lib/checkin-token.ts` from main, with
// field names tightened to match the new kiosk-only surface.
//
// KEY SEPARATION
// --------------
// This token used to be signed with AUTH_SECRET_VALUE directly, exactly as
// `lib/impersonation.ts` still is. Those two carry the identical
// `base64url(json).base64url(hmac)` envelope, so they were separated only by
// which payload fields each verifier happens to require — SHAPE separation,
// which holds only for as long as nobody adds a field. That is a weak
// guarantee for the one verifier in this repo that runs on a PUBLIC,
// session-free endpoint (`POST /api/kiosk/[token]/checkin`).
//
// It now derives its own key under a fixed context, the pattern
// `lib/card-token.ts` introduced and documents in full. A kiosk token can no
// longer verify anywhere else even if the payload shapes converge.
//
// `lib/impersonation.ts` should get the same treatment. It is deliberately NOT
// changed here: its cookie is read by the auth.ts jwt() callback on every
// request, so re-keying it is a live auth change that belongs in its own
// branch with its own review, not as a side effect of a card-printing fix.
// Deriving here already breaks the shared key, which was the defect.

import { createHmac, timingSafeEqual } from "crypto";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

export type KioskMemberTokenPayload = {
  tenantId: string;
  memberId: string;
  exp: number; // unix-seconds
};

const DEFAULT_TTL_SECONDS = 10 * 60;

/**
 * Key-separation context. Changing this string invalidates every kiosk member
 * token in flight — which is at most ten minutes of them, so it is cheap here
 * in a way it is not for a printed card.
 */
const KIOSK_KEY_CONTEXT = "matflow.kiosk.v1";

/** HMAC-SHA256 of the context string keyed by the root secret. */
function kioskSigningKey(): Buffer {
  return createHmac("sha256", AUTH_SECRET_VALUE).update(KIOSK_KEY_CONTEXT).digest();
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Strict base64url decode: null unless `s` is the CANONICAL encoding of the
 * bytes it decodes to. Back-ported from `lib/card-token.ts`, which carries the
 * full reasoning.
 *
 * `Buffer.from(s, "base64url")` never throws — it skips unrecognised
 * characters and ignores padding — so the try/catch this replaces validated
 * nothing, and `TOKEN`, `TOKEN=` and `TOK EN` were three strings that all
 * verified to one payload. The payload was never forgeable; the token's
 * IDENTITY was not stable, which is what anything de-duplicating or
 * rate-limiting by the token string depends on.
 *
 * Safe for the live kiosk surface: these tokens are minted by
 * `signKioskMemberToken` (always canonical) and travel in a JSON body between
 * `/api/kiosk/[token]/members` and the check-in and waiver endpoints, so
 * nothing re-spells them in transit.
 */
function b64urlDecode(s: string): Buffer | null {
  const buf = Buffer.from(s, "base64url");
  return buf.toString("base64url") === s ? buf : null;
}

export function signKioskMemberToken(
  args: { tenantId: string; memberId: string },
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  const payload: KioskMemberTokenPayload = {
    tenantId: args.tenantId,
    memberId: args.memberId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = createHmac("sha256", kioskSigningKey()).update(body).digest();
  return `${body}.${b64urlEncode(sig)}`;
}

export function verifyKioskMemberToken(
  raw: string,
  expectedTenantId: string,
):
  | { ok: true; memberId: string }
  | { ok: false; reason: "malformed" | "expired" | "bad-signature" | "tenant-mismatch" } {
  if (typeof raw !== "string") return { ok: false, reason: "malformed" };
  // Exactly two segments: `split(".", 2)` discarded a third, so `TOKEN.junk`
  // verified as `TOKEN`.
  const segments = raw.split(".");
  if (segments.length !== 2) return { ok: false, reason: "malformed" };
  const [body, providedSigB64] = segments;
  if (!body || !providedSigB64) return { ok: false, reason: "malformed" };

  const expectedSig = createHmac("sha256", kioskSigningKey()).update(body).digest();
  const provided = b64urlDecode(providedSigB64);
  if (!provided || provided.length !== expectedSig.length) {
    return { ok: false, reason: "bad-signature" };
  }
  if (!timingSafeEqual(provided, expectedSig)) {
    return { ok: false, reason: "bad-signature" };
  }

  const decoded = b64urlDecode(body);
  if (!decoded) return { ok: false, reason: "malformed" };
  let payload: KioskMemberTokenPayload;
  try {
    payload = JSON.parse(decoded.toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload.tenantId !== "string" ||
    typeof payload.memberId !== "string" ||
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
  return { ok: true, memberId: payload.memberId };
}
