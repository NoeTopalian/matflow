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

// ── Club-managed categories (Release A, 11 Nov 2026) ─────────────────────────
//
// Each club has its own ClassCategory rows (prisma/schema.prisma); a class
// points at one through `categoryId`. The eight keys above survive as
// `ClassCategory.legacyKey` on each club's eight starting rows, in the legacy
// `Class.category` column the database keeps in step for builds from before
// this release (migration 20261111120000_class_categories), and in the
// `category` a browser holding an older page still sends (classCategorySchema).

/** Longest category name (Noe, 11 Nov 2026): the week grid's pill is narrow. */
export const CATEGORY_NAME_MAX = 32;

/**
 * Create and edit: the id of one of this club's categories, or null to clear.
 * Omitted on PATCH means unchanged. Whether it is this club's, and not
 * archived, is checked in the write (lib/class-category-store.ts).
 */
export const classCategoryIdSchema = z.string().min(1).max(64).nullable();

/** One of the club's categories, as the class form and the readers need it. */
export type ClassCategoryOption = {
  id: string;
  name: string;
  /** One of the eight old keys for a starting category; null for one the club made. */
  legacyKey: string | null;
  archived: boolean;
};

// Zero-width spaces, word joiner, soft hyphen and byte order mark: invisible,
// and would make two names that look the same count as different. (Joiner and
// non-joiner are kept, as in lib/mats.ts: emoji and some scripts need them.)
const INVISIBLE_FORMATTING = /[­​⁠﻿]/g;

/** The name as it is stored and shown: NFC, invisible formatting removed, spaces collapsed, trimmed. */
export function cleanCategoryName(raw: string): string {
  return raw.normalize("NFC").replace(INVISIBLE_FORMATTING, "").replace(/\s+/g, " ").trim();
}

/**
 * What counts as the same name: the cleaned name, compatibility-folded and
 * lower-cased. " beginners " and "Beginners" are the same category. The
 * database keeps one row per (club, key), archived rows included.
 */
export function categoryNameKey(raw: string): string {
  return cleanCategoryName(raw).normalize("NFKC").toLocaleLowerCase("en-GB");
}

/**
 * The tag a timetable, schedule or kiosk row shows, or null when there is
 * nothing to show. A kids class already carries the "Kids" tag, so a category
 * that reads "Kids" is not said twice; a renamed one ("Juniors") still shows.
 */
export function categoryTag(cls: { categoryName?: string | null; category?: string | null; isKids?: boolean | null }): string | null {
  const name = categoryNameOf(cls)?.trim();
  if (!name) return null;
  if (cls.isKids && categoryNameKey(name) === "kids") return null;
  return name;
}

/**
 * The category's name for a class row. A server from this release always
 * sends `categoryName` (null = uncategorised); one from before it sends only
 * the old key, so a page newer than its server still labels the class.
 */
export function categoryNameOf(cls: { categoryName?: string | null; category?: string | null }): string | null {
  return cls.categoryName !== undefined ? cls.categoryName : classCategoryLabel(cls.category);
}
