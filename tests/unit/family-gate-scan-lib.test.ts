/**
 * Extends tests/unit/guardianship-gate-scan.test.ts to the two parent-facing
 * readers that live OUTSIDE its roots (3 Oct 2026, specialist C audit):
 *  - lib/member-home.ts buildMemberChildren, which feeds GET /api/member/home
 *    (the member home page: child name, date of birth, belt, class count,
 *    next-7-day timetable, and the sign-in picker);
 *  - app/api/blob-image/route.ts, where a member may read a photo that
 *    belongs to "one of their children".
 * Both keyed on parentMemberId without CONFIRMED_GUARDIAN, so a SUGGESTED
 * parent (an imported shared-email adult who can sign in) saw the child.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const FILES = ["lib/member-home.ts", "app/api/blob-image/route.ts"];

describe("guardianship gate scan — lib and blob readers", () => {
  it("every where keyed on the signed-in parent carries CONFIRMED_GUARDIAN", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      const re = /where:\s*\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const block = m[0];
        if (!/parentMemberId(: memberId|: parentMemberId|,|\s*\})/.test(block)) continue;
        if (block.includes("CONFIRMED_GUARDIAN")) continue;
        offenders.push(`${file}: ${block.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
