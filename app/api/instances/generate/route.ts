/**
 * POST /api/instances/generate
 * Generates ClassInstance rows for all active classes for the next N weeks.
 * Safe to call repeatedly — skips already-existing instances.
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";
import { buildInstanceRows } from "@/lib/class-instances";

const schema = z.object({ weeks: z.number().int().min(1).max(52).default(4) });

export async function POST(req: Request) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canManage = ["owner", "manager"].includes(session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const parsed = schema.safeParse(body);
  const weeks = parsed.success ? parsed.data.weeks : 4;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate = new Date(today);
  endDate.setDate(today.getDate() + weeks * 7);

  const classes = await withTenantContext(session.user.tenantId, (tx) =>
    tx.class.findMany({
      // RULES §5: a removed class must not have new instances minted for it —
      // that would resurrect it on the check-in screen even though every list
      // filters it out.
      where: { tenantId: session.user.tenantId, isActive: true, deletedAt: null },
      include: { schedules: { where: { isActive: true } } },
    }),
  );

  // Shared with the per-class button and the nightly cron: the row shape has
  // to be identical across all three or skipDuplicates stops matching.
  const toCreate = buildInstanceRows(classes, { from: today, to: endDate });

  if (toCreate.length === 0) return NextResponse.json({ created: 0 });

  try {
    // The read-then-filter that used to sit here was the ONLY dedup, and it ran
    // inside a READ COMMITTED transaction — a TOCTOU that two concurrent
    // clicks walked straight through, because skipDuplicates had no unique
    // constraint to conflict against. Migration 20260819090000 added
    // @@unique([classId, date, startTime]), so the database now does the
    // deduplication atomically and `count` is the honest number of rows
    // actually inserted rather than an optimistic pre-count (RULES §2 — the
    // toast reads "Generated N instances").
    const res = await withTenantContext(session.user.tenantId, (tx) =>
      tx.classInstance.createMany({ data: toCreate, skipDuplicates: true }),
    );
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "class.instances_generated",
      entityType: "Tenant",
      entityId: session.user.tenantId,
      metadata: {
        weeks,
        created: res.count,
      },
      req,
    });
    return NextResponse.json({ created: res.count });
  } catch {
    return NextResponse.json({ error: "Failed to generate instances" }, { status: 500 });
  }
}
