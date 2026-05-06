import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { hashToken } from "@/lib/token-hash";

// UK NCSC / OWASP compliant password policy
const HISTORY_LIMIT = 8; // cannot reuse last 8 passwords

function validatePassword(password: string): string | null {
  if (password.length < 10) return "Password must be at least 10 characters.";
  if (password.length > 128) return "Password must be 128 characters or fewer.";
  if (!/[A-Z]/.test(password)) return "Password must contain at least one uppercase letter.";
  if (!/[a-z]/.test(password)) return "Password must contain at least one lowercase letter.";
  if (!/[0-9]/.test(password)) return "Password must contain at least one number.";
  return null;
}

export async function POST(req: Request) {
  const { token, email, tenantSlug, password } = await req.json();

  if (!token || !email || !tenantSlug || !password) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  const policyError = validatePassword(password);
  if (policyError) return NextResponse.json({ error: policyError }, { status: 400 });

  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { slug: tenantSlug } }),
  );
  if (!tenant) return NextResponse.json({ error: "Gym not found." }, { status: 404 });

  const normEmail = email.toLowerCase().trim();

  // From here we have a tenant — switch to tenant-scoped context.
  const lookups = await withTenantContext(tenant.id, async (tx) => {
    const resetToken = await tx.passwordResetToken.findFirst({
      where: {
        tokenHash: hashToken(token),
        email: normEmail,
        tenantId: tenant.id,
        used: false,
        expiresAt: { gt: new Date() },
      },
    });
    if (!resetToken) return { resetToken: null, user: null, history: [] };
    const user = await tx.user.findFirst({
      where: { email: normEmail, tenantId: tenant.id },
    });
    if (!user) return { resetToken, user: null, history: [] };
    const history = await tx.passwordHistory.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
    });
    return { resetToken, user, history };
  });

  if (!lookups.resetToken) {
    return NextResponse.json(
      { error: "Code is invalid or has expired (codes are valid for 2 minutes). Please request a new one." },
      { status: 400 }
    );
  }
  // If a token is valid but the user no longer exists (e.g. soft-deleted),
  // collapse to the same 400/message as an invalid token so an attacker who
  // somehow guesses a valid token can't learn that the user was deleted.
  if (!lookups.user) {
    return NextResponse.json(
      { error: "Code is invalid or has expired (codes are valid for 2 minutes). Please request a new one." },
      { status: 400 },
    );
  }
  const { resetToken, user, history } = lookups;

  // Check password history — cannot reuse last 8 passwords
  for (const entry of history) {
    const isReused = await bcrypt.compare(password, entry.passwordHash);
    if (isReused) {
      return NextResponse.json(
        { error: `You cannot reuse any of your last ${HISTORY_LIMIT} passwords.` },
        { status: 400 }
      );
    }
  }

  // Atomically consume the token — prevents two concurrent requests both succeeding.
  const consumed = await withTenantContext(tenant.id, (tx) =>
    tx.passwordResetToken.updateMany({
      where: { id: resetToken.id, used: false, expiresAt: { gt: new Date() } },
      data: { used: true },
    }),
  );
  if (consumed.count !== 1) {
    return NextResponse.json(
      { error: "Code is invalid or has already been used. Please request a new one." },
      { status: 400 },
    );
  }

  const newHash = await bcrypt.hash(password, 12);

  await withTenantContext(tenant.id, async (tx) => {
    // Update password AND bump sessionVersion so any pre-existing JWTs become
    // invalid on the next Node-runtime auth() check. Without this, an attacker
    // who stole credentials retains a valid session for ~30 days after the
    // legitimate user resets their password.
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash: newHash,
        sessionVersion: { increment: 1 },
      },
    });
    // Store current password in history before overwriting
    await tx.passwordHistory.create({ data: { userId: user.id, passwordHash: user.passwordHash } });

    // Prune history beyond limit
    const allHistory = await tx.passwordHistory.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    if (allHistory.length > HISTORY_LIMIT) {
      const toDelete = allHistory.slice(HISTORY_LIMIT).map((h: { id: string }) => h.id);
      await tx.passwordHistory.deleteMany({ where: { id: { in: toDelete } } });
    }
  });

  return NextResponse.json({ ok: true });
}
