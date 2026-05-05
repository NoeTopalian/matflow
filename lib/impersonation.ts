// Super-admin impersonation token + cookie helpers.
//
// Lets a MatFlow operator (Noe) "log in as" any gym owner from /admin/tenants.
// The token carries (adminUserId, targetUserId, targetTenantId, reason, exp)
// HMAC-SHA256-signed with AUTH_SECRET. The auth.ts jwt() callback reads the
// cookie on every request and overrides the session identity to the target
// user. End-impersonation clears the cookie. 60-min TTL.
//
// Mirrors the envelope shape of lib/kiosk-token.ts and lib/login-event.ts:
// base64url(JSON-payload).base64url(HMAC) — three parts separated by '.'.

import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

export const IMPERSONATION_COOKIE = "matflow_impersonation";
const TTL_SECONDS = 60 * 60; // 1 hour

export type ImpersonationPayload = {
  adminUserId: string;
  targetUserId: string;
  targetTenantId: string;
  reason: string;
  exp: number; // unix-seconds
};

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}
function b64urlDecode(s: string): Buffer | null {
  try { return Buffer.from(s, "base64url"); } catch { return null; }
}

export function signImpersonationToken(args: {
  adminUserId: string;
  targetUserId: string;
  targetTenantId: string;
  reason: string;
}): string {
  const payload: ImpersonationPayload = {
    adminUserId: args.adminUserId,
    targetUserId: args.targetUserId,
    targetTenantId: args.targetTenantId,
    reason: args.reason,
    exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  };
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = createHmac("sha256", AUTH_SECRET_VALUE).update(body).digest();
  return `${body}.${b64urlEncode(sig)}`;
}

export function verifyImpersonationToken(
  raw: string,
):
  | { ok: true; payload: ImpersonationPayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" } {
  if (typeof raw !== "string" || !raw.includes(".")) return { ok: false, reason: "malformed" };
  const [body, sigB64] = raw.split(".", 2);
  if (!body || !sigB64) return { ok: false, reason: "malformed" };

  const expected = createHmac("sha256", AUTH_SECRET_VALUE).update(body).digest();
  const provided = b64urlDecode(sigB64);
  if (!provided || provided.length !== expected.length) return { ok: false, reason: "bad-signature" };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: "bad-signature" };

  const decoded = b64urlDecode(body);
  if (!decoded) return { ok: false, reason: "malformed" };
  let payload: ImpersonationPayload;
  try {
    payload = JSON.parse(decoded.toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload.adminUserId !== "string" ||
    typeof payload.targetUserId !== "string" ||
    typeof payload.targetTenantId !== "string" ||
    typeof payload.reason !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (Math.floor(Date.now() / 1000) > payload.exp) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

export async function setImpersonationCookie(args: {
  adminUserId: string;
  targetUserId: string;
  targetTenantId: string;
  reason: string;
}): Promise<void> {
  const token = signImpersonationToken(args);
  const store = await cookies();
  store.set(IMPERSONATION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: TTL_SECONDS,
  });
}

export async function readImpersonationCookie(): Promise<ImpersonationPayload | null> {
  const store = await cookies();
  const raw = store.get(IMPERSONATION_COOKIE)?.value;
  if (!raw) return null;
  const result = verifyImpersonationToken(raw);
  return result.ok ? result.payload : null;
}

export async function clearImpersonationCookie(): Promise<void> {
  const store = await cookies();
  store.delete(IMPERSONATION_COOKIE);
}
