import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/csrf";
import { buildInstanceRows } from "@/lib/class-instances";

type Params = { params: Promise<{ id: string }> };

/** POST — manually cancel or restore a specific instance */
const cancelSchema = z.object({
  isCancelled: z.boolean(),
  cancellationReason: z.string().max(300).optional(),
});

export async function GET(req: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor") ?? undefined;
  const rawTake = parseInt(searchParams.get("take") ?? "30", 10);
  const take = Math.min(isNaN(rawTake) || rawTake < 1 ? 30 : rawTake, 200);

  try {
    const instances = await withTenantContext(session.user.tenantId, (tx) =>
      tx.classInstance.findMany({
        where: { classId: id, class: { tenantId: session.user.tenantId } },
        include: { _count: { select: { attendances: true } } },
        cursor: cursor ? { id: cursor } : undefined,
        skip: cursor ? 1 : 0,
        orderBy: { date: "desc" },
        take,
      }),
    );
    const nextCursor = instances.length === take ? instances[instances.length - 1].id : null;
    return NextResponse.json({ instances, nextCursor });
  } catch {
    return NextResponse.json({ instances: [], nextCursor: null });
  }
}

export async function POST(req: Request, { params }: Params) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canManage = ["owner", "manager"].includes(session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Generate instances for next N weeks
  const genSchema = z.object({ weeks: z.number().int().min(1).max(52).default(4) });
  const parsed = genSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });

  const cls = await withTenantContext(session.user.tenantId, (tx) =>
    tx.class.findFirst({
      // RULES §5: a removed class must not have new instances minted for it.
      where: { id, tenantId: session.user.tenantId, deletedAt: null },
      include: { schedules: { where: { isActive: true } } },
    }),
  );
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Shared with the tenant-wide button and the nightly cron: the row shape has
  // to be identical across all three or skipDuplicates stops matching. `days`,
  // not an end date — "the next N weeks" is N*7 days, and passing an end date
  // is what made this emit an N+1th occurrence of today's own weekday.
  const candidates = buildInstanceRows([cls], { from: today, days: parsed.data.weeks * 7 });

  try {
    // The read-then-filter that used to sit here was the ONLY dedup and it ran
    // inside a READ COMMITTED transaction — a TOCTOU that this button firing
    // alongside "Generate 4 weeks" walked straight through, because
    // skipDuplicates had no unique constraint to conflict against. Migration
    // 20260819090000 added @@unique([classId, date, startTime]), so the
    // database deduplicates atomically and `count` is the number of rows
    // actually inserted (RULES §2 — the toast reads "Generated N instances").
    const created = await withTenantContext(session.user.tenantId, (tx) =>
      tx.classInstance.createMany({ data: candidates, skipDuplicates: true }),
    );
    return NextResponse.json({ created: created.count });
  } catch {
    return NextResponse.json({ error: "Failed to generate instances" }, { status: 500 });
  }
}
