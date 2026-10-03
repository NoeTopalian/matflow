/**
 * POST /api/member/children
 *
 * A logged-in member (the "parent") creates a kid Member tied to themselves.
 * Kids are passwordless (passwordHash = null) and inherit tenant from the
 * parent. Email is a synthetic kid-{cuid}@kids.local placeholder — the unique
 * (tenantId, email) constraint requires *something*, but kids never log in.
 *
 * Hard guards:
 *  - Parent must not itself be a kid (no nested sub-accounts)
 *  - Max 10 kids per parent (sanity cap, ratchets if a real gym needs more)
 *  - tenantId always derived from session — never trusted from body
 *  - waiverAccepted stays false; staff or parent re-signs in person at the gym
 *    (we never propagate the parent's waiver to a kid since kid-specific risks
 *    differ and the gym needs an explicit signature on the kid record)
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";
import { z } from "zod";
import { synthesiseKidEmail } from "@/lib/synthesise-kid-email";
import { MAX_KIDS_PER_PARENT } from "@/lib/kids-policy";
import { CONFIRMED_BY } from "@/lib/guardianship";

const bodySchema = z.object({
  name: z.string().min(1).max(120).trim(),
  dateOfBirth: z.string().optional().nullable(),
  accountType: z.enum(["kids", "junior"]).default("kids"),
  // Held by the welcome flow across retries (verifier lane 2, 30 Sep 2026).
  requestId: z.string().min(8).max(100).optional(),
});

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const parentMemberId = session.user.memberId as string | undefined;
  if (!parentMemberId) return apiError("Not a member account", 403);
  const tenantId: string = session.user.tenantId;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON", 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid data", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { name, dateOfBirth, accountType } = parsed.data;
  const requestId = parsed.data.requestId ?? null;
  let dob: Date | null = null;
  if (dateOfBirth) {
    const d = new Date(dateOfBirth);
    if (isNaN(d.getTime())) return apiError("Invalid date of birth", 400);
    if (d > new Date()) return apiError("Date of birth cannot be in the future", 400);
    dob = d;
  }

  try {
    const outcome = await withTenantContext(tenantId, async (tx) => {
      const parent = await tx.member.findFirst({
        where: { id: parentMemberId, tenantId },
        select: { id: true, parentMemberId: true },
      });
      if (!parent) return { kind: "no-parent" } as const;
      // No nested sub-accounts: a member who is already someone's kid cannot
      // adopt their own kids. Keeps the parent→kids relation a single hop.
      if (parent.parentMemberId !== null) return { kind: "nested" } as const;

      // A retry of the same child after a lost response returns the child
      // already created instead of a second one.
      if (requestId) {
        const prior = await tx.member.findFirst({
          where: { tenantId, parentMemberId, createRequestId: requestId },
          select: { id: true, name: true, dateOfBirth: true, accountType: true },
        });
        if (prior) return { kind: "replay", kid: prior } as const;
      }

      const kidCount = await tx.member.count({
        where: { parentMemberId, tenantId },
      });
      if (kidCount >= MAX_KIDS_PER_PARENT) return { kind: "limit" } as const;

      // Shared helper — same format as the staff create-member flow
      // (POST /api/members). See lib/synthesise-kid-email.ts for the rationale
      // around the `no-login.matflow.local` TLD and entropy budget.
      const syntheticEmail = synthesiseKidEmail();
      const kid = await tx.member.create({
        data: {
          tenantId,
          parentMemberId,
          // 3 Oct 2026 — administrator-controlled families, scoped.
          // A parent CREATING a brand-new child is asserting their own child,
          // not claiming an existing person: the new row has no history, no
          // money and no prior access, so confirming it grants nothing that
          // existed before. The authority risk is claiming someone who already
          // exists, which is POST /api/members/[id]/link-child (owner-only) and
          // the links an IMPORT infers from a shared email or emergency
          // contact — those stay suggested until staff confirm them.
          // Briefly made suggested on 2 Oct; that stranded every new family
          // until staff clicked (a parent could not sign their own child's
          // waiver), which lc-2 and lh-5 caught.
          ...CONFIRMED_BY("member"),
          name,
          email: syntheticEmail,
          passwordHash: null,
          accountType,
          dateOfBirth: dob,
          status: "active",
          waiverAccepted: false,
          onboardingCompleted: true,
          createRequestId: requestId,
        },
        select: {
          id: true,
          name: true,
          dateOfBirth: true,
          accountType: true,
        },
      });
      return { kind: "ok", kid } as const;
    });

    if (outcome.kind === "no-parent") return apiError("Parent record missing", 404);
    if (outcome.kind === "nested")
      return apiError("Sub-accounts cannot adopt their own kids", 400);
    if (outcome.kind === "limit")
      return apiError(`Maximum ${MAX_KIDS_PER_PARENT} kids per parent`, 409);
    if (outcome.kind === "replay") {
      return NextResponse.json(
        {
          id: outcome.kid.id,
          name: outcome.kid.name,
          dateOfBirth: outcome.kid.dateOfBirth ? outcome.kid.dateOfBirth.toISOString() : null,
          accountType: outcome.kid.accountType,
          replayed: true,
        },
        { status: 200 },
      );
    }

    await logAudit({
      tenantId,
      userId: session.user.id ?? null,
      // Synergy: matches the staff path in app/api/members/route.ts so both
      // creation flows show up under the same audit-log filter.
      action: "member.create.kid",
      entityType: "Member",
      entityId: outcome.kid.id,
      metadata: { parentMemberId, childName: outcome.kid.name },
      req,
    });

    return NextResponse.json(
      {
        id: outcome.kid.id,
        name: outcome.kid.name,
        dateOfBirth: outcome.kid.dateOfBirth ? outcome.kid.dateOfBirth.toISOString() : null,
        accountType: outcome.kid.accountType,
      },
      { status: 201 },
    );
  } catch (e) {
    return apiError("Failed to create child", 500, e, "[member/children POST]");
  }
}
