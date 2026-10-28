/**
 * When a member is deleted or erased, the stored import records must not keep
 * that member's name, contact details or values (25 Oct 2026; contract
 * TEAMUP-OPERATIONS-CONTRACT §3: "A member deleted or erased since is shown
 * with no name or values, and their entries are scrubbed from the stored
 * import record").
 *
 * 25 Oct 2026 scrubbed only the review list (`manifest.conflicts`). The same
 * job record also keeps entries that name the member by id elsewhere — a
 * refresh's exceptions (not in the file, billed by MatFlow, holds kept), a
 * rollback's "kept" list, a pre-rule refresh's change list, the preview stored
 * in `dryRunSummary` — and entries that carry their source record key (the
 * owner's decisions and scheduled starts). Those were served back by
 * GET admin/import and GET admin/import/[id] with the name in them (27 Oct 2026).
 *
 * The rule, by exact identifier only (never by name):
 *  - an entry of `conflicts` naming the member is reduced to its kind, so the
 *    job's counts still add up (unchanged from 25 Oct);
 *  - any other entry, anywhere in `manifest` or `dryRunSummary`, whose
 *    `memberId` is the member, whose `memberIds` include them, or whose
 *    `sourceKey` is their source record key (`Member.externalRef`) is removed
 *    from its list; the member's id is removed from id lists.
 * Entries that carry only a name or an address (no id, no key) are left: see
 * the open question in docs/readiness/TEAMUP-OPERATIONS-CONTRACT.md §3.
 *
 * Runs inside the caller's transaction (the member deletion or the DSAR
 * erasure), tenant-scoped, BEFORE the member row's externalRef is nulled.
 */
import type { Prisma } from "@prisma/client";

type Tx = Pick<Prisma.TransactionClient, "importJob">;
const ATTENDANCE_SOURCE = "teamup-attendance";
type Who = { memberId: string; sourceKey: string | null };

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function names(entry: Record<string, unknown>, who: Who): boolean {
  if (entry.memberId === who.memberId) return true;
  if (Array.isArray(entry.memberIds) && entry.memberIds.includes(who.memberId)) return true;
  return !!who.sourceKey && entry.sourceKey === who.sourceKey;
}

/** Returns the scrubbed value and how many entries it reduced or removed. */
function scrub(value: unknown, who: Who, key: string | null): { value: unknown; n: number } {
  if (Array.isArray(value)) {
    let n = 0;
    const out: unknown[] = [];
    for (const el of value) {
      if (el === who.memberId) { n += 1; continue; }
      if (isObject(el) && names(el, who)) {
        n += 1;
        // The review list keeps a kind-only entry so its counts still add up.
        if (key === "conflicts") out.push({ kind: el.kind === "ambiguous" ? "ambiguous" : "conflict" });
        continue;
      }
      const r = scrub(el, who, null);
      n += r.n;
      out.push(r.value);
    }
    return { value: out, n };
  }
  if (isObject(value)) {
    if (names(value, who)) return { value: { removed: true }, n: 1 };
    let n = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = scrub(v, who, k);
      n += r.n;
      out[k] = r.value;
    }
    return { value: out, n };
  }
  return { value, n: 0 };
}

/** Pure: one stored import record (a manifest or a stored preview) with the member scrubbed. */
export function scrubImportRecord(record: unknown, memberId: string, sourceKey?: string | null): { value: unknown; scrubbed: number } {
  const r = scrub(record, { memberId, sourceKey: sourceKey ?? null }, null);
  return { value: r.value, scrubbed: r.n };
}

/** Returns how many entries were reduced or removed. `sourceKey`: the member's externalRef before any erasure. */
export async function scrubImportConflictsFor(tx: Tx, tenantId: string, memberId: string, sourceKey?: string | null): Promise<number> {
  const jobs = await tx.importJob.findMany({ where: { tenantId }, select: { id: true, source: true, manifest: true, dryRunSummary: true } });
  let scrubbed = 0;
  for (const job of jobs) {
    // Members imports only. An attendance job's stored plan drives its own
    // commit and rollback, and its imported history is erased separately
    // (ImportedBooking, ImportSourceMapping).
    if (job.source === ATTENDANCE_SOURCE || (isObject(job.manifest) && job.manifest.kind === "attendance")) continue;
    const data: { manifest?: Prisma.InputJsonValue; dryRunSummary?: Prisma.InputJsonValue } = {};
    for (const field of ["manifest", "dryRunSummary"] as const) {
      const stored = job[field];
      if (!stored || typeof stored !== "object") continue;
      const r = scrubImportRecord(stored, memberId, sourceKey);
      if (r.scrubbed === 0) continue;
      scrubbed += r.scrubbed;
      data[field] = r.value as Prisma.InputJsonValue;
    }
    if (Object.keys(data).length === 0) continue;
    await tx.importJob.updateMany({ where: { id: job.id, tenantId }, data });
  }
  return scrubbed;
}
