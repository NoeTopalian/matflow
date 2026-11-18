// Round 7 (13 Nov 2026): the commit names each count that no longer matches the preview the owner approved.
import { describe, it, expect } from "vitest";
import { sincePreview } from "@/lib/importers/since-preview";

const now = { created: 1, duplicates: 0, conflicts: 1, ambiguous: 0, repeatedInFile: 0, staffLoginRefused: 0, childrenWithoutParent: 0 };
const base = { willImport: 1, sameAsMatFlow: 0, toReviewDiffers: 1, toReviewUncertain: 0, repeatedInFile: 0, staffLoginRefused: 0, childrenWithoutParent: 0 };

describe("sincePreview", () => {
  it("lists only the counts that changed, with both numbers", () => {
    expect(sincePreview({ ...base, willImport: 2, toReviewDiffers: 0 }, now)).toEqual({
      changed: true,
      counts: [
        { what: "New people", preview: 2, now: 1 },
        { what: "To review because their details differ", preview: 0, now: 1 },
      ],
    });
  });

  it("nothing changed: changed false, no counts", () => {
    expect(sincePreview(base, now)).toEqual({ changed: false, counts: [] });
  });

  it("no stored preview: null (nothing to compare with); a count the preview did not report is not compared", () => {
    expect(sincePreview(null, now)).toBeNull();
    expect(sincePreview({ willImport: 1 }, now)).toEqual({ changed: false, counts: [] });
  });

  it("a preview of a job that had already created people (an interrupted run): those count as the job's own creations, not as a change (review F2)", () => {
    // 25 created before the preview (counted there as "own", with the people already in MatFlow), 5 new: the commit created 30.
    const stored = { ...base, willImport: 5, sameAsMatFlow: 25, toReviewDiffers: 0, ownAtPreview: 25 };
    expect(sincePreview(stored, { ...now, created: 30, duplicates: 0, conflicts: 0 })).toEqual({ changed: false, counts: [] });
  });
});
