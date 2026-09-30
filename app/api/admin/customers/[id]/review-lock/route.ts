// POST   /api/admin/customers/[id]/review-lock  → put the club in review mode
// DELETE /api/admin/customers/[id]/review-lock  → end review mode
//
// Review mode lets a club inspect its imported data while its previous platform
// still collects the money: billing starts, membership migration, bulk
// invitations, erasure and club deletion are refused server-side
// (lib/review-lock.ts). Nothing is changed or cancelled by switching it on.

import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed } from "@/lib/admin-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { getOperatorContext } from "@/lib/operator-context";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

const bodySchema = z.object({
  // When the club's source data was exported — shown on the review banner.
  snapshotAt: z.string().datetime().optional(),
  note: z.string().trim().max(300).optional(),
});

const RL_MAX = 20;
const RL_WINDOW_MS = 60 * 60 * 1000;

async function guard(req: Request): Promise<{ ok: true; operatorId: string | null } | { ok: false; res: NextResponse }> {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return { ok: false, res: csrfViolation };
  if (!(await isAdminAuthed(req))) return { ok: false, res: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  const ctx = await getOperatorContext(req);
  const rl = await checkRateLimit(`admin:tenant-action:${ctx.operatorId}:${getClientIp(req)}`, RL_MAX, RL_WINDOW_MS);
  if (!rl.allowed) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: "Too many admin actions. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      ),
    };
  }
  return { ok: true, operatorId: ctx.operatorId };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req);
  if (!g.ok) return g.res;
  const { id: tenantId } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Snapshot date must be an ISO date-time; note up to 300 characters." }, { status: 400 });

  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, reviewLockedAt: true } }),
  );
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  const lockedAt = tenant.reviewLockedAt ?? new Date();
  const snapshotAt = parsed.data.snapshotAt ? new Date(parsed.data.snapshotAt) : null;
  await withRlsBypass((tx) =>
    tx.tenant.update({
      where: { id: tenantId },
      data: { reviewLockedAt: lockedAt, reviewSnapshotAt: snapshotAt, reviewNote: parsed.data.note || null },
    }),
  );

  await logAudit({
    tenantId,
    userId: null,
    action: "admin.tenant.review_locked",
    entityType: "Tenant",
    entityId: tenantId,
    metadata: { snapshotAt: snapshotAt?.toISOString() ?? null, note: parsed.data.note ?? null, alreadyLocked: !!tenant.reviewLockedAt },
    actAsUserId: g.operatorId,
    req,
  });
  return NextResponse.json({ ok: true, reviewLockedAt: lockedAt, reviewSnapshotAt: snapshotAt });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req);
  if (!g.ok) return g.res;
  const { id: tenantId } = await params;
  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, reviewLockedAt: true } }),
  );
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  if (!tenant.reviewLockedAt) return NextResponse.json({ error: "This club is not in review" }, { status: 409 });

  await withRlsBypass((tx) =>
    tx.tenant.update({ where: { id: tenantId }, data: { reviewLockedAt: null, reviewSnapshotAt: null, reviewNote: null } }),
  );
  await logAudit({
    tenantId,
    userId: null,
    action: "admin.tenant.review_unlocked",
    entityType: "Tenant",
    entityId: tenantId,
    metadata: { lockedSince: tenant.reviewLockedAt.toISOString() },
    actAsUserId: g.operatorId,
    req,
  });
  return NextResponse.json({ ok: true });
}
