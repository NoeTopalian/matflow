/**
 * Club-managed class categories (Release A, 11 Nov 2026): the server side.
 * Every function takes the caller's tenant transaction and filters by
 * `tenantId` itself (docs/TENANT-SCOPE-CONVENTION.md). Names and the shapes the
 * client sees live in lib/class-category.ts.
 *
 * The database is the last word on every assignment: the trigger
 * matflow_class_category_bridge (migration 20261111120000_class_categories)
 * refuses a category from another club (with the composite foreign key), a new
 * assignment to an archived category, and a write whose old key and reference
 * disagree. The checks here only turn the common cases into a sentence before
 * the write; `classCategoryDbError` turns the trigger's refusal into one after.
 */

import type { Prisma } from "@prisma/client";
import { CLASS_CATEGORIES, type ClassCategoryOption } from "@/lib/class-category";

type Tx = Prisma.TransactionClient;

/** The fields every reader selects through `categoryRef`. */
export const CATEGORY_REF_SELECT = { id: true, name: true, legacyKey: true, archivedAt: true } as const;

/** A class's category as readers return it: the id and the name it shows today. */
export function categoryFields(ref: { id: string; name: string } | null | undefined): { categoryId: string | null; categoryName: string | null } {
  return ref ? { categoryId: ref.id, categoryName: ref.name } : { categoryId: null, categoryName: null };
}

/**
 * The club's eight starting categories, through the one SQL function the
 * migration, the bridge and every club-creation path share (same ids, names
 * and order). Adds nothing when the club has them. New clubs read "Open Mat".
 */
export async function seedClassCategories(tx: Tx, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT matflow_seed_class_categories(${tenantId})`;
}

/**
 * Release B, the activation switch: category management (create, rename, reorder, archive, restore) is offered
 * and accepted only when CLASS_CATEGORY_MANAGEMENT is "on" in this deployment's environment. Off by default.
 * Noe sets it, in production, once the conditions in docs/readiness/CLASS-CATEGORIES-RELEASE-B-2026-11-12.md hold.
 */
export function categoryManagementEnabled(): boolean {
  return process.env.CLASS_CATEGORY_MANAGEMENT === "on";
}

/** A club's categories, at most. Sean's club needs six; eight start every club. */
export const CATEGORY_LIMIT = 40;

/** The namespace of the one lock per club that makes category creates and reorders serial (key 2: the club). */
export const CATEGORIES_LOCK_NS = 0x43415447; // "CATG"

/**
 * Category creates and reorders run one at a time per club. The lock holds no row, so it sits outside the row
 * lock order (docs/design/LOCK-ORDER-2026-10-24.md); after it a category write touches ClassCategory rows only.
 * Both keys are bind parameters (tests/unit/sec-c-static-guards.test.ts).
 */
export async function lockClubCategories(tx: Tx, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CATEGORIES_LOCK_NS}::int4, hashtext(${tenantId}))`;
}

/** One category as the management sheet needs it: its version (for stale checks) and how many classes use it. */
export type ManagedCategory = { id: string; name: string; legacyKey: string | null; archived: boolean; version: number; classCount: number };

/** The club's categories for management: active first in the club's order, then archived; classes on the timetable or paused counted. */
export async function listManagedCategories(tx: Tx, tenantId: string): Promise<ManagedCategory[]> {
  const [rows, counts] = await Promise.all([
    tx.classCategory.findMany({
      where: { tenantId },
      select: { id: true, name: true, legacyKey: true, archivedAt: true, version: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    }),
    tx.class.groupBy({ by: ["categoryId"], where: { tenantId, categoryId: { not: null }, deletedAt: null, sourceImportJobId: null }, _count: { _all: true } }),
  ]);
  const countOf = new Map(counts.map((c) => [c.categoryId, c._count._all]));
  const all = rows.map((r) => ({ id: r.id, name: r.name, legacyKey: r.legacyKey, archived: r.archivedAt !== null, version: r.version, classCount: countOf.get(r.id) ?? 0 }));
  return [...all.filter((c) => !c.archived), ...all.filter((c) => c.archived)];
}

/** The club's categories: active first in the club's order, then archived. */
export async function listClassCategories(tx: Tx, tenantId: string): Promise<ClassCategoryOption[]> {
  const rows = await tx.classCategory.findMany({
    where: { tenantId },
    select: { id: true, name: true, legacyKey: true, archivedAt: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const options = rows.map((r) => ({ id: r.id, name: r.name, legacyKey: r.legacyKey, archived: r.archivedAt !== null }));
  return [...options.filter((o) => !o.archived), ...options.filter((o) => o.archived)];
}

export const CATEGORY_ERRORS = {
  both: "Send a category or an old category key, not both.",
  // Release B: an old page (one from before club-managed categories) choosing a category for a class whose category
  // it cannot show. Refused, never guessed: the old page would replace a category it did not know was there.
  stale: "This page is out of date: the club's categories have changed. Reload the page and choose again.",
  notFound: "That category isn't one of this club's. Reload the page and choose again.",
  archived: "That category has been archived. Choose another, or leave the class uncategorised.",
  conflict: "That category changed while you were saving. Reload the page and try again.",
} as const;

/** A category the write refused before touching anything; the route answers with it. */
export class ClassCategoryRefusal extends Error {
  constructor(readonly status: 400 | 409, message: string) {
    super(message);
  }
}

/**
 * What the request asked for, as the `categoryId` to write, or `undefined` when
 * it named no category (unchanged). `categoryId` is the current form; `category`
 * (an old key) comes from a browser holding a page from before club-managed
 * categories and is translated to the club's category with that key. Run inside
 * the write transaction. `currentCategoryId` is the class's category now (null
 * for a new class): keeping an archived category is allowed, choosing one is not.
 */
export async function categoryIdToWrite(
  tx: Tx,
  tenantId: string,
  input: { categoryId?: string | null; category?: string | null },
  currentCategoryId: string | null,
): Promise<string | null | undefined> {
  const hasId = input.categoryId !== undefined;
  const hasKey = input.category !== undefined;
  if (hasId && hasKey) throw new ClassCategoryRefusal(400, CATEGORY_ERRORS.both);
  if (!hasId && !hasKey) return undefined;

  // Release B's stale-client control. An old key is all a page from before club-managed categories can send, and
  // such a page cannot show a category the club made (it has no old key). So when the class is on a club-made
  // category, an old-key write was chosen without seeing it: refused, whatever key (or null) it carries. The
  // database repeats this for writers that bypass this route (migration 20261112120000_class_category_stale_writer).
  if (hasKey && currentCategoryId) {
    const current = await tx.classCategory.findFirst({ where: { id: currentCategoryId, tenantId }, select: { legacyKey: true } });
    if (current && current.legacyKey === null) throw new ClassCategoryRefusal(409, CATEGORY_ERRORS.stale);
  }

  let row: { id: string; archivedAt: Date | null } | null;
  if (hasId) {
    if (input.categoryId === null) return null;
    row = await tx.classCategory.findFirst({ where: { id: input.categoryId, tenantId }, select: { id: true, archivedAt: true } });
  } else {
    if (input.category === null) return null;
    const key = input.category as string;
    if (!(CLASS_CATEGORIES as readonly string[]).includes(key)) throw new ClassCategoryRefusal(400, CATEGORY_ERRORS.notFound);
    // Counted, never logged with the club or person: the activation gate for
    // Release B is a run of days with no such line (docs/readiness/
    // CLASS-CATEGORIES-RELEASE-A-EVIDENCE-2026-11-11.md §6).
    console.info("[class-category] legacy key write");
    row = await tx.classCategory.findFirst({ where: { tenantId, legacyKey: key }, select: { id: true, archivedAt: true } });
    if (!row) {
      // A club created by an older build during the changeover has no rows yet.
      await seedClassCategories(tx, tenantId);
      row = await tx.classCategory.findFirst({ where: { tenantId, legacyKey: key }, select: { id: true, archivedAt: true } });
    }
  }
  if (!row) throw new ClassCategoryRefusal(400, CATEGORY_ERRORS.notFound);
  if (row.archivedAt !== null && row.id !== currentCategoryId) throw new ClassCategoryRefusal(409, CATEGORY_ERRORS.archived);
  return row.id;
}

/**
 * The trigger's refusal (or the composite foreign key's), as the sentence and
 * status a route answers with, or null when the error is something else.
 * Covers the race the checks above cannot: a category archived between the
 * check and the write.
 */
export function classCategoryDbError(e: unknown): { status: 400 | 409; error: string } | null {
  let text = "";
  try {
    const err = e as { message?: unknown; meta?: unknown; code?: unknown } | null;
    text = `${String(err?.message ?? "")} ${JSON.stringify(err?.meta ?? {})}`;
    if (err?.code === "P2003" && text.includes("categoryId")) return { status: 400, error: CATEGORY_ERRORS.notFound };
  } catch {
    return null;
  }
  if (text.includes("MF_CLASS_CATEGORY_ARCHIVED")) return { status: 409, error: CATEGORY_ERRORS.archived };
  if (text.includes("MF_CLASS_CATEGORY_NOT_FOUND")) return { status: 400, error: CATEGORY_ERRORS.notFound };
  if (text.includes("MF_CLASS_CATEGORY_CONFLICT")) return { status: 409, error: CATEGORY_ERRORS.conflict };
  if (text.includes("MF_CLASS_CATEGORY_STALE_WRITER")) return { status: 409, error: CATEGORY_ERRORS.stale };
  if (text.includes("Class_categoryId_tenantId_fkey")) return { status: 400, error: CATEGORY_ERRORS.notFound };
  return null;
}
