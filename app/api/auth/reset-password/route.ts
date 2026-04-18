import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";

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

  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) return NextResponse.json({ error: "Gym not found." }, { status: 404 });

  // Find valid, unused, non-expired token
  const resetToken = await prisma.passwordResetToken.findFirst({
    where: {
      token,
      email: email.toLowerCase().trim(),
      tenantId: tenant.id,
      used: false,
      expiresAt: { gt: new Date() },
    },
  });

  if (!resetToken) {
    return NextResponse.json(
      { error: "Code is invalid or has expired (codes are valid for 2 minutes). Please request a new one." },
      { status: 400 }
    );
  }

  const user = await prisma.user.findFirst({
    where: { email: email.toLowerCase().trim(), tenantId: tenant.id },
  });
  if (!user) return NextResponse.json({ error: "User not found." }, { status: 404 });

  // Check password history — cannot reuse last 8 passwords
  const history = await prisma.passwordHistory.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });

  for (const entry of history) {
    const isReused = await bcrypt.compare(password, entry.passwordHash);
    if (isReused) {
      return NextResponse.json(
        { error: `You cannot reuse any of your last ${HISTORY_LIMIT} passwords.` },
        { status: 400 }
      );
    }
  }

  const newHash = await bcrypt.hash(password, 12);

  await prisma.$transaction([
    // Update user password
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } }),
    // Mark token used
    prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { used: true } }),
    // Store current password in history before overwriting
    prisma.passwordHistory.create({ data: { userId: user.id, passwordHash: user.passwordHash } }),
  ]);

  // Prune history beyond limit
  const allHistory = await prisma.passwordHistory.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });
  if (allHistory.length > HISTORY_LIMIT) {
    const toDelete = allHistory.slice(HISTORY_LIMIT).map((h) => h.id);
    await prisma.passwordHistory.deleteMany({ where: { id: { in: toDelete } } });
  }

  return NextResponse.json({ ok: true });
}
