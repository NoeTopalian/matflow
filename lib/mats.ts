/**
 * Mats: a club's training areas ("Mat 1", "Cage", "Upstairs").
 *
 * This file owns three things every mats writer shares:
 *  - what counts as the same name (`cleanMatName`, `matNameKey`) and the order
 *    names are listed in (`compareMatNames`);
 *  - the one lock per club that makes mats writes serial (`lockClubMats`);
 *  - the places a club has already typed on its classes (`placeSuggestions`),
 *    which is how mats are set up in one press.
 *
 * THE WRITE-THROUGH RULE, stated once: whenever a write leaves a class with a
 * non-null `matId`, the same transaction leaves `Class.location` equal to that
 * mat's current name. So every screen that prints a class's place (the
 * check-in rail, the kiosk, the dashboard calendar, the members' app) shows
 * the mat's name without knowing mats exist. It is kept on: class create and
 * class edit (app/api/classes), adopt and rename (app/api/mats), and Undo of
 * a class edit (lib/undo-registry.ts).
 *
 * The name helpers and `placeSuggestions` are pure and safe in client
 * components; `lockClubMats` needs a transaction.
 */

import type { Prisma } from "@prisma/client";

/** Longest mat name: it has to fit a column header. */
export const MAT_NAME_MAX = 24;
/** Most mats a club can have. */
export const MAT_LIMIT = 12;

/** First key of the per-club advisory lock ("MATS"). The second is hashtext(tenantId). */
export const MATS_LOCK_NS = 0x4d415453;

/** A name as it is stored and shown: trimmed, runs of white space made one space. */
export function cleanMatName(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** What makes two names the same mat: the clean name, lower-cased. */
export function matNameKey(raw: string): string {
  return cleanMatName(raw).toLowerCase();
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Number-aware name order, ignoring capitals: "Mat 2" before "Mat 10". */
export function compareMatNames(a: string, b: string): number {
  return collator.compare(a, b);
}

/**
 * Serialises every mats write of one club: the 12-mat cap, the next sort
 * position, reorder against add, two adopts at once, and a rename against a
 * class being saved onto that mat. Held until the transaction ends.
 *
 * ORDER: this is the FIRST statement of a transaction that takes it, before
 * any row lock (docs/security/LOCK-ORDER-2026-10-24.md). A class edit takes
 * it only when the request names a mat.
 *
 * The one raw statement mats need: the project keeps raw SQL out of
 * application code except reviewed locks of this shape (lib/login-email.ts);
 * both keys are bind parameters (tests/unit/sec-c-static-guards.test.ts).
 */
export async function lockClubMats(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MATS_LOCK_NS}::int4, hashtext(${tenantId}))`;
}

export interface PlaceSuggestion {
  /** The commonest spelling among the classes that typed it. */
  name: string;
  key: string;
  classCount: number;
  /** Over MAT_NAME_MAX characters: it cannot become a mat as typed. */
  tooLong: boolean;
  /** The club's mat of that name, when there already is one. */
  matId: string | null;
}

/**
 * The distinct places typed on the classes given (pass the club's classes
 * that are not on a mat), one line per place whatever its capitals and
 * spacing, in number-aware name order; and how many classes have no place.
 */
export function placeSuggestions(
  classes: readonly { location: string | null }[],
  mats: readonly { id: string; nameKey: string }[],
): { suggestions: PlaceSuggestion[]; noPlaceCount: number } {
  const matByKey = new Map(mats.map((m) => [m.nameKey, m.id]));
  const spellings = new Map<string, Map<string, number>>();
  let noPlaceCount = 0;
  for (const c of classes) {
    const name = cleanMatName(c.location ?? "");
    if (!name) {
      noPlaceCount += 1;
      continue;
    }
    const key = name.toLowerCase();
    const seen = spellings.get(key) ?? new Map<string, number>();
    seen.set(name, (seen.get(name) ?? 0) + 1);
    spellings.set(key, seen);
  }
  const suggestions: PlaceSuggestion[] = [];
  for (const [key, seen] of spellings) {
    // The commonest spelling; between equally common ones, the one that sorts first, so the answer never flips.
    const [name] = [...seen].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0];
    let classCount = 0;
    for (const n of seen.values()) classCount += n;
    suggestions.push({ name, key, classCount, tooLong: name.length > MAT_NAME_MAX, matId: matByKey.get(key) ?? null });
  }
  suggestions.sort((a, b) => compareMatNames(a.name, b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { suggestions, noPlaceCount };
}
