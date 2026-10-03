/**
 * The in-product reconciliation (lib/import-reconciliation.ts) against a REAL
 * database — the test branch, never production (tests/setup-test-db.ts
 * refuses the production endpoint). Its unit tests run on mocks; this is the
 * first run of the real queries end to end: find the newest completed,
 * not-rolled-back import on the branch and reconcile it. It asserts the shape
 * and the tenant scoping, not a verdict — the branch holds whatever the last
 * rehearsal left — and prints counts only (no names, no emails).
 */
import { describe, it, expect } from "vitest";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("import reconciliation — live queries on the test branch", () => {
  it("reconciles the newest completed import and returns tenant-scoped counts only", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { reconcileImport, listReconcilableImports } = await import("@/lib/import-reconciliation");

    const job = await prisma.importJob.findFirst({
      where: { status: "complete", rolledBackAt: null, mode: "create" },
      orderBy: { completedAt: "desc" },
      select: { id: true, tenantId: true, source: true, mode: true, importedRows: true },
    });
    if (!job) {
      console.log("no completed import on this branch — nothing to reconcile (not a failure)");
      return;
    }

    const listed = await listReconcilableImports(job.tenantId);
    expect(Array.isArray(listed)).toBe(true);
    expect(listed.some((j: { id: string }) => j.id === job.id)).toBe(true);

    const result = await reconcileImport(job.tenantId, job.id);
    expect(result).not.toBeNull();
    const checks = (result as { checks: { check: string; ok: boolean; kind?: string }[] }).checks;
    expect(checks.length).toBeGreaterThan(5);

    // Another club must not be able to reconcile this job.
    const other = await prisma.tenant.findFirst({ where: { id: { not: job.tenantId } }, select: { id: true } });
    if (other) expect(await reconcileImport(other.id, job.id)).toBeNull();

    // No personal data leaves the module: the serialised result carries no "@".
    const text = JSON.stringify(result);
    expect(text.includes("@")).toBe(false);

    const failed = checks.filter((c) => !c.ok).map((c) => `${c.kind ?? ""}:${c.check}`);
    console.log(`job ${job.source}/${job.mode} importedRows=${job.importedRows}: ${checks.length} checks, ${failed.length} not ok ${failed.length ? "→ " + failed.join(" | ") : ""}`);
  }, 120_000);
});
