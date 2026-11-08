/**
 * GET  /api/mats          — the club's mats in order, and how the timetable is split (any staff)
 * POST /api/mats {name}   — add a mat (owner + manager)
 *
 * A mat is one of the club's training areas. Names are unique per club
 * whatever their capitals and spacing; a club can have up to twelve. Every
 * mats write takes the club's mats lock first (lib/mats.ts), so the cap and
 * the next position cannot be raced.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiStaff, requireApiOwnerOrManager } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { refuseSupportSessionUnlessEdit } from "@/lib/support-session";
import { logAudit } from "@/lib/audit-log";
import { MAT_LIMIT, MAT_NAME_MAX, cleanMatName, lockClubMats, matNameKey } from "@/lib/mats";
import { listMats, readLayout } from "@/lib/mats-store";

export const runtime = "nodejs";

const createSchema = z.object({ name: z.string().max(200) }).strict();

export async function GET() {
  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;
  const body = await withTenantContext(tenantId, async (tx) => {
    const mats = await listMats(tx, tenantId);
    // Classes on each mat that are on the timetable or paused: what "Remove mat" tells the owner it will leave without a mat.
    const counts = await tx.class.groupBy({
      by: ["matId"],
      where: { tenantId, matId: { not: null }, deletedAt: null, sourceImportJobId: null },
      _count: { _all: true },
    });
    const countOf = new Map(counts.map((c) => [c.matId, c._count._all]));
    return {
      mats: mats.map((m) => ({ id: m.id, name: m.name, classCount: countOf.get(m.id) ?? 0 })),
      layout: await readLayout(tx, tenantId),
    };
  });
  return NextResponse.json(body, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const support = refuseSupportSessionUnlessEdit(gate.session); if (support) return support; // view refused; an EDIT session may set up mats and the split (SUPPORT_EDIT_MUTATION_ALLOWLIST)
  const { tenantId, userId } = gate;

  let body: unknown = null;
  try { body = await req.json(); } catch {}
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Give the mat a name." }, { status: 400 });
  const name = cleanMatName(parsed.data.name);
  // Blank by its key: a name of nothing but invisible characters is no name (lib/mats.ts matNameKey).
  if (!matNameKey(name)) return NextResponse.json({ error: "Give the mat a name." }, { status: 400 });
  if (name.length > MAT_NAME_MAX) return NextResponse.json({ error: `A mat name can be up to ${MAT_NAME_MAX} characters.` }, { status: 400 });
  const nameKey = matNameKey(name);

  try {
    const result = await withTenantContext(tenantId, async (tx) => {
      await lockClubMats(tx, tenantId);
      const mats = await listMats(tx, tenantId);
      const clash = mats.find((m) => m.nameKey === nameKey);
      if (clash) return { ok: false as const, status: 409, error: `You already have a mat called ${clash.name}.` };
      if (mats.length >= MAT_LIMIT) return { ok: false as const, status: 409, error: `You can have up to ${MAT_LIMIT} mats.` };
      const sortOrder = mats.reduce((max, m) => Math.max(max, m.sortOrder), -1) + 1;
      const row = await tx.mat.create({ data: { tenantId, name, nameKey, sortOrder }, select: { id: true, name: true } });
      await logAudit({ tenantId, userId, action: "mat.create", entityType: "Mat", entityId: row.id, metadata: { name: row.name }, req, tx });
      return { ok: true as const, row };
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ id: result.row.id, name: result.row.name, classCount: 0 }, { status: 201 });
  } catch (e) {
    // The unique index on (club, name key) is the backstop behind the lock.
    if ((e as { code?: string })?.code === "P2002") return NextResponse.json({ error: `You already have a mat called ${name}.` }, { status: 409 });
    throw e;
  }
}
