// POST /api/admin/customers/[id]/login-email/check
//
// Operator-only availability check for a login address in ONE club (admin hub
// lane F, 9 Oct 2026; ledger AH-04). Body: { email } (strict).
//
// The club and its owner are resolved on the SERVER from [id]; nothing about
// either is taken from the body. The answer is either
//   { free: true }
// or the minimal detail an operator needs to resolve a conflict:
//   { free: false, holder: { kind: "user"|"member", id, name, status,
//     canSignIn, access, link, version? } }
//   { free: false, holder: { kind: "many", count, holders: [each as above] } }
//     (legacy duplicate: every holder listed, none picked)
// `canSignIn` is computed in the read transaction from the holder's password
// AND live email-bound credentials for the address in this club (a
// passwordless member with an outstanding invite can still activate). A
// staff holder whose only password is an EXPIRED temporary one (the same test
// auth.ts applies at sign-in, lib/temp-password.ts) has access "none": after a
// move nothing but the club owner setting a new temporary password lets them
// back in, and the panel says so before the move (R14, 13 Oct 2026). A
// member holder also carries `version`: an opaque keyed digest of the record
// as checked, which the contact-email route compares again inside its
// transaction (409 if the member changed in between). A non-owner staff
// holder carries the same for the staff login-email route (staff.login_email,
// 12 Oct 2026). No address is echoed.
//
// Club-facing and self-service routes keep their opaque 409 ("already in use
// at this club"): holder detail exists only here, behind the operator gate.
//
// Guards, in order: same-origin; allow-listed MFA operator (shared guard);
// no support session in this browser; DB-backed rate limit per operator;
// tenant and owner resolved server-side. A durable audit row
// (admin.login_email.checked) records the KEYED digest of the address only;
// if it cannot be written, nothing is answered. Responses are never cached.

import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed } from "@/lib/admin-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { getOperatorContext } from "@/lib/operator-context";
import { checkRateLimit } from "@/lib/rate-limit";
import { emailField } from "@/lib/email-normalise";
import { hasImpersonationCookie } from "@/lib/impersonation";
import { SUPPORT_OPERATOR_PLANE_MESSAGE } from "@/lib/support-session";
import { claimLoginIdentity, emailDigest, type LoginIdentityHolder } from "@/lib/login-email";
import { stepUpTarget, stepUpVersionDigestIn } from "@/lib/operator-step-up";
import { isTempPasswordExpired } from "@/lib/temp-password";

export const runtime = "nodejs";

const bodySchema = z.object({ email: emailField(120) }).strict();

// A check is a read, but it names who holds an address: bounded per operator
// (DB-backed bucket, so every instance shares it).
const RL_MAX = 60;
const RL_WINDOW_MS = 60 * 60 * 1000;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });

type Access = "password" | "activation_pending" | "none";
type CheckedSingleHolder = {
  kind: "user" | "member";
  id: string;
  name: string;
  status: string;
  canSignIn: boolean;
  access: Access;
  link: string;
  version?: string;
};
type CheckedHolder = CheckedSingleHolder | { kind: "many"; count: number; holders: CheckedSingleHolder[] };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  if (!(await isAdminAuthed(req))) return json({ error: "Forbidden" }, 403);
  // Session precedence: a browser in a support session has no operator powers
  // (proxy.ts refuses the operator plane too; this is the in-route backstop).
  if (await hasImpersonationCookie()) return json({ error: SUPPORT_OPERATOR_PLANE_MESSAGE }, 403);

  const ctx = await getOperatorContext(req);
  const rl = await checkRateLimit(`admin:login-email-check:${ctx.operatorId}`, RL_MAX, RL_WINDOW_MS);
  if (!rl.allowed) {
    return json({ error: "Too many address checks. Try again shortly." }, 429, { "Retry-After": String(rl.retryAfterSeconds) });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "Enter one valid email address." }, 400);
  const email = parsed.data.email;
  const { id: tenantId } = await params;

  const found = await withRlsBypass(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
    if (!tenant) return { kind: "no_tenant" as const };
    const owner = await tx.user.findFirst({
      where: { tenantId, role: "owner" },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, email: true },
    });
    if (!owner) return { kind: "no_owner" as const };
    // Same holder lookup every writer uses (lib/login-email.ts); the lock it
    // takes is released when this read transaction ends.
    const claim = await claimLoginIdentity(tx, { tenantId, email, exclude: { userId: owner.id } });
    const now = new Date();
    const describe = async (h: LoginIdentityHolder): Promise<CheckedSingleHolder> => {
      if (h.kind === "user") {
        // Null for an owner account (staff.login_email never applies to one),
        // so no version is offered for it.
        const version = await stepUpVersionDigestIn(tx, "staff.login_email", stepUpTarget(tenantId, h.id, "change"));
        // Password sign-in is the only door a staff account keeps once its
        // address is provisional; an expired temporary password has shut it.
        const pw = await tx.user.findFirst({
          where: { id: h.id, tenantId },
          select: { mustChangePassword: true, tempPasswordExpiresAt: true },
        });
        const expired = !!pw && isTempPasswordExpired(pw, now.getTime());
        return {
          kind: "user",
          id: h.id,
          name: h.name,
          status: h.role,
          canSignIn: !expired,
          access: expired ? "none" : "password",
          link: `/dashboard/staff`,
          ...(version ? { version } : {}),
        };
      }
      // Live email-bound credentials for THIS address in THIS club.
      const [links, codes] = await Promise.all([
        tx.magicLinkToken.count({
          where: { tenantId, email, used: false, purpose: { in: ["login", "first_time_signup"] }, expiresAt: { gt: now } },
        }),
        tx.passwordResetToken.count({ where: { tenantId, email, used: false, expiresAt: { gt: now } } }),
      ]);
      const access: Access = h.hasPassword ? "password" : h.canSignIn && links + codes > 0 ? "activation_pending" : "none";
      const version = await stepUpVersionDigestIn(tx, "member.contact_email", stepUpTarget(tenantId, h.id, "change"));
      return {
        kind: "member",
        id: h.id,
        name: h.name,
        status: h.status,
        canSignIn: access !== "none",
        access,
        link: `/dashboard/members/${h.id}`,
        ...(version ? { version } : {}),
      };
    };
    // A legacy duplicate lists every holder, each described as a single one
    // (never resolved by picking one).
    const holder: CheckedHolder | null =
      claim.kind === "none"
        ? null
        : claim.kind === "many"
          ? { kind: "many", count: claim.holders.length, holders: await Promise.all(claim.holders.map(describe)) }
          : await describe(claim);
    return {
      kind: "ok" as const,
      tenant,
      owner: { id: owner.id, name: owner.name },
      sameAsOwner: owner.email.trim().toLowerCase() === email,
      holder,
    };
  });

  if (found.kind === "no_tenant") return json({ error: "Club not found." }, 404);
  if (found.kind === "no_owner") return json({ error: "This club has no owner." }, 404);

  // Privacy-conscious check event: the keyed digest, never the address.
  try {
    await logAudit({
      tenantId,
      userId: null,
      action: "admin.login_email.checked",
      entityType: "Tenant",
      entityId: tenantId,
      metadata: {
        emailDigest: emailDigest(email),
        result: found.holder === null ? "free" : found.holder.kind,
        holderId: found.holder && found.holder.kind !== "many" ? found.holder.id : null,
      },
      actAsUserId: ctx.operatorId,
      operatorId: ctx.named ? ctx.operatorId : null,
      req,
      durable: true,
      outcome: "succeeded",
    });
  } catch (err) {
    console.error("[login-email/check] audit write failed; nothing answered", err);
    return json({ error: "The check could not be recorded. Try again." }, 500);
  }

  const base = { tenant: found.tenant, owner: found.owner };
  if (found.holder === null) return json({ ok: true, free: true, sameAsOwner: found.sameAsOwner, ...base });
  return json({ ok: true, free: false, holder: found.holder, ...base });
}
