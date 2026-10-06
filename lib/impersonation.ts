// Support (impersonation) sessions: token, cookie and per-request validity.
//
// Lets a named, MFA-verified MatFlow operator "log in as" a gym owner from
// /admin/tenants to SEE what they see. Support access is READ-ONLY
// (lib/support-session.ts; enforced in proxy.ts and lib/api-authz.ts).
//
// The `matflow_impersonation` cookie carries a signed token:
//   { v: 2, adminUserId, opSv, targetUserId, targetTenantId, tsv, reason, n, exp }
//   opSv = the operator's sessionVersion when support started
//   tsv  = the target user's sessionVersion when support started
//   n    = a random nonce; SHA-256(n) is stored on the Operator row
//          (supportNonceHash / supportExpiresAt) — one live support session per
//          operator, cleared by the stop.
// HMAC-SHA256 over a domain-separated string ("impersonation.v2.<body>"), so no
// other token signed with AUTH_SECRET verifies as this one, and a v1 cookie
// (no domain, no binding) does not verify at all — the deploy ends every
// support session that predates it.
//
// The auth.ts jwt() callback calls resolveActiveImpersonation() on EVERY
// request. Support authority ends on the next request when any of these fail:
//   - cookie missing / bad signature / expired (30 minutes)
//   - stop: the nonce on the Operator row no longer matches (a copied cookie
//     dies with the stop, and with the next start, which supersedes it)
//   - the operator's own MFA session cookie is absent, invalid, of another
//     operator, or its sessionVersion moved (logout, revoke, recovery) — a
//     captured support cookie is useless without the operator's live session
//   - the operator no longer has an authenticator (disabled / recovered)
//   - the target's sessionVersion moved (password reset, 2FA reset, suspend)
//   - the target's club is suspended, cancelled or deleted
//     (lib/tenant-admission.ts)
//
// readImpersonationCookie() stays as the signature-and-expiry-only read, for
// attribution (lib/audit-log.ts): a row must name the operator even when the
// session is in the middle of being ended.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { OP_SESSION_COOKIE, verifyOperatorSession } from "@/lib/operator-auth";
import { tenantAdmission } from "@/lib/tenant-admission";

export const IMPERSONATION_COOKIE = "matflow_impersonation";
/** 30 minutes. Was 60; a support look-around does not need an hour of borrowed identity. */
export const SUPPORT_SESSION_TTL_SECONDS = 30 * 60;
const HMAC_DOMAIN = "impersonation.v2.";

export type ImpersonationPayload = {
  v: 2;
  adminUserId: string;
  /** Operator.sessionVersion at start. */
  opSv: number;
  targetUserId: string;
  targetTenantId: string;
  /** Target User.sessionVersion at start. */
  tsv: number;
  reason: string;
  /** Nonce; its SHA-256 is Operator.supportNonceHash while this session is live. */
  n: string;
  exp: number; // unix-seconds
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sign(body: string): Buffer {
  return createHmac("sha256", AUTH_SECRET_VALUE).update(`${HMAC_DOMAIN}${body}`).digest();
}

function b64urlDecode(s: string): Buffer | null {
  try { return Buffer.from(s, "base64url"); } catch { return null; }
}

export function signImpersonationToken(args: Omit<ImpersonationPayload, "v" | "exp"> & { exp?: number }): string {
  const payload: ImpersonationPayload = {
    v: 2,
    adminUserId: args.adminUserId,
    opSv: args.opSv,
    targetUserId: args.targetUserId,
    targetTenantId: args.targetTenantId,
    tsv: args.tsv,
    reason: args.reason,
    n: args.n,
    exp: args.exp ?? Math.floor(Date.now() / 1000) + SUPPORT_SESSION_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body).toString("base64url")}`;
}

export function verifyImpersonationToken(
  raw: string,
  opts: { allowExpired?: boolean } = {},
):
  | { ok: true; payload: ImpersonationPayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" } {
  if (typeof raw !== "string" || raw.length > 4096 || !raw.includes(".")) return { ok: false, reason: "malformed" };
  const parts = raw.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [body, sigB64] = parts;
  if (!body || !sigB64) return { ok: false, reason: "malformed" };

  const expected = sign(body);
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
    !payload ||
    payload.v !== 2 ||
    typeof payload.adminUserId !== "string" ||
    !Number.isSafeInteger(payload.opSv) ||
    typeof payload.targetUserId !== "string" ||
    typeof payload.targetTenantId !== "string" ||
    !Number.isSafeInteger(payload.tsv) ||
    typeof payload.reason !== "string" ||
    typeof payload.n !== "string" ||
    payload.n.length < 16 ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (!opts.allowExpired && Math.floor(Date.now() / 1000) > payload.exp) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/**
 * Start a support session: record its nonce on the Operator row (superseding
 * any earlier one) and set the cookie. The caller has already checked the
 * operator (named, MFA session, step-up), the reason and the target.
 */
export async function startSupportSession(args: {
  operatorId: string;
  operatorSessionVersion: number;
  target: { id: string; tenantId: string; sessionVersion: number };
  reason: string;
}): Promise<{ expiresAt: Date }> {
  const n = randomBytes(24).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + SUPPORT_SESSION_TTL_SECONDS;
  const expiresAt = new Date(exp * 1000);
  await prisma.operator.update({
    where: { id: args.operatorId },
    data: { supportNonceHash: sha256Hex(n), supportExpiresAt: expiresAt },
  });
  const token = signImpersonationToken({
    adminUserId: args.operatorId,
    opSv: args.operatorSessionVersion,
    targetUserId: args.target.id,
    targetTenantId: args.target.tenantId,
    tsv: args.target.sessionVersion,
    reason: args.reason,
    n,
    exp,
  });
  const store = await cookies();
  // SameSite=strict, like every other admin cookie (audit A6I1-S-3).
  store.set(IMPERSONATION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SUPPORT_SESSION_TTL_SECONDS,
  });
  return { expiresAt };
}

/**
 * End support server-side. With a payload, clears that session's nonce only if
 * it is still the live one; with just an operator id, clears whatever support
 * session that operator has. Either way a copied cookie stops working.
 */
export async function endSupportSession(args: { operatorId: string; nonce?: string }): Promise<number> {
  const res = await prisma.operator.updateMany({
    where: {
      id: args.operatorId,
      supportNonceHash: args.nonce ? sha256Hex(args.nonce) : { not: null },
    },
    data: { supportNonceHash: null, supportExpiresAt: null },
  });
  // How many live support sessions this call ended (0 or 1).
  return res.count;
}

/** Signature + expiry only. For attribution and the banner's countdown. */
export async function readImpersonationCookie(): Promise<ImpersonationPayload | null> {
  const store = await cookies();
  const raw = store.get(IMPERSONATION_COOKIE)?.value;
  if (!raw) return null;
  const result = verifyImpersonationToken(raw);
  return result.ok ? result.payload : null;
}

/** The raw cookie's payload even if expired (signature still verified). For the stop. */
export async function readImpersonationCookieForStop(): Promise<ImpersonationPayload | null> {
  const store = await cookies();
  const raw = store.get(IMPERSONATION_COOKIE)?.value;
  if (!raw) return null;
  const result = verifyImpersonationToken(raw, { allowExpired: true });
  return result.ok ? result.payload : null;
}

/**
 * Whether the request carries a support cookie at all (no verification). Used by
 * auth.ts jwt() to fail CLOSED when resolveActiveImpersonation() throws: with a
 * cookie present, "no support" cannot be assumed (review finding D1, 6 Oct 2026).
 */
export async function hasImpersonationCookie(): Promise<boolean> {
  const store = await cookies();
  return !!store.get(IMPERSONATION_COOKIE)?.value;
}

export type ActiveImpersonationTarget = {
  id: string;
  /** Shown in the support view instead of the previous user's (lane J item 9). */
  name: string;
  email: string;
  role: string;
  sessionVersion: number;
  tenantId: string;
  tenant: { name: string; slug: string; primaryColor: string; secondaryColor: string; textColor: string };
};

/**
 * The support session in force for THIS request, or null. Every binding in the
 * header comment is checked here, against the database, on every call. Throws
 * only on a database error; callers treat a throw as "no support session"
 * (fail closed).
 */
export async function resolveActiveImpersonation(): Promise<
  { payload: ImpersonationPayload; target: ActiveImpersonationTarget } | null
> {
  const store = await cookies();
  const raw = store.get(IMPERSONATION_COOKIE)?.value;
  if (!raw) return null;
  const verified = verifyImpersonationToken(raw);
  if (!verified.ok) return null;
  const imp = verified.payload;

  // The operator's own full (MFA) session must be presented with it, be the
  // same operator and the same sessionVersion the support session was bound to.
  const opCookie = store.get(OP_SESSION_COOKIE)?.value;
  const opSession = opCookie ? verifyOperatorSession(opCookie) : null;
  if (!opSession || opSession.operatorId !== imp.adminUserId || opSession.sessionVersion !== imp.opSv) return null;

  const op = await prisma.operator.findUnique({
    where: { id: imp.adminUserId },
    select: { sessionVersion: true, totpEnabled: true, supportNonceHash: true, supportExpiresAt: true },
  });
  if (!op || op.sessionVersion !== imp.opSv || op.totpEnabled !== true) return null;
  if (!op.supportNonceHash || op.supportNonceHash !== sha256Hex(imp.n)) return null;
  if (!op.supportExpiresAt || op.supportExpiresAt.getTime() <= Date.now()) return null;

  const target = await withRlsBypass((tx) =>
    tx.user.findUnique({
      where: { id: imp.targetUserId },
      select: {
        // name + email: the swap shows the TARGET in the support view, not the
        // previous user (or, for a carrier, nobody) — lane J item 9.
        id: true, name: true, email: true, role: true, sessionVersion: true, tenantId: true,
        tenant: {
          select: {
            name: true, slug: true, primaryColor: true, secondaryColor: true, textColor: true,
            subscriptionStatus: true, deletedAt: true,
          },
        },
      },
    }),
  );
  if (!target || target.tenantId !== imp.targetTenantId) return null;
  if (target.sessionVersion !== imp.tsv) return null;
  if (!tenantAdmission(target.tenant).admits) return null;

  return {
    payload: imp,
    target: {
      id: target.id,
      name: target.name,
      email: target.email,
      role: target.role,
      sessionVersion: target.sessionVersion,
      tenantId: target.tenantId,
      tenant: {
        name: target.tenant.name,
        slug: target.tenant.slug,
        primaryColor: target.tenant.primaryColor,
        secondaryColor: target.tenant.secondaryColor,
        textColor: target.tenant.textColor,
      },
    },
  };
}

export async function clearImpersonationCookie(): Promise<void> {
  const store = await cookies();
  // Same attributes as the write in startSupportSession, Secure included, and
  // maxAge 0 — not store.delete(), whose Set-Cookie carries no Secure (review
  // of lane I, D-I1; harmless for this unprefixed name today, fatal for a
  // __Secure- one).
  store.set(IMPERSONATION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
}
