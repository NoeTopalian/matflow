import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";
import { apiError } from "@/lib/api-error";

const INITIATIVE_TYPES = ["marketing", "new_class", "price_change", "holiday", "coach_hired", "other"] as const;

/**
 * A date string `new Date()` can actually parse.
 *
 * `z.string().min(1)` let "not-a-date" through to `new Date(...)`, which yields
 * an Invalid Date; Prisma then threw and the bare catch answered 500. A body
 * the caller got wrong is a 400, and the 500 that is left is reserved for
 * faults an owner should report.
 */
const dateString = () =>
  z
    .string()
    .min(1)
    .max(64)
    .refine((v) => Number.isFinite(Date.parse(v)), { message: "Must be a date" });

const createSchema = z
  .object({
    type: z.enum(INITIATIVE_TYPES),
    startDate: dateString(),
    endDate: dateString().optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  })
  .refine((v) => !v.endDate || Date.parse(v.endDate) >= Date.parse(v.startDate), {
    message: "The end date cannot be before the start date",
    path: ["endDate"],
  });

export async function GET() {
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;

  try {
    const rows = await withTenantContext(tenantId, (tx) =>
      tx.initiative.findMany({
        where: { tenantId },
        include: { attachments: true },
        orderBy: { startDate: "desc" },
        take: 100,
      }),
    );
    return NextResponse.json(rows);
  } catch (e) {
    // Never `200 []` — see app/api/staff/route.ts. "No initiatives recorded"
    // is also the outage state, and an owner acting on it re-enters work they
    // have already logged.
    return apiError("Failed to load initiatives", 500, e, "[api/initiatives GET]");
  }
}

export async function POST(req: Request) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { session, tenantId, userId } = gate;

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  const { type, startDate, endDate, notes } = parsed.data;

  try {
    const created = await withTenantContext(tenantId, (tx) =>
      tx.initiative.create({
        data: {
          tenantId,
          type,
          startDate: new Date(startDate),
          endDate: endDate ? new Date(endDate) : null,
          notes: notes ?? null,
          createdById: userId,
        },
        include: { attachments: true },
      }),
    );
    await logAudit({
      tenantId,
      userId: session.user.id,
      action: "initiative.create",
      entityType: "Initiative",
      entityId: created.id,
      metadata: { type, startDate },
      req,
    });
    return NextResponse.json(created, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to create initiative" }, { status: 500 });
  }
}
