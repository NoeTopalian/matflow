// GET /api/admin/import/[id]/conflicts — the people an import or status
// refresh did NOT write because they differ from MatFlow or could not be
// matched with certainty (owner decision, 25 Oct 2026). Owner-only like every
// import route; the job and every member are read in the caller's club only.
//
// Each conflict shows what the file said, what MatFlow held when the file was
// read, and what MatFlow holds NOW (re-read here, so a value someone has since
// changed by hand reads "matches now"). Nothing here writes: resolving is the
// member's normal edit, with its own permission check.
import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { apiError } from "@/lib/api-error";
import {
  CANDIDATE_SELECT,
  comparedFieldLabel,
  memberValues,
  stillDiffers,
  type ImportConflict,
} from "@/lib/importers/import-conflicts";

export const runtime = "nodejs";

export type ConflictMemberView = { id: string; name: string; href: string } | { id: string; name: null; href: null };

export type ConflictView =
  | {
      kind: "conflict";
      name: string;
      rows: number[];
      member: ConflictMemberView;
      fields: { field: string; label: string; upload: string | null; atImport: string | null; now: string | null; stillDiffers: boolean }[];
    }
  | { kind: "ambiguous"; name: string; rows: number[]; reason: string; members: ConflictMemberView[] };

function conflictsOf(manifest: unknown): ImportConflict[] {
  const list = manifest && typeof manifest === "object" ? (manifest as { conflicts?: unknown }).conflicts : undefined;
  return Array.isArray(list) ? (list as ImportConflict[]) : [];
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;
  const { id } = await params;

  try {
    const out = await withTenantContext(tenantId, async (tx) => {
      const job = await tx.importJob.findFirst({ where: { id, tenantId }, select: { id: true, manifest: true } });
      if (!job) return null;
      const conflicts = conflictsOf(job.manifest);
      const ids = [...new Set(conflicts.flatMap((c) => (c.kind === "conflict" ? [c.memberId] : c.memberIds)))];
      const members = ids.length
        ? await tx.member.findMany({ where: { tenantId, id: { in: ids } }, select: CANDIDATE_SELECT })
        : [];
      return { conflicts, members: new Map(members.map((m) => [m.id, m])) };
    });
    if (!out) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // A member deleted since the import is shown without a link (and without data).
    const view = (memberId: string): ConflictMemberView => {
      const m = out.members.get(memberId);
      return m ? { id: m.id, name: m.name, href: `/dashboard/members/${encodeURIComponent(m.id)}` } : { id: memberId, name: null, href: null };
    };
    const items: ConflictView[] = out.conflicts.map((c) => {
      if (c.kind === "ambiguous") return { kind: "ambiguous", name: c.name, rows: c.rows ?? [], reason: c.reason, members: c.memberIds.map(view) };
      const m = out.members.get(c.memberId);
      const now = m ? memberValues(m) : null;
      return {
        kind: "conflict",
        name: c.name,
        rows: c.rows ?? [],
        member: view(c.memberId),
        fields: c.fields.map((f) => {
          const current = now ? now[f.field] : null;
          return {
            field: f.field,
            label: comparedFieldLabel(f.field),
            upload: f.upload,
            atImport: f.matflow,
            now: current,
            stillDiffers: now ? stillDiffers(f.field, f.upload, current) : false,
          };
        }),
      };
    });
    return NextResponse.json({
      conflicts: items,
      counts: {
        conflicts: items.filter((i) => i.kind === "conflict").length,
        ambiguous: items.filter((i) => i.kind === "ambiguous").length,
      },
    });
  } catch (e) {
    return apiError("Couldn't load this import's records to review", 500, e, "[admin/import/conflicts]");
  }
}
