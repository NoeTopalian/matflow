// The published retention wording matches the code (Noe, 6 Nov 2026 14:08: "Yes, publish it with #72").
// Nothing of a club's is deleted automatically (docs/RULES.md §5d), so the legal pages must not promise a
// scheduled deletion, and they must say what is kept and what an erasure removes.
// Revised waiver and erasure lines approved by Noe the same evening ("Publish both").
// Wording and what it replaced: docs/legal/PROPOSED-RETENTION-WORDING-2026-11-06.md.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const text = (p: string) => readFileSync(join("app", "legal", p, "page.tsx"), "utf8").replace(/&apos;/g, "'").replace(/\s+/g, " ");

describe("legal retention wording", () => {
  const privacy = text("privacy");
  const terms = text("terms");

  it("no page promises a deletion the code does not make", () => {
    for (const stale of ["twelve months", "deleted by a scheduled job", "purged daily", "recoverable for 30 days", "retained for 30 days", "automated post-cancellation deletion"]) {
      expect(privacy, stale).not.toContain(stale);
      expect(terms, stale).not.toContain(stale);
    }
  });

  it("privacy §6 says what is kept, how a closed gym is erased, and what a member's erasure reaches", () => {
    expect(privacy).toContain("Nothing is deleted automatically.");
    expect(privacy).toContain("Expired sign-in links and password-reset links — kept, and unusable once expired");
    expect(privacy).toContain("Closed gyms — kept with sign-in disabled so the gym can reopen. When the gym asks in writing, we erase the gym");
    expect(privacy).toContain("Signed waivers — kept for as long as the gym uses MatFlow, and at least six years after the member leaves (UK limitation period), unless the gym asks us to erase that member");
    expect(privacy).toContain("Erasure requests — when a gym asks us to erase a member, we remove that member's details wherever we can identify them, including the Activity history, kept import files and photos");
    expect(privacy).not.toContain("everywhere we hold them");
  });

  it("terms §8 keeps the gym's data until it asks in writing", () => {
    expect(terms).toContain("On cancellation, your gym and its data are kept, with sign-in disabled");
    expect(terms).toContain("Nothing is deleted automatically: your data is kept until you ask in writing for it to be erased");
  });
});
