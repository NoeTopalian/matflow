/**
 * POST /api/auth/set-password
 *
 * A signed-in staff user replaces a temporary password with one of their own.
 * The operator console's "Reset password" hands the owner a temporary
 * password and flags the account `mustChangePassword`; the dashboard layout
 * sends them here until this route clears the flag (customer simulation
 * 26 Sep 2026, F-3: the owner was never asked to choose their own password).
 *
 * Same password rules and history handling as /api/auth/reset-password. The
 * current session is kept (the reset already kicked every older session);
 * the change is audited.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";
import { STAFF_ROLES } from "@/lib/authz";

export const runtime = "nodejs";

const HISTORY_LIMIT = 5;

const bodySchema = z.object({
  // Same strength as reset-password and accept-invite (verifier lane 1, 30 Sep
  // 2026: this door alone accepted ten lower-case letters).
  password: z
    .string()
    .min(10, "Use at least 10 characters")
    .max(128)
    .regex(/[A-Z]/, "Include an upper-case letter")
    .regex(/[a-z]/, "Include a lower-case letter")
    .regex(/[0-9]/, "Include a number"),
});

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!STAFF_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }
  const { password } = parsed.data;
  const tenantId: string = session.user.tenantId;
  const userId: string = session.user.id;

  const current = await withTenantContext(tenantId, async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId, tenantId }, select: { id: true, passwordHash: true } });
    if (!user) return null;
    const history = await tx.passwordHistory.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
      select: { passwordHash: true },
    });
    return { user, history };
  });
  if (!current) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const reused = [current.user.passwordHash, ...current.history.map((h) => h.passwordHash)].some((h) => bcrypt.compareSync(password, h));
  if (reused) {
    return NextResponse.json({ error: "Choose a password you haven't used before." }, { status: 400 });
  }

  const newHash = await bcrypt.hash(password, 12);
  await withTenantContext(tenantId, async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash: newHash, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null },
    });
    await tx.passwordHistory.create({ data: { userId, passwordHash: current.user.passwordHash } });
    const all = await tx.passwordHistory.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, select: { id: true } });
    if (all.length > HISTORY_LIMIT) {
      await tx.passwordHistory.deleteMany({ where: { id: { in: all.slice(HISTORY_LIMIT).map((h) => h.id) } } });
    }
  });

  await logAudit({
    tenantId,
    userId,
    action: "user.password.set_own",
    entityType: "User",
    entityId: userId,
    req,
  });

  return NextResponse.json({ ok: true });
}
