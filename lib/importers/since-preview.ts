/**
 * Round 7 (13 Nov 2026): what changed between the preview the owner approved and the commit.
 *
 * The commit re-classifies every person at write time with the preview's own rules (lib/importers/import-match), so
 * a change in MatFlow between the two (a member added by hand, another import, a staff login on an address) changes
 * the outcome, correctly. This names each count that no longer matches the preview, so the owner is told why
 * "will import 10" became "imported 9" instead of being left with two numbers. Pure; counts only, no person.
 *
 * Like for like (review F1, F2): staff-login refusals are counted per row on both sides; a preview of a job that had
 * already written people on an interrupted run counted them as "own" (with the people already in MatFlow), while the
 * commit counts every person this job created, so those are moved back to "new people" before comparing.
 */

/** The preview's counts (ImportJob.dryRunSummary), as the preview route stored them. */
type PreviewCounts = Partial<Record<"willImport" | "sameAsMatFlow" | "toReviewDiffers" | "toReviewUncertain" | "repeatedInFile" | "staffLoginRefused" | "childrenWithoutParent" | "ownAtPreview", unknown>>;

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

const PAIRS: Array<[Exclude<keyof PreviewCounts, "ownAtPreview">, keyof CommitCounts, string]> = [
  ["willImport", "created", "New people"],
  ["sameAsMatFlow", "duplicates", "Already in MatFlow with the same details"],
  ["toReviewDiffers", "conflicts", "To review because their details differ"],
  ["toReviewUncertain", "ambiguous", "To review because the match is uncertain"],
  ["repeatedInFile", "repeatedInFile", "Rows repeating an earlier row of the file"],
  ["staffLoginRefused", "staffLoginRefused", "Refused because a staff login uses the address"],
  ["childrenWithoutParent", "childrenWithoutParent", "Children whose parent was not imported"],
];

/** Null when there is no stored preview to compare with (a commit that was never previewed). */
export function sincePreview(stored: unknown, now: CommitCounts): SincePreview | null {
  if (!stored || typeof stored !== "object") return null;
  const p = stored as PreviewCounts;
  const own = typeof p.ownAtPreview === "number" ? p.ownAtPreview : 0;
  const counts: SincePreview["counts"] = [];
  for (const [pk, ck, what] of PAIRS) {
    const raw = p[pk];
    if (typeof raw !== "number") continue;
    const before = pk === "willImport" ? raw + own : pk === "sameAsMatFlow" ? raw - own : raw;
    if (before !== now[ck]) counts.push({ what, preview: before, now: now[ck] });
  }
  return { changed: counts.length > 0, counts };
}
