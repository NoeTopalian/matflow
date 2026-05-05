// Kiosk member token — short-TTL signed envelope used between the kiosk
// autocomplete (`GET /api/kiosk/[token]/members`) and the kiosk check-in
// (`POST /api/kiosk/[token]/checkin`).
//
// The autocomplete returns these tokens INSTEAD of raw memberIds so an
// attacker scraping the lookup endpoint can't enumerate member IDs and
// re-use them to post arbitrary check-ins later. The token bakes in the
// tenant id + a 10-minute expiry, HMAC-SHA256-signed with AUTH_SECRET.
//
// Mirrors the pattern of the deleted `lib/checkin-token.ts` from main, with
// field names tightened to match the new kiosk-only surface.

import { createHmac, timingSafeEqual } from "crypto";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

export type KioskMemberTokenPayload = {
  tenantId: string;
  memberId: string;
  exp: number; // unix-seconds
};

const DEFAULT_TTL_SECONDS = 10 * 60;

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function b64urlDecode(s: string): Buffer | null {
  try {
    return Buffer.from(s, "base64url");
  } catch {
    return null;
  }
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
  const sig = createHmac("sha256", AUTH_SECRET_VALUE).update(body).digest();
  return `${body}.${b64urlEncode(sig)}`;
}

export function verifyKioskMemberToken(
  raw: string,
  expectedTenantId: string,
):
  | { ok: true; memberId: string }
  | { ok: false; reason: "malformed" | "expired" | "bad-signature" | "tenant-mismatch" } {
  if (typeof raw !== "string" || !raw.includes(".")) return { ok: false, reason: "malformed" };
  const [body, providedSigB64] = raw.split(".", 2);
  if (!body || !providedSigB64) return { ok: false, reason: "malformed" };

  const expectedSig = createHmac("sha256", AUTH_SECRET_VALUE).update(body).digest();
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
