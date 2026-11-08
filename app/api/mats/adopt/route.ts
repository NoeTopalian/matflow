/**
 * POST /api/mats/adopt {keys} — make mats from places typed on classes (owner + manager)
 *
 * For each place: find or create the mat of that name, then put on it every
 * class that types that place and is on no mat (lib/mats-store.ts adoptPlaces).
 * The server works out the matching classes itself; it never takes a list of
 * classes from the caller. Safe to repeat: an adopt that changes nothing
 * writes nothing and records nothing.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { refuseSupportSessionUnlessEdit } from "@/lib/support-session";
import { logAudit } from "@/lib/audit-log";
import { lockClubMats } from "@/lib/mats";
import { adoptPlaces, readLayout } from "@/lib/mats-store";

export const runtime = "nodejs";

const adoptSchema = z.object({ keys: z.array(z.string().min(1).max(200)).min(1).max(50) }).strict();

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const support = refuseSupportSessionUnlessEdit(gate.session); if (support) return support; // view refused; an EDIT session may set up mats and the split (SUPPORT_EDIT_MUTATION_ALLOWLIST)
  const { tenantId, userId } = gate;

  let body: unknown = null;
  try { body = await req.json(); } catch {}
  const parsed = adoptSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });

  try {
    const out = await withTenantContext(tenantId, async (tx) => {
      await lockClubMats(tx, tenantId);
      const before = await readLayout(tx, tenantId);
      const result = await adoptPlaces(tx, tenantId, parsed.data.keys);
      const changed = result.mats.some((m) => m.created || m.classIds.length > 0);
      if (changed) {
        await logAudit({
          tenantId, userId, action: "mat.adopt", entityType: "Tenant", entityId: tenantId,
          metadata: { mats: result.mats.map((m) => ({ id: m.id, name: m.name, created: m.created, classIds: m.classIds })) }, req, tx,
        });
      }
      return { result, before, after: await readLayout(tx, tenantId) };
    });
    return NextResponse.json({
      mats: out.result.mats.map((m) => ({ id: m.id, name: m.name, created: m.created, classCount: m.classIds.length })),
      matsAdded: out.result.mats.filter((m) => m.created).length,
      classesAttached: out.result.mats.reduce((n, m) => n + m.classIds.length, 0),
      skipped: out.result.skipped,
      layout: out.after,
      layoutChanged: out.before.effective !== out.after.effective,
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") return NextResponse.json({ error: "Couldn't add the mats. Try again." }, { status: 409 });
    throw e;
  }
}
