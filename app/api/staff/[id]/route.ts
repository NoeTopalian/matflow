import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { emailField } from "@/lib/email-normalise";
import bcrypt from "bcryptjs";
import { logAudit } from "@/lib/audit-log";
import { updateMetadata } from "@/lib/audit-snapshot";
import { stripTotpFields } from "@/lib/totp-immutable";
import { assertSameOrigin } from "@/lib/csrf";
import { refuseSupportSession } from "@/lib/support-session";
import { requireApiOwner, sessionTotpPending } from "@/lib/api-authz";
import { tempPasswordExpiresAt } from "@/lib/temp-password";
import { staffPasswordSchema } from "@/lib/password-policy";
import { emailDigest, loginEmailTaken, retireEmailBoundTokens } from "@/lib/login-email";

/**
 * An owner editing a member of staff (8 Oct 2026, handover lane S-staff): the
 * login email and the password follow the same rules as the self-service
 * flows (docs/runbooks/ACCOUNT-EDITING.md).
 *
 * - Login email: must be free across staff AND members of this club (a staff
 *   row shadows a member with the same address at sign-in); a collision is a
 *   409 that does not say whose it is. A new address is saved PROVISIONAL —
 *   there is no verification flow, so it is an identifier, not a proven
 *   mailbox (lib/login-email.ts) — and every reset code and sign-in link for
 *   the old and the new address in this club is retired. The audit row holds
 *   SHA-256 digests of both addresses, never the addresses; an email change is
 *   therefore not undoable from the Activity log (the owner edits it back here,
 *   through these same checks).
 * - Password: the shared strength rule (lib/password-policy.ts), and it is
 *   TEMPORARY: forced change at next sign-in, expires in 72 h.
 * - Role, email or password changes bump sessionVersion (signs the person out);
 *   a role or address equal to the stored one is not a change.
 * - Gate: requireApiOwner (lib/api-authz.ts) — an owner session still owing
 *   its authenticator code, on a temporary password or not yet enrolled is
 *   refused here as well as by proxy.ts.
 * - Never an owner row (the owner's own included), never another club's row;
 *   the assignable roles never include owner. Unknown body keys are dropped.
 */
const WEAK_TEMP_PASSWORD =
  "The temporary password needs at least 10 characters, with an upper-case letter, a lower-case letter and a number.";
const EMAIL_UNAVAILABLE = "That email address can't be used for this account. Choose another.";

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: emailField().optional(),
  role: z.enum(["manager", "coach", "admin"]).optional(),
  newPassword: staffPasswordSchema.optional(),
  // Sprint 5 US-508: optimistic concurrency precondition.
  updatedAt: z.string().optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  // Lane 1 iter-1 S-03 fix: CSRF guard.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const gate = await requireApiOwner();
  if (!gate.ok) {
    // A signed-in non-owner keeps this route's own wording (pinned by the e2e
    // campaign); every other refusal is the shared gate's answer.
    if (gate.response.status === 403) {
      const s = await auth();
      if (s?.user && !sessionTotpPending(s) && s.user.role !== "owner") {
        const support = refuseSupportSession(s); if (support) return support;
        return NextResponse.json({ error: "Only owners can edit staff" }, { status: 403 });
      }
    }
    return gate.response;
  }
  const session = gate.session;
  const support = refuseSupportSession(session); if (support) return support; // read-only support session (lib/support-session.ts)

  const { id } = await params;

  let body: unknown;
  try {
    // Defence in depth: strip TOTP fields. The Zod schema is already an
    // allowlist that doesn't include them, but stripping early documents
    // the no-self-disable invariant at the route entry point.
    body = stripTotpFields(await req.json() as Record<string, unknown>);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    // The owner sees `error` as a toast: name the password rule rather than "Invalid data".
    const error = flat.fieldErrors.newPassword ? WEAK_TEMP_PASSWORD : "Invalid data";
    return NextResponse.json({ error, details: flat }, { status: 400 });
  }

  const { newPassword, updatedAt: clientUpdatedAt, ...rest } = parsed.data;
  const data: Record<string, unknown> = { ...rest };
  if (newPassword) {
    data.passwordHash = await bcrypt.hash(newPassword, 12);
    // Only the owner reaches this route, and never for their own row (the
    // write excludes role "owner"), so a password set here is always one the
    // owner chose for someone else: temporary until the staff member picks
    // their own at next sign-in. A password the staff member sets themselves
    // (/api/auth/set-password) clears the flag and never sets it.
    data.mustChangePassword = true;
    // ...and expires 72 h from now (lib/temp-password.ts; auth.ts refuses it after).
    data.tempPasswordExpiresAt = tempPasswordExpiresAt();
  }
  // Bump sessionVersion when role, email OR password changes. Lane 1 iter-1
  // S-30 [High] fix: previously the bump only fired on role/email changes —
  // a forced password reset left existing JWTs valid until expiry, which
  // defeats the point of the reset on suspected compromise. Mirrors
  // app/api/admin/customers/[id]/force-password-reset/route.ts:71.
  // A role or email change bumps it too, but only when the value really
  // changes — decided inside the transaction against the current row (the edit
  // form sends the role on every save; a name-only save signs nobody out).
  if (newPassword) {
    data.sessionVersion = { increment: 1 };
  }

  // Optimistic concurrency precondition (US-508): refuse the write if the
  // row's updatedAt has moved since the client last loaded it.
  const concurrencyGuard = clientUpdatedAt ? { updatedAt: new Date(clientUpdatedAt) } : {};
  const tenantId: string = session.user.tenantId;

  try {
    const result = await withTenantContext(tenantId, async (tx) => {
      // The target: a non-owner row in THIS club. Anything else (an owner, the
      // caller's own row, another club's id, a missing id) is a 404 before any
      // other check runs, so nothing about it is revealed or written.
      const before = await tx.user.findFirst({
        where: { id, tenantId, role: { not: "owner" } },
        select: { name: true, email: true, role: true },
      });
      if (!before) return { kind: "not-found" as const };

      const write: Record<string, unknown> = { ...data };
      if (typeof rest.role === "string" && rest.role !== before.role) write.sessionVersion = { increment: 1 };
      const newEmail = typeof rest.email === "string" && rest.email !== before.email ? rest.email : null;
      if (typeof rest.email === "string" && newEmail === null) delete write.email; // same address: not a change
      if (newEmail !== null) {
        // Free across staff AND members of this club (lib/login-email.ts).
        if (await loginEmailTaken(tx, { tenantId, userId: id, email: newEmail })) return { kind: "collision" as const };
        write.loginEmailProvisionalSince = new Date();
        write.sessionVersion = { increment: 1 };
      }

      const r = await tx.user.updateMany({
        where: { id, tenantId, role: { not: "owner" }, ...concurrencyGuard },
        data: write,
      });
      if (r.count === 0) {
        const existing = await tx.user.findFirst({
          where: { id, tenantId, role: { not: "owner" } },
          select: { updatedAt: true },
        });
        return { kind: "not-written" as const, existing };
      }
      // Only after the row is written: a refused write retires nothing.
      const retired = newEmail !== null
        ? await retireEmailBoundTokens(tx, { tenantId, emails: [before.email, newEmail] })
        : null;
      const fresh = await tx.user.findFirst({ where: { id, tenantId }, select: { id: true, name: true, email: true, role: true } });
      // In the same transaction (review of lane S, S-1; the 5 Oct Q9 rule): if
      // the audit row cannot be written, the credential change rolls back too.
      const editable = (r: { name: string; role: string } | null) => (r ? { name: r.name, role: r.role } : null);
      await logAudit({
        tx,
        tenantId,
        userId: session.user.id,
        action: "staff.update",
        entityType: "User",
        entityId: id,
        // Password changes are never in the diff (not an editable value); the
        // field list still says one was sent. Login addresses appear only as
        // digests, so an email change carries no before/after to undo.
        metadata: {
          ...updateMetadata(Object.keys(parsed.data), editable(before), editable(fresh), ["name", "role"]),
          ...(newEmail !== null
            ? {
                oldEmailSha256: emailDigest(before.email),
                newEmailSha256: emailDigest(newEmail),
                provisional: true,
                retired,
              }
            : {}),
        },
        req,
      });
      return { kind: "ok" as const, fresh };
    });
    if (result.kind === "collision") {
      return NextResponse.json({ error: EMAIL_UNAVAILABLE }, { status: 409 });
    }
    if (result.kind === "not-found" || (result.kind === "not-written" && !result.existing)) {
      return NextResponse.json({ error: "Not found or cannot edit owner" }, { status: 404 });
    }
    if (result.kind === "not-written") {
      if (clientUpdatedAt && result.existing) {
        return NextResponse.json(
          { error: "This staff member was updated by someone else. Reload and try again.", currentUpdatedAt: result.existing.updatedAt.toISOString() },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: "Not found or cannot edit owner" }, { status: 404 });
    }
    const user = result.fresh;
    return NextResponse.json(user);
  } catch (err) {
    // A concurrent write took the address between the check and the update.
    if ((err as { code?: string })?.code === "P2002") {
      return NextResponse.json({ error: EMAIL_UNAVAILABLE }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to update staff" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: Params) {
  // Lane 1 iter-1 S-03 fix: CSRF guard.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  const support = refuseSupportSession(session); if (support) return support; // read-only support session (lib/support-session.ts)
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isOwner = session.user.role === "owner";
  if (!isOwner) return NextResponse.json({ error: "Only owners can remove staff" }, { status: 403 });

  const { id } = await params;

  // Cannot delete yourself
  if (id === session.user.id) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  }

  try {
    const deleted = await withTenantContext(session.user.tenantId, async (tx) => {
      const row = await tx.user.findFirst({ where: { id, tenantId: session.user.tenantId, role: { not: "owner" } }, select: { email: true } });
      const out = await tx.user.deleteMany({
        where: { id, tenantId: session.user.tenantId, role: { not: "owner" } },
      });
      return { count: out.count, email: row?.email ?? null };
    });
    if (deleted.count === 0) return NextResponse.json({ error: "Not found or cannot delete owner" }, { status: 404 });
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "staff.delete",
      entityType: "User",
      entityId: id,
      // The address this delete releases (keyed digest; the attendance import refuses a released address — SF-54).
      metadata: deleted.email ? { releasedEmailSha256: emailDigest(deleted.email) } : {},
      req,
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to remove staff member" }, { status: 500 });
  }
}
