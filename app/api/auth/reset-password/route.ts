import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { hashToken } from "@/lib/token-hash";

// UK NCSC / OWASP compliant password policy
const HISTORY_LIMIT = 8; // cannot reuse last 8 passwords

// Audit iter-1-auth-boundary AH-8: validate body shape + bounds before any work.
const bodySchema = z.object({
  token: z.string().min(1).max(20),
  email: z.string().email().max(120),
  tenantSlug: z.string().min(1).max(60),
  password: z.string().min(10).max(128),
});

function validatePassword(password: string): string | null {
  if (password.length < 10) return "Password must be at least 10 characters.";
  if (password.length > 128) return "Password must be 128 characters or fewer.";
  if (!/[A-Z]/.test(password)) return "Password must contain at least one uppercase letter.";
  if (!/[a-z]/.test(password)) return "Password must contain at least one lowercase letter.";
  if (!/[0-9]/.test(password)) return "Password must contain at least one number.";
  return null;
}

export async function POST(req: Request) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "Missing or invalid fields." }, { status: 400 });
  const { token, email, tenantSlug, password } = parsed.data;

  const policyError = validatePassword(password);
  if (policyError) return NextResponse.json({ error: policyError }, { status: 400 });

  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { slug: tenantSlug } }),
  );
  // Audit iter-1-auth-boundary AH-9: collapse tenant-not-found into the same
  // generic "code invalid or expired" error so attackers cannot enumerate
  // tenant slugs by probing reset endpoints.
  if (!tenant) {
    return NextResponse.json(
      { error: "Code is invalid or has expired (codes are valid for 2 minutes). Please request a new one." },
      { status: 400 },
    );
  }

  const normEmail = email.toLowerCase().trim();

  // From here we have a tenant — switch to tenant-scoped context.
  // Audit iter-1-auth-boundary AH-3: lookup subject as either User OR Member.
  // The token row carries only email + tenant; the subject type is
  // discovered here. User takes precedence (staff accounts) over Member
  // when both share an email — should be rare given staff and member share
  // an email tend to be edge cases (e.g. the owner has their own member row).
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
    if (!resetToken) return { resetToken: null, subject: null, history: [] as { passwordHash: string }[] };
    const user = await tx.user.findFirst({
      where: { email: normEmail, tenantId: tenant.id },
    });
    if (user) {
      const history = await tx.passwordHistory.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: HISTORY_LIMIT,
      });
      return {
        resetToken,
        subject: { kind: "user" as const, id: user.id, passwordHash: user.passwordHash },
        history,
      };
    }
    // Fall back to Member. Members with passwordHash=null cannot reset
    // (they sign in via magic link). Members do not have password history
    // tracking today; the history check is staff-only.
    const member = await tx.member.findFirst({
      where: { email: normEmail, tenantId: tenant.id, passwordHash: { not: null } },
      select: { id: true, passwordHash: true },
    });
    if (!member || !member.passwordHash) {
      return { resetToken, subject: null, history: [] as { passwordHash: string }[] };
    }
    return {
      resetToken,
      subject: { kind: "member" as const, id: member.id, passwordHash: member.passwordHash },
      history: [] as { passwordHash: string }[],
    };
  });

  if (!lookups.resetToken) {
    return NextResponse.json(
      { error: "Code is invalid or has expired (codes are valid for 2 minutes). Please request a new one." },
      { status: 400 }
    );
  }
  // If a token is valid but the subject no longer exists (e.g. soft-deleted),
  // collapse to the same 400/message as an invalid token so an attacker who
  // somehow guesses a valid token can't learn that the user was deleted.
  if (!lookups.subject) {
    return NextResponse.json(
      { error: "Code is invalid or has expired (codes are valid for 2 minutes). Please request a new one." },
      { status: 400 },
    );
  }
  const { resetToken, subject, history } = lookups;

  // Audit iter-1-auth-boundary AH-10: parallelise the 8 bcrypt.compare calls.
  // Serial worst-case = 8 × ~100ms = ~800ms CPU before the new hash, which on
  // Vercel Hobby shared vCPU is a borderline-timeout DoS surface. bcrypt is
  // async and Node's libuv thread pool handles parallel CPU work cleanly.
  const reuseFlags = await Promise.all(
    history.map((entry) => bcrypt.compare(password, entry.passwordHash)),
  );
  if (reuseFlags.some(Boolean)) {
    return NextResponse.json(
      { error: `You cannot reuse any of your last ${HISTORY_LIMIT} passwords.` },
      { status: 400 }
    );
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
    if (subject.kind === "user") {
      // Update password AND bump sessionVersion so any pre-existing JWTs become
      // invalid on the next Node-runtime auth() check. Without this, an attacker
      // who stole credentials retains a valid session for ~30 days after the
      // legitimate user resets their password.
      await tx.user.update({
        where: { id: subject.id },
        data: {
          passwordHash: newHash,
          sessionVersion: { increment: 1 },
        },
      });
      // Store current password in history before overwriting
      await tx.passwordHistory.create({
        data: { userId: subject.id, passwordHash: subject.passwordHash },
      });

      // Prune history beyond limit
      const allHistory = await tx.passwordHistory.findMany({
        where: { userId: subject.id },
        orderBy: { createdAt: "desc" },
      });
      if (allHistory.length > HISTORY_LIMIT) {
        const toDelete = allHistory.slice(HISTORY_LIMIT).map((h: { id: string }) => h.id);
        await tx.passwordHistory.deleteMany({ where: { id: { in: toDelete } } });
      }
    } else {
      // Audit iter-1-auth-boundary AH-3: member password reset. Same
      // sessionVersion bump as User to invalidate stale JWTs. No password
      // history tracking for members today — keep this PR scoped to enabling
      // the reset flow; per-member history is a separate feature.
      await tx.member.update({
        where: { id: subject.id },
        data: {
          passwordHash: newHash,
          sessionVersion: { increment: 1 },
        },
      });
    }
  });

  return NextResponse.json({ ok: true });
}
