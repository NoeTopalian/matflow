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
/** Longest typed place (Class.location) a class may keep when no mat is added. */
export const PLACE_NAME_MAX = 100;
/** Most mats a club can have. */
export const MAT_LIMIT = 12;

/** First key of the per-club advisory lock ("MATS"). The second is hashtext(tenantId). */
export const MATS_LOCK_NS = 0x4d415453;

/**
 * Invisible formatting characters that carry nothing in a name: zero-width
 * space, the direction marks, embeddings, overrides and isolates, word joiner
 * and byte order mark. Zero-width joiner and non-joiner are kept: emoji and
 * several scripts need them.
 */
const INVISIBLE_FORMATTING = /[\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/**
 * A name as it is stored and shown: invisible formatting characters removed,
 * so a name of nothing but those is blank; trimmed; runs of white space made
 * one space.
 */
export function cleanMatName(raw: string): string {
  return raw.normalize("NFC").replace(INVISIBLE_FORMATTING, "").replace(/\s+/g, " ").trim();
}

/**
 * What makes two names the same mat: the clean name with the default-ignorable
 * code points removed as well (the joiners and soft hyphen a name may keep for
 * display, so "Mat\u00AD1" keys as "mat1" and a joiner alone is blank; not the
 * variation selectors and tags, which make different symbols), lower-cased. Names saved before 7 Nov 2026 were keyed without that step:
 * scripts/check-mat-name-keys.mjs lists any whose stored key differs.
 */
export function matNameKey(raw: string): string {
  return dropIgnorables(cleanMatName(raw)).replace(/\s+/g, " ").trim().toLowerCase();
}

const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
/**
 * Default-ignorable code points stay in the key when they make a different
 * symbol: variation selectors (U+FE00 to U+FE0F, U+E0100 to U+E01EF) and tag
 * characters (U+E0000 to U+E007F), so the England, Scotland and Wales flags
 * are three names, not one.
 */
const keptInKey = (cp: number) => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef) || (cp >= 0xe0000 && cp <= 0xe007f);
function dropIgnorables(s: string): string {
  let out = "";
  for (const ch of s) if (!DEFAULT_IGNORABLE.test(ch) || keptInKey(ch.codePointAt(0) ?? 0)) out += ch;
  return out;
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
 * any row lock (docs/design/LOCK-ORDER-2026-10-24.md). A class create or
 * edit takes it only when the request names a mat, by id (`matId`) or by
 * name (`matName`, the class form's Location).
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
 * Which of a place's spellings names its mat: the commonest. Between equally common ones, the one that reads most
 * like a name — mixed case ("Mat 1") before all lower ("mat 1") before all capitals ("MAT 1") — then the one that
 * sorts first, so the answer never flips with the order the rows come back in. The suggestion list and adopting
 * both use this, so the sheet names a mat exactly as adopting will create it. `null` when there is no spelling.
 */
export function commonestSpelling(spellings: ReadonlyMap<string, number>): string | null {
  const casing = (s: string) => (s !== s.toLowerCase() && s !== s.toUpperCase() ? 0 : s === s.toLowerCase() ? 1 : 2);
  const [first] = [...spellings].sort((a, b) => b[1] - a[1] || casing(a[0]) - casing(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return first ? first[0] : null;
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
    const key = matNameKey(name);
    if (!key) {
      noPlaceCount += 1;
      continue;
    }
    const seen = spellings.get(key) ?? new Map<string, number>();
    seen.set(name, (seen.get(name) ?? 0) + 1);
    spellings.set(key, seen);
  }
  const suggestions: PlaceSuggestion[] = [];
  for (const [key, seen] of spellings) {
    const name = commonestSpelling(seen) ?? key;
    let classCount = 0;
    for (const n of seen.values()) classCount += n;
    suggestions.push({ name, key, classCount, tooLong: name.length > MAT_NAME_MAX, matId: matByKey.get(key) ?? null });
  }
  suggestions.sort((a, b) => compareMatNames(a.name, b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { suggestions, noPlaceCount };
}

/**
 * The class form's Location (Noe, 7 Nov 2026). Every refusal carries
 * `reason: "location"` so the form shows it beside the field, with what was
 * typed kept.
 */
export const LOCATION_ERRORS = {
  empty: "Give the new location a name.",
  tooLong: `A location name can be up to ${MAT_NAME_MAX} characters. Use a shorter name.`,
  placeTooLong: `A place can be up to ${PLACE_NAME_MAX} characters. Use a shorter name.`,
  limit: `You already have ${MAT_LIMIT} locations, the most a club can have, so this one can't be added. Remove a location under Mats, or choose one from the list.`,
  both: "Choose a location from the list or add a new one, not both.",
} as const;

/**
 * A Location name sent by the class form (`matName`), checked before any
 * transaction: the clean name, or the sentence that refuses it. Too long is a
 * refusal only for a caller that may add mats; anyone else keeps it as a
 * typed place (lib/mats-store.ts `matForLocation`).
 */
export function checkLocationName(raw: string, mayAddMat: boolean): { ok: true; name: string } | { ok: false; error: string } {
  const name = cleanMatName(raw);
  // Blank by its key: a name of nothing but invisible characters is no name.
  if (!matNameKey(name)) return { ok: false, error: LOCATION_ERRORS.empty };
  if (mayAddMat && name.length > MAT_NAME_MAX) return { ok: false, error: LOCATION_ERRORS.tooLong };
  if (name.length > PLACE_NAME_MAX) return { ok: false, error: LOCATION_ERRORS.placeTooLong };
  return { ok: true, name };
}

/**
 * The club's classes on no mat that type a place, imported history excepted
 * (what a new mat may take: lib/mats-store.ts adoptPlaces and matForLocation),
 * LOCKED (FOR NO KEY UPDATE, the strength the undo batch takes: it still
 * waits for an edit's FOR UPDATE and for any UPDATE, but not for the FOR KEY
 * SHARE a bulk ClassInstance insert takes on its classes, so it cannot deadlock
 * with one) in id order, so an edit that clears or changes one of them cannot
 * be overwritten by the attach that follows. Call under the club's mats lock
 * (LOCK-ORDER: MATS, then these Class rows in id order). Read as they are now:
 * the caller matches the names on this read, never an older one.
 * Raw for the row lock; tenantId is a bind parameter.
 */
export function lockTypedClasses(tx: Prisma.TransactionClient, tenantId: string): Promise<{ id: string; location: string | null; deletedAt: Date | null }[]> {
  return tx.$queryRaw<{ id: string; location: string | null; deletedAt: Date | null }[]>`SELECT "id", "location", "deletedAt" FROM "Class" WHERE "tenantId" = ${tenantId} AND "matId" IS NULL AND "sourceImportJobId" IS NULL AND "location" IS NOT NULL ORDER BY "id" FOR NO KEY UPDATE`;
}
