import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { apiError } from "@/lib/api-error";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { hashToken } from "@/lib/token-hash";

/**
 * POST /api/members/accept-invite — public (token-gated).
 *
 * Consumes a MagicLinkToken (purpose='first_time_signup'), sets the member's
 * password hash, and marks the token used. Returns `{ ok, tenantSlug, email }`
 * so the calling page (app/login/accept-invite/page.tsx) can call signIn()
 * with the new credentials and route the member straight to /member/home —
 * no second log-in step.
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
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * The age at which a member may hold their own password-bearing account.
 *
 * Same threshold the rest of the product already uses to split `kids` from
 * `junior` (see the accountType derivation below, and the same boundary in
 * app/api/member/children/route.ts). Named rather than inlined so the two
 * sites cannot drift apart silently.
 */
const MINIMUM_SELF_SIGNUP_AGE = 13;

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

  // Kids are passwordless by design, and this was the one door that did not
  // honour it. The age has to be settled HERE — before the token is looked up,
  // before bcrypt runs, before anything is written — for two reasons:
  //
  //   1. Nothing may be written for a child. The old order hashed the password
  //      and updated the member first (`memberUpdate` below), and only then
  //      derived `accountType = "kids"` from the same date of birth, so a
  //      nine-year-old ended up with a working login and no parent attached.
  //      Every sibling path states the invariant explicitly: members/route.ts
  //      ("Kids: passwordless invariant"), member/children/route.ts, and
  //      bulk-invite, which excludes `accountType: "kids"` from its candidates.
  //
  //   2. The token must SURVIVE the refusal. A family typically opens the club
  //      invite on one device; if a child's attempt burned the link, the parent
  //      would be locked out of an invite the club believes it sent and there
  //      is no self-serve way to mint another. So this returns before the
  //      lookup, and the same link still works for whoever holds the account.
  if (parsed.data.dateOfBirth) {
    const dob = new Date(parsed.data.dateOfBirth);
    if (isNaN(dob.getTime())) {
      return NextResponse.json({ error: "That date of birth is not a real date." }, { status: 400 });
    }
    // Whole years, from local components, so the thirteenth birthday counts
    // from the day it falls rather than from a UTC instant that is a day out
    // for half the world.
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
    if (age < MINIMUM_SELF_SIGNUP_AGE) {
      return NextResponse.json(
        {
          error:
            "Members under 13 cannot hold their own account. Ask a parent or guardian to set one up " +
            "and add you to it — this invite link will still work for them.",
        },
        { status: 422 },
      );
    }
  }

  // Token lookup is by hash — pre-session bypass since we don't yet know the tenant.
  const tokenRow = await withRlsBypass((tx) =>
    tx.magicLinkToken.findUnique({
      where: { tokenHash: hashToken(parsed.data.token) },
    }),
  );
  if (!tokenRow || tokenRow.purpose !== "first_time_signup") {
    return NextResponse.json({ error: "Invalid invite link" }, { status: 404 });
  }
  if (tokenRow.used) {
    return NextResponse.json({ error: "This invite has already been used. Please sign in." }, { status: 410 });
  }
  if (tokenRow.expiresAt < new Date()) {
    return NextResponse.json({ error: "This invite has expired. Ask your gym for a new one." }, { status: 410 });
  }

  // From here we have tokenRow.tenantId — switch to tenant-scoped context.
  const member = await withTenantContext(tokenRow.tenantId, (tx) =>
    tx.member.findUnique({
      where: { tenantId_email: { tenantId: tokenRow.tenantId, email: tokenRow.email } },
      select: { id: true, tenant: { select: { slug: true } } },
    }),
  );
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  try {
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    await withTenantContext(tokenRow.tenantId, async (tx) => {
      await tx.member.update({
        where: { id: member.id },
        data: { passwordHash, sessionVersion: { increment: 1 } },
      });
      await tx.magicLinkToken.update({
        where: { id: tokenRow.id },
        data: { used: true, usedAt: new Date(), ipAddress: ip === "unknown" ? null : ip },
      });

      if (parsed.data.dateOfBirth) {
        const dob = new Date(parsed.data.dateOfBirth);
        const today = new Date();
        let age = today.getFullYear() - dob.getFullYear();
        const m = today.getMonth() - dob.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;

        const accountType = age < 13 ? "kids" : age < 18 ? "junior" : undefined;

        await tx.member.update({
          where: { id: member.id },
          data: {
            dateOfBirth: dob,
            ...(accountType ? { accountType } : {}),
          },
        });
      }
    });

    return NextResponse.json({
      ok: true,
      tenantSlug: member.tenant.slug,
      email: tokenRow.email,
    });
  } catch (e) {
    return apiError("Failed to set password", 500, e, "[accept-invite.POST]");
  }
}
