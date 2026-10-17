/**
 * T6c (Sean note 7, "optionality for any type of class"): the class category,
 * defined once.
 *
 * `Class.category` is a nullable lowercase key. NULL = uncategorised, which is
 * every class that existed before the column (no backfill: a category is never
 * inferred from a class name). The database refuses any other value through
 * `Class_category_check` (migration 20261017035912_class_category), and the
 * create and edit schemas refuse it first with a 400.
 *
 * Widening this list needs a NEW migration that drops and re-adds the CHECK
 * (the pattern of 20260923220000_billing_cycle_weekly); an applied migration
 * is never edited. tests/unit/class-category.test.ts fails if this tuple and
 * the CHECK in the latest category migration drift apart.
 */
import { z } from "zod";

export const CLASS_CATEGORIES = [
  "fundamentals",
  "gi",
  "nogi",
  "kids",
  "competition",
  "open_mat",
  "private",
  "other",
] as const;

export type ClassCategory = (typeof CLASS_CATEGORIES)[number];

/** What the owner, the member and the kiosk read. British English. */
export const CLASS_CATEGORY_LABELS: Record<ClassCategory, string> = {
  fundamentals: "Fundamentals",
  gi: "Gi",
  nogi: "No-Gi",
  kids: "Kids",
  competition: "Competition",
  open_mat: "Open mat",
  private: "Private",
  other: "Other",
};

export function isClassCategory(value: unknown): value is ClassCategory {
  return typeof value === "string" && (CLASS_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The label for a stored key, or null when the class is uncategorised. A key
 * this build does not know (a newer build widened the list) shows nothing
 * rather than a raw key.
 */
export function classCategoryLabel(value: string | null | undefined): string | null {
  return isClassCategory(value) ? CLASS_CATEGORY_LABELS[value] : null;
}

/**
 * The category tag a timetable, schedule or kiosk row shows, or null when
 * there is nothing to show. A Kids-category class that is also flagged as a
 * kids class already carries the "Kids" tag, so it is not said twice.
 */
export function classCategoryTag(cls: { category?: string | null; isKids?: boolean | null }): string | null {
  const label = classCategoryLabel(cls.category);
  if (!label) return null;
  if (cls.category === "kids" && cls.isKids) return null;
  return label;
}

/**
 * Create and edit: one of the keys, or null to clear. Omitted on PATCH means
 * unchanged. Anything else is a 400 and nothing is written.
 */
export const classCategorySchema = z.enum(CLASS_CATEGORIES).nullable();
