// GET /api/admin/import — the owner's import history.
//
// The Import panel used to keep the job it had just run in page state only, so
// after a reload the owner could neither see a past import nor roll one back,
// and "see import history for details" pointed at nothing (verifier, 30 Sep
// 2026, D1). This is that history: the last 50 jobs, newest first, member and
// attendance imports alike.
//
// A SAFE projection only. `fileBlobUrl` is a readable URL to the raw member
// file and never leaves the server (see publicJobView in ../upload/route); the
// full manifest can carry per-row detail, so only the figures the history
// screen shows are lifted out of it.

import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { apiError } from "@/lib/api-error";
import { publicJobView } from "./upload/route";

export const runtime = "nodejs";

const LIMIT = 50;
const ATTENDANCE_SOURCE = "teamup-attendance";
const ERROR_SAMPLE = 5;
const REASON_MAX = 200;

type Kind = "members" | "attendance";

type Kept = { memberId: string; name: string; reasons: string[] };

export type ImportHistoryRollback =
  | { kind: "members"; removed: number; kept: Kept[] }
  | { kind: "attendance"; recordsRemoved: number; instancesRemoved: number; instancesKept: number };

export type ImportHistoryItem = {
  id: string;
  kind: Kind;
  source: string;
  fileName: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  rolledBackAt: string | null;
  importedRows: number;
  skippedRows: number;
  errorRows: number;
  sourceExportedAt: string | null;
  mappingVersion: string | null;
  reconciles: boolean | null;
  createdTotal: number | null;
  rollback: ImportHistoryRollback | null;
  /** Row-level problems (row > 0), capped, for a failed or partly failed job. */
  rowErrors: { row: number; reason: string }[];
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

function project(job: Parameters<typeof publicJobView>[0]): ImportHistoryItem {
  const v = publicJobView(job);
  const manifest = (v.manifest && typeof v.manifest === "object" ? v.manifest : {}) as Record<string, unknown>;
  const kind: Kind = v.source === ATTENDANCE_SOURCE || manifest.kind === "attendance" ? "attendance" : "members";

  const created = manifest.created as { total?: unknown } | undefined;
  const rb = manifest.rollback as Record<string, unknown> | undefined;
  let rollback: ImportHistoryRollback | null = null;
  if (rb && typeof rb === "object") {
    if (kind === "attendance") {
      rollback = {
        kind,
        recordsRemoved: num(rb.recordsRemoved),
        instancesRemoved: num(rb.instancesRemoved),
        instancesKept: num(rb.instancesKept),
      };
    } else {
      const kept = Array.isArray(rb.kept) ? (rb.kept as Kept[]) : [];
      rollback = {
        kind,
        removed: num(rb.removed),
        kept: kept.map((k) => ({
          memberId: String(k.memberId),
          name: String(k.name),
          reasons: Array.isArray(k.reasons) ? k.reasons.map(String) : [],
        })),
      };
    }
  }

  const log = Array.isArray(v.errorLog) ? (v.errorLog as { row?: unknown; reason?: unknown }[]) : [];
  const rowErrors = log
    .filter((e) => typeof e?.row === "number" && e.row > 0)
    .slice(0, ERROR_SAMPLE)
    .map((e) => ({ row: e.row as number, reason: String(e.reason ?? "").slice(0, REASON_MAX) }));

  return {
    id: v.id,
    kind,
    source: v.source,
    fileName: v.fileName,
    status: v.status,
    createdAt: iso(v.createdAt)!,
    completedAt: iso(v.completedAt),
    rolledBackAt: iso(v.rolledBackAt),
    importedRows: v.importedRows,
    skippedRows: v.skippedRows,
    errorRows: v.errorRows,
    sourceExportedAt: iso(v.sourceExportedAt),
    mappingVersion: v.mappingVersion,
    reconciles: typeof manifest.reconciles === "boolean" ? manifest.reconciles : null,
    createdTotal: created && typeof created.total === "number" ? created.total : null,
    rollback,
    rowErrors,
  };
}

export async function GET() {
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;

  try {
    const jobs = await withTenantContext(tenantId, (tx) =>
      tx.importJob.findMany({
        where: { tenantId },
        orderBy: { createdAt: "desc" },
        take: LIMIT,
      }),
    );
    return NextResponse.json({ jobs: jobs.map(project) });
  } catch (e) {
    return apiError("Couldn't load your import history", 500, e, "[admin/import]");
  }
}
