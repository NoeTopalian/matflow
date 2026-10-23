// T6c (Sean note 7): the class category.
//
//  - One canonical list (lib/class-category.ts) with British-English labels.
//  - The create and edit schemas accept a key or null, and refuse anything
//    else (acceptance 3: a 400 and nothing changes).
//  - The migration is expand-only (nullable column, no backfill: acceptance 1)
//    and its CHECK lists exactly the canonical keys, so the DB and the app
//    can never disagree about what a valid category is.
//  - Undo of a class edit restores the previous category (acceptance 2).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/checkin", () => ({ restorePackCreditsForAttendance: vi.fn(async () => 0) }));
vi.mock("@/lib/class-lifecycle", () => ({ mintUpcomingSessions: vi.fn(async () => 0) }));

import {
  CLASS_CATEGORIES,
  CLASS_CATEGORY_LABELS,
  classCategoryLabel,
  classCategorySchema,
  classCategoryTag,
  isClassCategory,
} from "@/lib/class-category";
import { classCreateSchema } from "@/lib/schemas/class";
import { decideUndo, applyUndo, UndoStale, type AuditRowLike, type TxLike } from "@/lib/undo-registry";

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

describe("undo restores the previous category (acceptance 2)", () => {
  const fake = { class: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() } };
  const tx = fake as unknown as TxLike;
  const row = (metadata: unknown): AuditRowLike => ({
    id: "a1", tenantId: "t1", userId: "u1", action: "class.updated",
    entityType: "Class", entityId: "c1", metadata, createdAt: new Date("2026-10-17T09:00:00.000Z"),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fake.class.update.mockResolvedValue({});
  });

  it("puts the earlier category back", async () => {
    fake.class.findFirst.mockResolvedValue({ id: "c1", tenantId: "t1", category: "nogi", isActive: true, sourceImportJobId: null });
    const r = row({ fields: ["category"], before: { category: "gi" }, after: { category: "nogi" } });
    expect(decideUndo(r, false)).toEqual({ ok: true });
    await applyUndo(tx, r);
    expect(fake.class.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { category: "gi" } });
  });

  it("puts an uncategorised class back to uncategorised", async () => {
    fake.class.findFirst.mockResolvedValue({ id: "c1", tenantId: "t1", category: "nogi", isActive: true, sourceImportJobId: null });
    await applyUndo(tx, row({ fields: ["category"], before: { category: null }, after: { category: "nogi" } }));
    expect(fake.class.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { category: null } });
  });

  it("refuses as stale when the category has been changed again since", async () => {
    fake.class.findFirst.mockResolvedValue({ id: "c1", tenantId: "t1", category: "competition", isActive: true, sourceImportJobId: null });
    await expect(
      applyUndo(tx, row({ fields: ["category"], before: { category: "gi" }, after: { category: "nogi" } })),
    ).rejects.toBeInstanceOf(UndoStale);
    expect(fake.class.update).not.toHaveBeenCalled();
  });
});
