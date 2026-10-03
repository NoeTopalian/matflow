// GET /api/settings/import-reconciliation?jobId= — an independent, read-only
// reconciliation of one member import (3 Oct 2026, Total BJJ handover).
//
// Owner-only, like every import route. Tenant-scoped: the job must belong to
// the caller's club, and every count is read through withTenantContext
// (lib/import-reconciliation.ts). The response carries counts, the club's own
// plan labels and statuses, and source row numbers — never a name, email,
// phone or date of birth. Without jobId it reconciles the newest import that
// has not been rolled back; `jobs` always lists the club's recent imports.
import { NextResponse } from "next/server";
import { requireApiOwner } from "@/lib/api-authz";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";
import { listReconcilableImports, reconcileImport } from "@/lib/import-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  // Each call reads every member of an import plus their payments, check-ins
  // and waivers: cheap once, not something to loop on.
  const rl = await checkRateLimit(`import:reconcile:${tenantId}`, 30, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many reconciliation runs. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const requested = new URL(req.url).searchParams.get("jobId");
  if (requested !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(requested)) {
    return NextResponse.json({ error: "That import id is not valid." }, { status: 400 });
  }

  try {
    const jobs = await listReconcilableImports(tenantId);
    const jobId = requested ?? jobs.find((j) => !j.rolledBack)?.id ?? null;
    if (!jobId) {
      return NextResponse.json({ jobs, result: null }, { headers: { "Cache-Control": "no-store" } });
    }
    const result = await reconcileImport(tenantId, jobId);
    // Another club's job id is indistinguishable from one that never existed.
    if (!result) return NextResponse.json({ error: "Import not found." }, { status: 404 });
    return NextResponse.json({ jobs, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return apiError("Couldn't reconcile the import. Try again.", 500, e, "settings.import-reconciliation", { req, tenantId, userId });
  }
}
