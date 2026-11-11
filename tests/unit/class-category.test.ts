// T6c (Sean note 7): the class category.
//
//  - One canonical list (lib/class-category.ts) with British-English labels.
//  - The create and edit schemas accept a key or null, and refuse anything
//    else (acceptance 3: a 400 and nothing changes).
//  - The migration is expand-only (nullable column, no backfill: acceptance 1)
//    and its CHECK lists exactly the canonical keys, so the DB and the app
//    can never disagree about what a valid category is.
//  - Undo of a class edit restores the previous category (acceptance 2).
//
// Club-managed categories (Release A, 11 Nov 2026) on top of that:
//  - The eight keys survive as each club's starting rows; names are cleaned
//    and compared by one rule; the tag reads the club's name for a category.
//  - The release's migration seeds exactly today's labels for existing clubs
//    ("Open mat") and "Open Mat" for new ones, keyed as categoryNameKey keys.
//  - Undo speaks in `categoryId`. An older row's old keys are translated to
//    this club's categories, and a class whose category changed since (to one
//    the club made, whose old-key column is empty) is never overwritten.
//    Putting back an archived or vanished category is refused.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/checkin", () => ({ restorePackCreditsForAttendance: vi.fn(async () => 0) }));
vi.mock("@/lib/class-lifecycle", () => ({ mintUpcomingSessions: vi.fn(async () => 0) }));

import {
  CATEGORY_NAME_MAX,
  CLASS_CATEGORIES,
  CLASS_CATEGORY_LABELS,
  categoryNameKey,
  categoryNameOf,
  categoryTag,
  classCategoryIdSchema,
  classCategoryLabel,
  classCategorySchema,
  classCategoryTag,
  cleanCategoryName,
  isClassCategory,
} from "@/lib/class-category";
import { classCreateSchema } from "@/lib/schemas/class";
import { decideUndo, applyUndo, REASON, UndoStale, type AuditRowLike, type TxLike } from "@/lib/undo-registry";

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");

/** The newest migration that (re)defines Class_category_check. */
function categoryMigration(): { dir: string; sql: string } {
  const dirs = readdirSync(MIGRATIONS)
    .filter((d) => /^\d{14}_/.test(d))
    .sort()
    .filter((d) => readFileSync(join(MIGRATIONS, d, "migration.sql"), "utf8").includes("Class_category_check"));
  expect(dirs.length, "no migration defines Class_category_check").toBeGreaterThan(0);
  const dir = dirs[dirs.length - 1];
  return { dir, sql: readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8") };
}

const basePayload = {
  name: "No-Gi Advanced",
  duration: 60,
  schedules: [{ dayOfWeek: 2, startTime: "19:00", endTime: "20:00" }],
};

describe("the canonical category list", () => {
  it("is the owner's eight categories, as lowercase keys", () => {
    expect([...CLASS_CATEGORIES]).toEqual([
      "fundamentals", "gi", "nogi", "kids", "competition", "open_mat", "private", "other",
    ]);
    for (const key of CLASS_CATEGORIES) expect(key).toMatch(/^[a-z_]+$/);
  });

  it("labels every key in British English", () => {
    expect(CLASS_CATEGORY_LABELS).toEqual({
      fundamentals: "Fundamentals",
      gi: "Gi",
      nogi: "No-Gi",
      kids: "Kids",
      competition: "Competition",
      open_mat: "Open mat",
      private: "Private",
      other: "Other",
    });
  });

  it("an uncategorised class or an unknown key shows no label (never a raw key)", () => {
    expect(classCategoryLabel(null)).toBeNull();
    expect(classCategoryLabel(undefined)).toBeNull();
    expect(classCategoryLabel("")).toBeNull();
    expect(classCategoryLabel("judo")).toBeNull();
    expect(classCategoryLabel("nogi")).toBe("No-Gi");
    expect(isClassCategory("open_mat")).toBe(true);
    expect(isClassCategory("Open mat")).toBe(false);
  });

  it("the tag does not say Kids twice on a kids class in the Kids category", () => {
    expect(classCategoryTag({ category: "kids", isKids: true })).toBeNull();
    expect(classCategoryTag({ category: "kids", isKids: false })).toBe("Kids");
    expect(classCategoryTag({ category: "gi", isKids: true })).toBe("Gi");
    expect(classCategoryTag({ category: null, isKids: true })).toBeNull();
  });
});

describe("validation (acceptance 3)", () => {
  it("accepts every key and null", () => {
    for (const key of CLASS_CATEGORIES) expect(classCategorySchema.safeParse(key).success).toBe(true);
    expect(classCategorySchema.safeParse(null).success).toBe(true);
  });

  it.each(["NoGi", "No-Gi", "no-gi", "", " nogi", "judo", 3, true])("refuses %j", (value) => {
    expect(classCategorySchema.safeParse(value).success).toBe(false);
  });

  it("create: omitted and null are uncategorised; a key is kept; anything else is refused", () => {
    const omitted = classCreateSchema.safeParse(basePayload);
    expect(omitted.success && omitted.data.category).toBeUndefined();
    const cleared = classCreateSchema.safeParse({ ...basePayload, category: null });
    expect(cleared.success && cleared.data.category).toBeNull();
    const set = classCreateSchema.safeParse({ ...basePayload, category: "nogi" });
    expect(set.success && set.data.category).toBe("nogi");
    expect(classCreateSchema.safeParse({ ...basePayload, category: "No-Gi" }).success).toBe(false);
  });
});

describe("migration (acceptance 1)", () => {
  it("adds a nullable column with no default and no backfill", () => {
    const { sql } = categoryMigration();
    const code = sql.replace(/--.*$/gm, "");
    expect(code).toMatch(/ALTER TABLE "Class" ADD COLUMN\s+"category" TEXT;/);
    expect(code).not.toMatch(/NOT NULL/i);
    expect(code).not.toMatch(/DEFAULT/i);
    expect(code).not.toMatch(/\bUPDATE\b/i);
    expect(code).not.toMatch(/\bDROP\s+(COLUMN|TABLE)\b/i);
    expect(code).not.toMatch(/\bRENAME\b/i);
  });

  it("its CHECK lists exactly the canonical keys and admits NULL", () => {
    const { sql } = categoryMigration();
    const check = sql.match(/CHECK \(\s*"category" IS NULL OR "category" IN \(([^)]*)\)\s*\)/);
    expect(check, "Class_category_check not in the expected shape").toBeTruthy();
    const keys = check![1].split(",").map((k) => k.trim().replace(/^'|'$/g, ""));
    expect(keys).toEqual([...CLASS_CATEGORIES]);
  });

  it("the Prisma schema declares the column as an optional String", () => {
    const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
    const model = schema.slice(schema.indexOf("model Class {"), schema.indexOf("model ClassSchedule {"));
    expect(model).toMatch(/^\s*category\s+String\?\s*$/m);
  });
});

describe("club-managed categories — names (Release A)", () => {
  it("cleans a name for storing and showing", () => {
    expect(cleanCategoryName("  Open   Mat ​")).toBe("Open Mat");
    expect(cleanCategoryName("Be​ginners")).toBe("Beginners");
  });

  it("counts names as the same category whatever their spacing, case or compatibility form", () => {
    expect(categoryNameKey(" beginners ")).toBe(categoryNameKey("Beginners"));
    expect(categoryNameKey("OPEN   MAT")).toBe(categoryNameKey("Open Mat"));
    // Full-width letters fold to their ordinary form.
    expect(categoryNameKey("Ｋｉｄｓ")).toBe("kids");
    expect(categoryNameKey("Intermediate")).not.toBe(categoryNameKey("Advanced"));
  });

  it("the eight starting names key exactly as the migration's lower() keys them", () => {
    for (const label of [...Object.values(CLASS_CATEGORY_LABELS), "Open Mat"]) {
      expect(categoryNameKey(label)).toBe(label.toLowerCase());
    }
  });

  it("a name is at most 32 characters (Noe, 11 Nov 2026)", () => {
    expect(CATEGORY_NAME_MAX).toBe(32);
  });

  it("a category id is a bounded string or null", () => {
    expect(classCategoryIdSchema.safeParse("cat_1").success).toBe(true);
    expect(classCategoryIdSchema.safeParse(null).success).toBe(true);
    expect(classCategoryIdSchema.safeParse("").success).toBe(false);
    expect(classCategoryIdSchema.safeParse("x".repeat(65)).success).toBe(false);
    expect(classCreateSchema.safeParse({ ...basePayload, categoryId: "cat_1" }).success).toBe(true);
  });

  it("the tag is the club's name for the category; Kids is not said twice, a renamed Kids still is", () => {
    expect(categoryTag({ categoryName: "Beginners" })).toBe("Beginners");
    expect(categoryTag({ categoryName: "Kids", isKids: true })).toBeNull();
    expect(categoryTag({ categoryName: "kids ", isKids: true })).toBeNull();
    expect(categoryTag({ categoryName: "Juniors", isKids: true })).toBe("Juniors");
    expect(categoryTag({ categoryName: null })).toBeNull();
  });

  it("a page newer than its server (no categoryName) still labels from the old key; a newer server's null is uncategorised", () => {
    expect(categoryNameOf({ category: "open_mat" })).toBe("Open mat");
    expect(categoryNameOf({ category: "fundamentals", categoryName: "Beginners" })).toBe("Beginners");
    expect(categoryNameOf({ category: null, categoryName: null })).toBeNull();
    expect(categoryNameOf({ category: null, categoryName: "Intermediate" })).toBe("Intermediate");
  });
});

describe("club-managed categories — the migration (Release A)", () => {
  const dir = readdirSync(MIGRATIONS).find((d) => d.endsWith("_class_categories"));
  const sql = readFileSync(join(MIGRATIONS, dir!, "migration.sql"), "utf8");

  it("seeds today's eight, in today's order and spelling, with their old keys", () => {
    const values = [...sql.matchAll(/\('([a-z_]+)', ('[^']+'|p_open_mat_name), (\d)\)/g)].map((m) => [m[1], m[2], Number(m[3])]);
    expect(values.map((v) => v[0])).toEqual([...CLASS_CATEGORIES]);
    expect(values.map((v) => v[2])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const [key, name] of values) {
      if (key === "open_mat") expect(name).toBe("p_open_mat_name");
      else expect(name).toBe(`'${CLASS_CATEGORY_LABELS[key as keyof typeof CLASS_CATEGORY_LABELS]}'`);
    }
  });

  it("existing clubs keep \"Open mat\"; clubs created later start with \"Open Mat\"", () => {
    expect(sql).toMatch(/p_open_mat_name TEXT DEFAULT 'Open Mat'/);
    expect(sql).toMatch(/SELECT matflow_seed_class_categories\("id", 'Open mat'\) FROM "Tenant";/);
  });

  it("the legacy-key CHECK lists exactly the canonical keys", () => {
    const check = sql.match(/"legacyKey" IS NULL OR "legacyKey" IN \(([^)]*)\)/);
    expect(check).toBeTruthy();
    expect(check![1].split(",").map((k) => k.trim().replace(/^'|'$/g, ""))).toEqual([...CLASS_CATEGORIES]);
  });

  it("keeps the old column and its CHECK (a build from before the release still writes them)", () => {
    const code = sql.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/DROP\s+(COLUMN|CONSTRAINT|TABLE)/i);
    expect(code).not.toMatch(/Class_category_check/);
  });

  it("the composite key ties a class's category to its own club", () => {
    expect(sql).toMatch(/FOREIGN KEY \("categoryId", "tenantId"\) REFERENCES "ClassCategory"\("id", "tenantId"\)/);
  });

  it("takes Class then Tenant explicitly before anything else (the application's order), under the 5 s lock wait", () => {
    const code = sql.replace(/--.*$/gm, "");
    const cls = code.indexOf('LOCK TABLE "Class" IN ACCESS EXCLUSIVE MODE;');
    const tenant = code.indexOf('LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE;');
    expect(cls).toBeGreaterThan(code.indexOf("SET LOCAL statement_timeout"));
    expect(tenant).toBeGreaterThan(cls);
    expect(code.indexOf("CREATE TABLE")).toBeGreaterThan(tenant);
  });

  it("the column markers sort before the bridge, so a statement that names both columns is always seen as such", () => {
    const names = [...sql.matchAll(/CREATE TRIGGER "([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(["Class_category_0_key_named", "Class_category_0_ref_named", "Class_category_bridge"]);
    expect([...names].sort()).toEqual(names);
    expect(sql).toMatch(/BEFORE UPDATE OF "category" ON "Class"\s+FOR EACH ROW EXECUTE FUNCTION matflow_class_category_mark\('key'\)/);
    expect(sql).toMatch(/BEFORE UPDATE OF "categoryId" ON "Class"\s+FOR EACH ROW EXECUTE FUNCTION matflow_class_category_mark\('ref'\)/);
  });

  it("every function pins its search_path; names are held to 32 characters by the database too", () => {
    const functions = [...sql.matchAll(/CREATE FUNCTION [^\n]+\n?[^\n]*/g)].map((m) => m[0]);
    expect(functions).toHaveLength(3);
    for (const f of functions) expect(f).toMatch(/SET search_path = public, pg_temp/);
    expect(sql).toMatch(/CHECK \(char_length\("name"\) BETWEEN 1 AND 32\)/);
  });

  it("neither function runs with elevated rights (both are SECURITY INVOKER, under row-level security)", () => {
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/SECURITY DEFINER/i);
    expect(sql).toMatch(/ALTER TABLE "ClassCategory" FORCE ROW LEVEL SECURITY/);
  });
});

describe("undo restores the previous category (acceptance 2, club-managed categories)", () => {
  const fake = {
    class: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    classCategory: { findFirst: vi.fn() },
  };
  const tx = fake as unknown as TxLike;
  const row = (metadata: unknown): AuditRowLike => ({
    id: "a1", tenantId: "t1", userId: "u1", action: "class.updated",
    entityType: "Class", entityId: "c1", metadata, createdAt: new Date("2026-10-17T09:00:00.000Z"),
  });
  /** This club's starting rows, by old key; cat-own is one the club made. */
  const IDS: Record<string, string> = { gi: "cat-gi", nogi: "cat-nogi", competition: "cat-comp" };
  const current = (categoryId: string | null, category: string | null) =>
    ({ id: "c1", tenantId: "t1", categoryId, category, isActive: true, sourceImportJobId: null, matId: null });

  beforeEach(() => {
    vi.clearAllMocks();
    fake.class.update.mockResolvedValue({});
    fake.classCategory.findFirst.mockImplementation(async ({ where }: { where: { legacyKey?: string; id?: string; tenantId: string } }) => {
      expect(where.tenantId).toBe("t1");
      if (where.legacyKey) return IDS[where.legacyKey] ? { id: IDS[where.legacyKey] } : null;
      if (where.id === "cat-archived") return { archivedAt: new Date() };
      if (where.id && where.id.startsWith("cat-")) return { archivedAt: null };
      return null;
    });
  });

  it("an older row (old keys): puts the earlier category back, as this club's category with that key", async () => {
    fake.class.findFirst.mockResolvedValue(current("cat-nogi", "nogi"));
    const r = row({ fields: ["category"], before: { category: "gi" }, after: { category: "nogi" } });
    expect(decideUndo(r, false)).toEqual({ ok: true });
    await applyUndo(tx, r);
    expect(fake.class.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { categoryId: "cat-gi" } });
  });

  it("an older row: puts an uncategorised class back to uncategorised", async () => {
    fake.class.findFirst.mockResolvedValue(current("cat-nogi", "nogi"));
    await applyUndo(tx, row({ fields: ["category"], before: { category: null }, after: { category: "nogi" } }));
    expect(fake.class.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { categoryId: null } });
  });

  it("an older row: refuses as stale when the category has been changed again since", async () => {
    fake.class.findFirst.mockResolvedValue(current("cat-comp", "competition"));
    await expect(
      applyUndo(tx, row({ fields: ["category"], before: { category: "gi" }, after: { category: "nogi" } })),
    ).rejects.toBeInstanceOf(UndoStale);
    expect(fake.class.update).not.toHaveBeenCalled();
  });

  it("an older row that CLEARED the category does not overwrite a category the club made since (its old key is empty too)", async () => {
    // The edit took the class from Gi to uncategorised; since then it has been put on a category the club made,
    // whose old-key column is NULL — the same as "uncategorised" to a key-only comparison.
    fake.class.findFirst.mockResolvedValue(current("cat-own", null));
    await expect(
      applyUndo(tx, row({ fields: ["category"], before: { category: "gi" }, after: { category: null } })),
    ).rejects.toBeInstanceOf(UndoStale);
    expect(fake.class.update).not.toHaveBeenCalled();
  });

  it("this release's rows: puts the earlier category back by id", async () => {
    fake.class.findFirst.mockResolvedValue(current("cat-own", null));
    await applyUndo(tx, row({ fields: ["categoryId"], before: { categoryId: "cat-gi" }, after: { categoryId: "cat-own" } }));
    expect(fake.class.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { categoryId: "cat-gi" } });
  });

  it("refuses to put back a category archived since", async () => {
    fake.class.findFirst.mockResolvedValue(current("cat-own", null));
    const p = applyUndo(tx, row({ fields: ["categoryId"], before: { categoryId: "cat-archived" }, after: { categoryId: "cat-own" } }));
    await expect(p).rejects.toThrow(REASON.categoryArchived);
    expect(fake.class.update).not.toHaveBeenCalled();
  });

  it("refuses to put back a category that is not this club's (or no longer exists)", async () => {
    fake.class.findFirst.mockResolvedValue(current("cat-own", null));
    const p = applyUndo(tx, row({ fields: ["categoryId"], before: { categoryId: "gone" }, after: { categoryId: "cat-own" } }));
    await expect(p).rejects.toThrow(REASON.categoryGone);
    expect(fake.class.update).not.toHaveBeenCalled();
  });

  it("an older row naming a key this club has no row for is refused, not guessed", async () => {
    fake.class.findFirst.mockResolvedValue(current("cat-nogi", "nogi"));
    const p = applyUndo(tx, row({ fields: ["category"], before: { category: "private" }, after: { category: "nogi" } }));
    await expect(p).rejects.toThrow(REASON.categoryGone);
    expect(fake.class.update).not.toHaveBeenCalled();
  });
});
