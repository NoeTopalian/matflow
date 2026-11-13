/**
 * Round 7 (13 Nov 2026): what changed between the preview the owner approved and the commit.
 *
 * The commit re-classifies every person at write time with the preview's own rules (lib/importers/import-match), so
 * a change in MatFlow between the two (a member added by hand, another import, a staff login on an address) changes
 * the outcome, correctly. This names each count that no longer matches the preview, so the owner is told why
 * "will import 10" became "imported 9" instead of being left with two numbers. Pure; counts only, no person.
 */

/** The preview's counts (ImportJob.dryRunSummary), as the preview route stored them. */
type PreviewCounts = Partial<Record<"willImport" | "sameAsMatFlow" | "toReviewDiffers" | "toReviewUncertain" | "repeatedInFile" | "staffLoginRefused" | "childrenWithoutParent", unknown>>;

/** The commit's counts for the same outcomes. */
export type CommitCounts = {
  created: number;
  duplicates: number;
  conflicts: number;
  ambiguous: number;
  repeatedInFile: number;
  staffLoginRefused: number;
  childrenWithoutParent: number;
};

export type SincePreview = { changed: boolean; counts: Array<{ what: string; preview: number; now: number }> };

const PAIRS: Array<[keyof PreviewCounts, keyof CommitCounts, string]> = [
  ["willImport", "created", "new people"],
  ["sameAsMatFlow", "duplicates", "already in MatFlow with the same details"],
  ["toReviewDiffers", "conflicts", "to review: details differ"],
  ["toReviewUncertain", "ambiguous", "to review: uncertain match"],
  ["repeatedInFile", "repeatedInFile", "rows repeating an earlier row of the file"],
  ["staffLoginRefused", "staffLoginRefused", "refused: a staff login holds the address"],
  ["childrenWithoutParent", "childrenWithoutParent", "children whose parent was not imported"],
];

/** Null when there is no stored preview to compare with (a commit that was never previewed). */
export function sincePreview(stored: unknown, now: CommitCounts): SincePreview | null {
  if (!stored || typeof stored !== "object") return null;
  const p = stored as PreviewCounts;
  const counts: SincePreview["counts"] = [];
  for (const [pk, ck, what] of PAIRS) {
    const before = p[pk];
    if (typeof before !== "number") continue;
    if (before !== now[ck]) counts.push({ what, preview: before, now: now[ck] });
  }
  return { changed: counts.length > 0, counts };
}
