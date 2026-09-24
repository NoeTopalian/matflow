/**
 * GET  /api/locations         — every location of the caller's club (any staff)
 * POST /api/locations {name, address?} — add one (owner + manager)
 *
 * ADR-001 D2: a location is a venue inside a club, never a data boundary.
 * A class with no location belongs to all of them; a club with one venue
 * never needs this page. Names are unique per club; the first location a
 * club ever has is its default and cannot be deleted (see [id]).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiStaff, requireApiOwnerOrManager } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";

export const runtime = "nodejs";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  address: z.string().trim().max(200).optional().nullable(),
});

// Not exported: a route module may only export handlers and config.
const LOCATION_SELECT = { id: true, name: true, address: true, isDefault: true, createdAt: true } as const;

export async function GET() {
  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const rows = await withTenantContext(gate.tenantId, (tx) =>
    tx.location.findMany({ where: { tenantId: gate.tenantId }, select: LOCATION_SELECT, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
  );
  return NextResponse.json({ locations: rows });
}

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  let body: unknown = null;
  try { body = await req.json(); } catch {}
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "A location needs a name of up to 80 characters" }, { status: 400 });

  const result = await withTenantContext(tenantId, async (tx) => {
    const clash = await tx.location.findFirst({ where: { tenantId, name: parsed.data.name }, select: { id: true } });
    if (clash) return { ok: false as const, status: 409, error: "A location with that name already exists" };
    const count = await tx.location.count({ where: { tenantId } });
    const row = await tx.location.create({
      data: { tenantId, name: parsed.data.name, address: parsed.data.address ?? null, isDefault: count === 0 },
      select: LOCATION_SELECT,
    });
    return { ok: true as const, row };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  await logAudit({ tenantId, userId, action: "location.create", entityType: "Location", entityId: result.row.id, metadata: { name: result.row.name, isDefault: result.row.isDefault }, req });
  return NextResponse.json(result.row, { status: 201 });
}
