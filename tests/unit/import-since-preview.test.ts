// Round 7 (13 Nov 2026): the commit names each count that no longer matches the preview the owner approved.
import { describe, it, expect } from "vitest";
import { sincePreview } from "@/lib/importers/since-preview";

const now = { created: 1, duplicates: 0, conflicts: 1, ambiguous: 0, repeatedInFile: 0, staffLoginRefused: 0, childrenWithoutParent: 0 };

describe("sincePreview", () => {
  it("lists only the counts that changed, with both numbers", () => {
    const stored = { willImport: 2, sameAsMatFlow: 0, toReviewDiffers: 0, toReviewUncertain: 0, repeatedInFile: 0, staffLoginRefused: 0, childrenWithoutParent: 0 };
    expect(sincePreview(stored, now)).toEqual({
      changed: true,
      counts: [
        { what: "new people", preview: 2, now: 1 },
        { what: "to review: details differ", preview: 0, now: 1 },
      ],
    });
  });

  it("nothing changed: changed false, no counts", () => {
    const stored = { willImport: 1, sameAsMatFlow: 0, toReviewDiffers: 1, toReviewUncertain: 0, repeatedInFile: 0, staffLoginRefused: 0, childrenWithoutParent: 0 };
    expect(sincePreview(stored, now)).toEqual({ changed: false, counts: [] });
  });

  it("no stored preview: null (nothing to compare with); a count the preview did not report is not compared", () => {
    expect(sincePreview(null, now)).toBeNull();
    expect(sincePreview({ willImport: 1 }, now)).toEqual({ changed: false, counts: [] });
  });
});
