/**
 * When a member is deleted or erased, the people an import listed for review
 * (ImportJob.manifest.conflicts) must not keep that member's name, contact
 * details or values (25 Oct 2026). Each entry that names the member is reduced
 * to its kind, so the job's counts still add up and nothing personal is left.
 *
 * Runs inside the caller's transaction (the member deletion or the DSAR
 * erasure), tenant-scoped. A club has at most a few hundred import jobs; the
 * scan reads only their manifests.
 */
import type { Prisma } from "@prisma/client";

type Tx = Pick<Prisma.TransactionClient, "importJob">;
type Entry = { kind?: unknown; memberId?: unknown; memberIds?: unknown };

function names(entry: Entry, memberId: string): boolean {
  if (entry.memberId === memberId) return true;
  return Array.isArray(entry.memberIds) && entry.memberIds.includes(memberId);
}

/** Returns how many entries were reduced. */
export async function scrubImportConflictsFor(tx: Tx, tenantId: string, memberId: string): Promise<number> {
  const jobs = await tx.importJob.findMany({ where: { tenantId }, select: { id: true, manifest: true } });
  let scrubbed = 0;
  for (const job of jobs) {
    const manifest = job.manifest;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) continue;
    const conflicts = (manifest as { conflicts?: unknown }).conflicts;
    if (!Array.isArray(conflicts)) continue;
    let changed = false;
    const next = (conflicts as Entry[]).map((c) => {
      if (!c || typeof c !== "object" || !names(c, memberId)) return c;
      changed = true;
      scrubbed += 1;
      return { kind: c.kind === "ambiguous" ? "ambiguous" : "conflict" };
    });
    if (!changed) continue;
    await tx.importJob.updateMany({
      where: { id: job.id, tenantId },
      data: { manifest: { ...(manifest as Record<string, unknown>), conflicts: next } as Prisma.InputJsonValue },
    });
  }
  return scrubbed;
}
