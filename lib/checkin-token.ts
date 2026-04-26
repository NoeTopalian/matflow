import { createHmac, timingSafeEqual } from "crypto";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

const DEFAULT_TTL_SEC = 10 * 60;

function b64url(input: Buffer | string) {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export type CheckinTokenPayload = {
  tenantId: string;
  memberId: string;
  exp: number;
};

export function signCheckinToken(args: { tenantId: string; memberId: string; ttlSec?: number }) {
  const exp = Math.floor(Date.now() / 1000) + (args.ttlSec ?? DEFAULT_TTL_SEC);
  const payload: CheckinTokenPayload = { tenantId: args.tenantId, memberId: args.memberId, exp };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac("sha256", AUTH_SECRET_VALUE).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyCheckinToken(token: string, expectedTenantId: string): CheckinTokenPayload | null {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expectedSig = b64url(createHmac("sha256", AUTH_SECRET_VALUE).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: CheckinTokenPayload;
  try {
    payload = JSON.parse(fromB64url(body).toString("utf8"));
  } catch {
    return null;
  }
  if (payload.tenantId !== expectedTenantId) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
