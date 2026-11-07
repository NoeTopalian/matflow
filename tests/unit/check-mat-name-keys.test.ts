// The read-only check script (scripts/check-mat-name-keys.mjs) keys names exactly as lib/mats.ts does, and lists
// a mat only when its stored key differs from that. Invisible characters are built from code points here, so no
// editor can turn them into something else.
import { describe, expect, it } from "vitest";
import { cleanMatName, matNameKey } from "@/lib/mats";
import { matNameKey as scriptKey, mismatches, shown } from "../../scripts/check-mat-name-keys.mjs";

const ZWJ = String.fromCodePoint(0x200d);
const ZWNJ = String.fromCodePoint(0x200c);
const SOFT_HYPHEN = String.fromCodePoint(0xad);
const ZWSP = String.fromCodePoint(0x200b);

describe("matNameKey: what makes two names the same mat", () => {
  it("drops default-ignorable characters from the key, so a joiner alone is blank and a soft hyphen does not split a name", () => {
    expect(matNameKey(ZWJ)).toBe("");
    expect(matNameKey(` ${ZWNJ} ${ZWJ} `)).toBe("");
    expect(matNameKey(`Mat${SOFT_HYPHEN}1`)).toBe("mat1");
    expect(matNameKey(`Ma${ZWJ}t 1`)).toBe(matNameKey("Mat 1"));
  });

  it("keeps the joiners in the name that is shown", () => {
    const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    expect(cleanMatName(`Kids ${family}`)).toBe(`Kids ${family}`);
    expect(cleanMatName(`ab${ZWNJ}cd`)).toBe(`ab${ZWNJ}cd`);
  });
});

describe("scripts/check-mat-name-keys.mjs", () => {
  const samples = ["Mat 1", "  MAT   1 ", `Mat${SOFT_HYPHEN}1`, `${ZWSP}Cage`, `Ma${ZWJ}t`, ZWJ, "Café", "Competition Mat Upstairs"];

  it("keys every name exactly as lib/mats.ts does", () => {
    for (const s of samples) expect(scriptKey(s), shown(s)).toBe(matNameKey(s));
  });

  it("lists only mats whose stored key differs from the key their name gives now", () => {
    const rows = [
      { tenantId: "t1", id: "m1", name: "Mat 1", nameKey: "mat 1" },
      // Saved before 7 Nov 2026: the soft hyphen was part of the key then.
      { tenantId: "t1", id: "m2", name: `Mat${SOFT_HYPHEN}2`, nameKey: `mat${SOFT_HYPHEN}2` },
    ];
    expect(mismatches(rows)).toEqual([{ ...rows[1], expected: "mat2" }]);
  });

  it("prints invisible characters as code points", () => {
    expect(shown(`Mat${SOFT_HYPHEN}2`)).toBe("Mat" + String.fromCharCode(92) + "u{ad}2");
  });
});
