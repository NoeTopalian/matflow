/**
 * Reads and the one multi-step write the mats routes share. Server side:
 * every function takes the caller's tenant transaction and filters by
 * `tenantId` itself (docs/TENANT-SCOPE-CONVENTION.md). Names, the lock and
 * the write-through rule live in lib/mats.ts.
 */

import type { Prisma } from "@prisma/client";
import { liveClassWhere } from "@/lib/class-live";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { MAT_LIMIT, MAT_NAME_MAX, cleanMatName, commonestSpelling, compareMatNames, matNameKey } from "@/lib/mats";
import { effectiveLayout, isTimetableLayout, type TimetableLayout } from "@/lib/timetable-layout";

type Tx = Prisma.TransactionClient;

export interface MatRow {
  id: string;
  name: string;
  nameKey: string;
  sortOrder: number;
}

/** The club's mats in the club's order (the order of the columns). */
export function listMats(tx: Tx, tenantId: string): Promise<MatRow[]> {
  return tx.mat.findMany({
    where: { tenantId },
    select: { id: true, name: true, nameKey: true, sortOrder: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
}

/** How many mats have at least one class that is on the timetable. */
export async function countMatsInUse(tx: Tx, tenantId: string): Promise<number> {
  const rows = await tx.class.findMany({
    where: { ...liveClassWhere(tenantId), matId: { not: null } },
    select: { matId: true },
    distinct: ["matId"],
  });
  return rows.length;
}

export interface LayoutState {
  /** What somebody chose, or null when nobody has. */
  stored: TimetableLayout | null;
  /** The split in effect (lib/timetable-layout.ts). */
  effective: TimetableLayout;
}

export async function readLayout(tx: Tx, tenantId: string): Promise<LayoutState> {
  const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { timetableLayout: true } });
  const stored = isTimetableLayout(tenant?.timetableLayout) ? tenant.timetableLayout : null;
  return { stored, effective: effectiveLayout(stored, await countMatsInUse(tx, tenantId)) };
}

/**
 * What the Timetable page needs about mats: the list in order and the split
 * somebody chose. Read APART from the classes, in its own transaction, and
 * guarded: a statement that fails inside a tenant transaction aborts that
 * whole transaction, and a timetable must not go blank because its mats could
 * not be read. On failure the page renders split by time and says so
 * (`failed`); the classes are untouched.
 */
export async function readMatsForTimetable(
  tenantId: string,
): Promise<{ mats: { id: string; name: string }[]; storedLayout: TimetableLayout | null; failed: boolean }> {
  try {
    return await withTenantContext(tenantId, async (tx) => {
      const mats = await listMats(tx, tenantId);
      const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { timetableLayout: true } });
      return {
        mats: mats.map((m) => ({ id: m.id, name: m.name })),
        storedLayout: isTimetableLayout(tenant?.timetableLayout) ? tenant.timetableLayout : null,
        failed: false,
      };
    });
  } catch (e) {
    console.error("[timetable] the mats could not be loaded; rendering split by time", e);
    return { mats: [], storedLayout: null, failed: true };
  }
}

export interface AdoptedMat {
  id: string;
  name: string;
  /** False when the mat was already there and only gained classes. */
  created: boolean;
  classIds: string[];
}
export interface AdoptResult {
  mats: AdoptedMat[];
  skipped: { key: string; reason: "too_long" | "limit" }[];
}

/**
 * Turns typed places into mats. For each key, in number-aware name order:
 * find the club's mat of that name or create it (named by the commonest
 * spelling), then put on it every class of the club whose typed place is that
 * name and which is on no mat, setting the place text to the mat's name (the
 * write-through rule). The matches are worked out here from the database,
 * never taken from the caller. A key no class types is ignored; a place too
 * long for a mat name, or past the twelfth mat, is skipped and reported.
 *
 * Call with the club's mats lock held (lockClubMats). Imported history classes
 * are left alone: they are never on a timetable.
 */
export async function adoptPlaces(tx: Tx, tenantId: string, keys: readonly string[]): Promise<AdoptResult> {
  const wanted = new Set(keys.map(matNameKey).filter(Boolean));
  const result: AdoptResult = { mats: [], skipped: [] };
  if (wanted.size === 0) return result;

  const classes = await tx.class.findMany({
    where: { tenantId, matId: null, sourceImportJobId: null, location: { not: null } },
    select: { id: true, location: true, deletedAt: true },
    orderBy: { id: "asc" },
  });
  // key → its classes, and how often each spelling is typed on a class that is not archived.
  const byKey = new Map<string, { ids: string[]; spellings: Map<string, number>; anySpelling: string }>();
  for (const c of classes) {
    const name = cleanMatName(c.location ?? "");
    const key = name.toLowerCase();
    if (!name || !wanted.has(key)) continue;
    const entry = byKey.get(key) ?? { ids: [], spellings: new Map<string, number>(), anySpelling: name };
    entry.ids.push(c.id);
    if (!c.deletedAt) entry.spellings.set(name, (entry.spellings.get(name) ?? 0) + 1);
    byKey.set(key, entry);
  }
  const named = [...byKey].map(([key, entry]) => {
    const name = commonestSpelling(entry.spellings) ?? entry.anySpelling;
    return { key, name, ids: entry.ids };
  });
  named.sort((a, b) => compareMatNames(a.name, b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const existing = await listMats(tx, tenantId);
  const matByKey = new Map(existing.map((m) => [m.nameKey, m]));
  let count = existing.length;
  let nextOrder = existing.reduce((max, m) => Math.max(max, m.sortOrder), -1) + 1;

  for (const { key, name, ids } of named) {
    let mat = matByKey.get(key) ?? null;
    let created = false;
    if (!mat) {
      if (name.length > MAT_NAME_MAX) {
        result.skipped.push({ key, reason: "too_long" });
        continue;
      }
      if (count >= MAT_LIMIT) {
        result.skipped.push({ key, reason: "limit" });
        continue;
      }
      mat = await tx.mat.create({
        data: { tenantId, name, nameKey: key, sortOrder: nextOrder },
        select: { id: true, name: true, nameKey: true, sortOrder: true },
      });
      created = true;
      count += 1;
      nextOrder += 1;
    }
    await tx.class.updateMany({ where: { tenantId, id: { in: ids }, matId: null }, data: { matId: mat.id, location: mat.name } });
    result.mats.push({ id: mat.id, name: mat.name, created, classIds: ids });
  }
  return result;
}

/** The class form's Location, as the class routes resolve it (`matForLocation`). */
export type LocationResult =
  /**
   * The class goes on this mat; `created` when this call added it. `classIds`: the club's other classes that
   * typed the name and were put on the new mat with it (always empty for a mat that was already there).
   */
  | { kind: "mat"; id: string; name: string; created: boolean; classIds: string[] }
  /** No mat: the class keeps the name as its typed place (a caller that may not add mats). */
  | { kind: "place"; name: string }
  /** No mat of that name and the club already has MAT_LIMIT: nothing was written. */
  | { kind: "limit" };

/**
 * The class form's Location field (Noe, 7 Nov 2026: "save whats written into
 * it as a Location"): the club's mat of this name, whatever its capitals and
 * spacing; when there is none, a new mat of that name, added in the caller's
 * transaction and recorded exactly as POST /api/mats records one
 * (`mat.create`, in the same transaction), so Activity and redaction treat it
 * the same.
 *
 * A mat ADDED here takes with it every other class of the club whose typed
 * place is that name and which is on no mat (the same match, the same
 * classes and the same place text as the Mats sheet's "Add these as mats",
 * lib/mats-store.ts adoptPlaces), recorded as adopt records it (`mat.adopt`,
 * with the class ids). So a saved location never sits beside the same name
 * still typed on other classes (review of PR #77, 7 Nov 2026). A mat that was
 * already there takes only the class being saved: older classes that type
 * its name are left for the Mats sheet, and no save that does not change a
 * class's Location ever moves it.
 *
 * `mayAddMat: false` (a MatFlow support session, which may edit a class but
 * not set up mats — RULES §5b): an existing mat is still used, and a new
 * name stays the class's typed place with no mat and no refusal.
 *
 * Call with the club's mats lock held (lockClubMats), so the cap and the next
 * position cannot be raced. `name` is already clean (cleanMatName), non-empty
 * and, when a mat may be added, at most MAT_NAME_MAX characters.
 * `exceptClassId`: the class being saved, which the caller writes itself.
 */
export async function matForLocation(
  tx: Tx,
  tenantId: string,
  name: string,
  opts: { mayAddMat: boolean; userId: string; req?: Request; exceptClassId?: string },
): Promise<LocationResult> {
  const key = matNameKey(name);
  const mats = await listMats(tx, tenantId);
  const found = mats.find((m) => m.nameKey === key);
  if (found) return { kind: "mat", id: found.id, name: found.name, created: false, classIds: [] };
  if (!opts.mayAddMat || name.length > MAT_NAME_MAX) return { kind: "place", name };
  if (mats.length >= MAT_LIMIT) return { kind: "limit" };
  const sortOrder = mats.reduce((max, m) => Math.max(max, m.sortOrder), -1) + 1;
  const row = await tx.mat.create({ data: { tenantId, name, nameKey: key, sortOrder }, select: { id: true, name: true } });
  await logAudit({ tenantId, userId: opts.userId, action: "mat.create", entityType: "Mat", entityId: row.id, metadata: { name: row.name }, req: opts.req, tx });
  // The club's other classes that type this name and are on no mat (adoptPlaces' match: imported history excepted).
  const typed = await tx.class.findMany({
    where: { tenantId, matId: null, sourceImportJobId: null, location: { not: null } },
    select: { id: true, location: true },
    orderBy: { id: "asc" },
  });
  const classIds = typed.filter((c) => c.id !== opts.exceptClassId && matNameKey(c.location ?? "") === key).map((c) => c.id);
  if (classIds.length > 0) {
    await tx.class.updateMany({ where: { tenantId, id: { in: classIds }, matId: null }, data: { matId: row.id, location: row.name } });
    await logAudit({
      tenantId, userId: opts.userId, action: "mat.adopt", entityType: "Tenant", entityId: tenantId,
      metadata: { mats: [{ id: row.id, name: row.name, created: false, classIds }] }, req: opts.req, tx,
    });
  }
  return { kind: "mat", id: row.id, name: row.name, created: true, classIds };
}
