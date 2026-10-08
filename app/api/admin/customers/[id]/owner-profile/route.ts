// POST /api/admin/customers/[id]/owner-profile
//
// Operator correction of the club OWNER's display name (8 Oct 2026,
// account-editing lane R, story C4) — e.g. a club created with a placeholder
// or misspelt owner name. Body (strict): { name, reason }.
//
// What the operator can NOT do here, or anywhere: choose the owner's password
// (only "Reset password" to a temporary one), enrol or read their
// authenticator (only "Reset 2FA"), change their role or move them to another
// club. Login email has its own card and route (login-email: mark / confirm /
// change). Any key other than name and reason is a 400 with nothing written.
//
// Gate: named MFA operator (isAdminAuthed + getOperatorContext), same-origin,
// rate limit, a step-up grant bound to "owner.profile" on THIS club's THIS
// owner for the "name" sub-action (stepUpTarget(tenant, owner, "name")), a
// reason of at least 10 characters. The shared-secret sentinel is refused by
// requireStepUp. Checks that need no secret run before the grant is spent.
//
// One transaction: the name, conditional on the name the route read (409 if
// it moved in between), and the audit row `admin.owner.profile.updated` with
// before/after, the reason and the operator as actor (actAsUserId), distinct
// from the owner whose row it is. The owner's sessions are NOT signed out —
// a display name is not a credential; their top bar shows it after their next
// sign-in.

import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed } from "@/lib/admin-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { getOperatorContext } from "@/lib/operator-context";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { requireStepUp, stepUpTarget } from "@/lib/operator-step-up";
import { displayNameSchema } from "@/lib/account-profile";

export const runtime = "nodejs";

const REASON_MIN = 10;
const bodySchema = z
  .object({
    name: displayNameSchema,
    reason: z.string().trim().min(REASON_MIN).max(500),
  })
  .strict();

// Same budget as the other Danger Zone actions (A6I1-S-5).
const RL_MAX = 20;
const RL_WINDOW_MS = 60 * 60 * 1000;

class StaleOwnerName extends Error {}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  if (!(await isAdminAuthed(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const ctx = await getOperatorContext(req);
  const rl = await checkRateLimit(`admin:tenant-action:${ctx.operatorId}:${getClientIp(req)}`, RL_MAX, RL_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many admin actions. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const { id: tenantId } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const unknownKeys = parsed.error.issues.some((i) => i.code === "unrecognized_keys");
    return NextResponse.json(
      {
        error: unknownKeys
          ? "Only the owner's name can be corrected here."
          : `Enter a name (1 to 100 characters) and a reason of at least ${REASON_MIN} characters.`,
      },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // Same owner resolution as the login-email route: the club's first owner.
  const owner = await withRlsBypass((tx) =>
    tx.user.findFirst({
      where: { tenantId, role: "owner" },
      select: { id: true, name: true },
      orderBy: { createdAt: "asc" },
    }),
  );
  if (!owner) return NextResponse.json({ error: "No owner on this tenant" }, { status: 404 });
  if (body.name === owner.name) {
    return NextResponse.json({ error: "That is already the owner's name." }, { status: 400 });
  }

  const stepUp = await requireStepUp(req, ctx, "owner.profile", stepUpTarget(tenantId, owner.id, "name"));
  if (stepUp) return stepUp;

  try {
    await withRlsBypass(async (tx) => {
      const changed = await tx.user.updateMany({
        where: { id: owner.id, tenantId, role: "owner", name: owner.name },
        data: { name: body.name },
      });
      if (changed.count !== 1) throw new StaleOwnerName();
      await logAudit({
        tx,
        tenantId,
        userId: owner.id,
        action: "admin.owner.profile.updated",
        entityType: "User",
        entityId: owner.id,
        metadata: {
          reason: body.reason,
          changed: ["name"],
          before: { name: owner.name },
          after: { name: body.name },
        },
        actAsUserId: ctx.operatorId,
        req,
      });
    });
    return NextResponse.json({ ok: true, name: body.name });
  } catch (err) {
    if (err instanceof StaleOwnerName) {
      return NextResponse.json(
        { error: "The owner's name changed while you were working, so nothing was changed. Reload the page and check it." },
        { status: 409 },
      );
    }
    console.error("[owner-profile] change or audit write failed; nothing changed", err);
    return NextResponse.json(
      { error: "The change could not be recorded, so nothing was changed. Try again with a new authenticator code." },
      { status: 500 },
    );
  }
}
