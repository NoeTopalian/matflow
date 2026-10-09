/**
 * POST /api/staff/[id]/transfer-ownership { password }
 *
 * The owner hands the club to an existing member of staff. ADR-001 D7: the
 * only way ownership moves inside the club (the operator has a separate,
 * audited route for support cases), and a club can never be left without an
 * owner: in one transaction the target becomes `owner` and the caller
 * becomes `manager`, both session versions bump so both sign in again under
 * their new roles. The caller re-enters their own password: this is the one
 * action in the club that removes the caller's own highest privilege, so a
 * stolen session alone must not be enough.
 *
 * Owner only, CSRF, rate-limited, audit `staff.ownership_transferred`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";
import { checkRateLimit } from "@/lib/rate-limit";
import { refuseSupportSession } from "@/lib/support-session";

export const runtime = "nodejs";

const bodySchema = z.object({ password: z.string().min(1).max(200) });

/** Thrown inside the transaction when the roles moved since they were read: rolls back the swap. */
class OwnershipMoved extends Error {}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  const support = refuseSupportSession(session); if (support) return support; // read-only support session (lib/support-session.ts)
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "owner") return NextResponse.json({ error: "Only the owner can transfer ownership" }, { status: 403 });
  const tenantId = session.user.tenantId;
  const { id: targetId } = await params;

  const rl = await checkRateLimit(`staff:transfer-ownership:${tenantId}:${session.user.id}`, 5, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } });
  }

  let body: unknown = null;
  try { body = await req.json(); } catch {}
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Enter your password to confirm" }, { status: 400 });

  if (targetId === session.user.id) {
    return NextResponse.json({ error: "You already own this club" }, { status: 400 });
  }

  // Security lane B (9 Oct 2026, SEC-032): the role swap is CONDITIONAL on the
  // roles read above. Two transfers at once (two devices, or this route and the
  // operator's) used to both commit — each read "I am the owner", each updated
  // by id — and the club ended with TWO owners (reproduced on the database,
  // tests/integration/sec-b-ownership-transfer-db.test.ts). Postgres re-checks
  // an UPDATE's WHERE against the committed row after waiting for the other
  // transaction's lock, so only one demotion of this owner can succeed; the
  // loser rolls back whole. The audit row is written in the same transaction,
  // so a transfer never commits without its record.
  let result;
  try {
    result = await withTenantContext(tenantId, async (tx) => {
      const me = await tx.user.findFirst({ where: { id: session.user.id, tenantId, role: "owner" }, select: { id: true, email: true, name: true, passwordHash: true } });
      if (!me) return { ok: false as const, status: 403, error: "Only the owner can transfer ownership" };
      // A password-less owner (magic link only) cannot prove it this way; the
      // operator's transfer route is the path for them.
      if (!me.passwordHash) return { ok: false as const, status: 409, error: "Your account has no password to confirm with — ask MatFlow support to transfer ownership" };
      const ok = await bcrypt.compare(parsed.data.password, me.passwordHash);
      if (!ok) return { ok: false as const, status: 403, error: "Password incorrect" };

      const target = await tx.user.findFirst({ where: { id: targetId, tenantId }, select: { id: true, email: true, name: true, role: true } });
      if (!target) return { ok: false as const, status: 404, error: "Staff member not found" };
      if (target.role === "owner") return { ok: false as const, status: 400, error: "That person is already the owner" };

      const demoted = await tx.user.updateMany({
        where: { id: me.id, tenantId, role: "owner" },
        data: { role: "manager", sessionVersion: { increment: 1 } },
      });
      if (demoted.count !== 1) throw new OwnershipMoved();
      const promoted = await tx.user.updateMany({
        where: { id: target.id, tenantId, role: target.role },
        data: { role: "owner", sessionVersion: { increment: 1 } },
      });
      if (promoted.count !== 1) throw new OwnershipMoved();
      await logAudit({
        tx,
        tenantId,
        userId: session.user.id,
        action: "staff.ownership_transferred",
        entityType: "User",
        entityId: target.id,
        metadata: {
          previousOwnerId: me.id,
          newOwnerId: target.id,
          previousTargetRole: target.role,
        },
        req,
      });
      return { ok: true as const, me, target };
    });
  } catch (err) {
    if (err instanceof OwnershipMoved) {
      return NextResponse.json(
        { error: "Ownership changed while you were confirming, so nothing was changed. Reload the page to see who owns the club." },
        { status: 409 },
      );
    }
    throw err;
  }

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({
    ok: true,
    newOwner: { id: result.target.id, name: result.target.name, email: result.target.email },
    message: `${result.target.name} now owns this club. You are a manager. Both of you must sign in again.`,
  });
}
