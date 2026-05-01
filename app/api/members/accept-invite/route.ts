import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

/**
 * POST /api/members/accept-invite — public (token-gated).
 *
 * Consumes a MagicLinkToken (purpose='first_time_signup'), sets the member's
 * password hash, and marks the token used. The member can then sign in with
 * their email + new password via the normal credentials flow.
 *
 * Returns the tenantSlug so the client knows which login screen to send the
 * member to next.
 */
const schema = z.object({
  token: z.string().min(20).max(100),
  password: z
    .string()
    .min(10, "At least 10 characters")
    .max(128)
    .regex(/[A-Z]/, "Must include an uppercase letter")
    .regex(/[a-z]/, "Must include a lowercase letter")
    .regex(/[0-9]/, "Must include a number"),
});

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export async function POST(req: Request) {
  // Rate-limit by IP — token brute-force shouldn't be cheap.
  const ip = getClientIp(req);
  const rl = await checkRateLimit(`accept-invite:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const tokenRow = await prisma.magicLinkToken.findUnique({
    where: { token: parsed.data.token },
  });
  if (!tokenRow || tokenRow.purpose !== "first_time_signup") {
    return NextResponse.json({ error: "Invalid invite link" }, { status: 404 });
  }
  if (tokenRow.used) {
    return NextResponse.json({ error: "This invite has already been used. Please sign in." }, { status: 410 });
  }
  if (tokenRow.expiresAt < new Date()) {
    return NextResponse.json({ error: "This invite has expired. Ask your gym for a new one." }, { status: 410 });
  }

  const member = await prisma.member.findUnique({
    where: { tenantId_email: { tenantId: tokenRow.tenantId, email: tokenRow.email } },
    select: { id: true, tenant: { select: { slug: true } } },
  });
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  try {
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    await prisma.$transaction([
      prisma.member.update({
        where: { id: member.id },
        data: { passwordHash, sessionVersion: { increment: 1 } },
      }),
      prisma.magicLinkToken.update({
        where: { id: tokenRow.id },
        data: { used: true, usedAt: new Date(), ipAddress: ip === "unknown" ? null : ip },
      }),
    ]);

    return NextResponse.json({
      ok: true,
      tenantSlug: member.tenant.slug,
      email: tokenRow.email,
    });
  } catch (e) {
    return apiError("Failed to set password", 500, e, "[accept-invite.POST]");
  }
}
