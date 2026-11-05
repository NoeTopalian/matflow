/**
 * Reads and the one multi-step write the mats routes share. Server side:
 * every function takes the caller's tenant transaction and filters by
 * `tenantId` itself (docs/TENANT-SCOPE-CONVENTION.md). Names, the lock and
 * the write-through rule live in lib/mats.ts.
 */

import type { Prisma } from "@prisma/client";
import { liveClassWhere } from "@/lib/class-live";
import { MAT_LIMIT, MAT_NAME_MAX, cleanMatName, compareMatNames, matNameKey } from "@/lib/mats";
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
    const [name] = [...entry.spellings].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0] ?? [entry.anySpelling];
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
