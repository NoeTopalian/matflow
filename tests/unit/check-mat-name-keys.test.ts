// The read-only check script (scripts/check-mat-name-keys.mjs) keys names exactly as lib/mats.ts does, and lists
// a mat only when its stored key differs from that. Invisible characters are built from code points here, so no
// editor can turn them into something else.
import { afterEach, describe, expect, it } from "vitest";
import { cleanMatName, matNameKey } from "@/lib/mats";
import { matNameKey as scriptKey, mismatches, shown, checkTarget } from "../../scripts/check-mat-name-keys.mjs";

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

  it("keeps tag characters in the key, so flag emoji stay three different names; text or emoji display of one symbol is one name", () => {
    const tagged = (letters: string) => String.fromCodePoint(0x1f3f4, ...[...letters].map((c) => 0xe0000 + c.charCodeAt(0)), 0xe007f);
    const flags = [tagged("gbeng"), tagged("gbsct"), tagged("gbwls")];
    const keys = flags.map((f) => matNameKey(`Flag ${f}`));
    expect(new Set(keys).size).toBe(3);
    for (const f of flags) expect(scriptKey(`Flag ${f}`)).toBe(matNameKey(`Flag ${f}`));
    // U+FE0F (emoji display) and U+FE0E (text display) only choose how a heart is drawn: one location.
    const heart = String.fromCodePoint(0x2764);
    const emojiHeart = String.fromCodePoint(0x2764, 0xfe0f);
    const textHeart = String.fromCodePoint(0x2764, 0xfe0e);
    expect(matNameKey(`${emojiHeart} Cage`)).toBe(matNameKey(`${heart} Cage`));
    expect(matNameKey(`${textHeart} Cage`)).toBe(matNameKey(`${heart} Cage`));
    expect(scriptKey(`${emojiHeart} Cage`)).toBe(matNameKey(`${emojiHeart} Cage`));
    // A glyph selector that is not about display stays: it picks a different form.
    expect(matNameKey(String.fromCodePoint(0x845b, 0xe0100))).not.toBe(matNameKey(String.fromCodePoint(0x845b)));
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

  describe("the target guard (scripts/readiness/db-target.mjs, as erase-closed-club uses it)", () => {
    // The real endpoint shapes: production and the test branch, pooled.
    const PROD = "postgresql://user:secret@ep-bold-wave-abt39t7x-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";
    const TEST = "postgresql://user:secret@ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";
    afterEach(() => {
      delete process.env.PGHOST;
    });

    it("refuses production with no flag", () => {
      expect(() => checkTarget(PROD, [])).toThrow(/^REFUSED: this is production/);
    });
    it("allows production with --expect-host ep-bold-wave, and returns the host, never the URL", () => {
      expect(checkTarget(PROD, ["--expect-host", "ep-bold-wave"])).toBe("ep-bold-wave-abt39t7x-pooler.eu-west-2.aws.neon.tech");
    });
    it("allows the test branch with no flag", () => {
      expect(checkTarget(TEST, [])).toBe("ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech");
    });
    it("refuses the test branch when --expect-host names production", () => {
      expect(() => checkTarget(TEST, ["--expect-host", "ep-bold-wave"])).toThrow(/^REFUSED: host does not contain ep-bold-wave/);
    });
    it("refuses a PGHOST in the environment, and a URL that routes elsewhere", () => {
      process.env.PGHOST = "ep-bold-wave-abt39t7x.eu-west-2.aws.neon.tech";
      expect(() => checkTarget(TEST, [])).toThrow(/^REFUSED: PGHOST is set/);
      delete process.env.PGHOST;
      // Naming production anywhere in the URL is refused before anything else; an override to another endpoint is
      // refused by the shared guard itself.
      expect(() => checkTarget(`${TEST}&options=endpoint%3Dep-bold-wave-abt39t7x`, [])).toThrow(/^REFUSED/);
      expect(() => checkTarget(`${TEST}&options=endpoint%3Dep-quiet-river-12345678`, [])).toThrow(/^REFUSED: connection string carries a options= parameter/);
      expect(() => checkTarget(`${TEST}&host=ep-bold-wave-abt39t7x.eu-west-2.aws.neon.tech`, [])).toThrow(/REFUSED/);
    });
  });

  it("prints invisible characters as code points", () => {
    expect(shown(`Mat${SOFT_HYPHEN}2`)).toBe("Mat" + String.fromCharCode(92) + "u{ad}2");
  });
});
