// Mat names: what counts as the same name, the order mats and typed places
// are listed in, and the places a club has already typed on its classes
// (plan §4.8, §5.4).

import { describe, expect, it } from "vitest";
import { LOCATION_ERRORS, MAT_LIMIT, MAT_NAME_MAX, checkLocationName, cleanMatName, compareMatNames, matNameKey, placeSuggestions } from "@/lib/mats";

describe("cleanMatName / matNameKey", () => {
  it("trims and single-spaces a name, keeping its capitals", () => {
    expect(cleanMatName("  Mat   1 ")).toBe("Mat 1");
    expect(cleanMatName("Competition\tMat\n Upstairs")).toBe("Competition Mat Upstairs");
    expect(cleanMatName("   ")).toBe("");
  });

  it("the key ignores capitals and spacing, so 'Mat 1', 'mat  1 ' and 'MAT 1' are one mat", () => {
    expect(matNameKey("Mat 1")).toBe("mat 1");
    expect(matNameKey("mat  1 ")).toBe("mat 1");
    expect(matNameKey("MAT 1")).toBe("mat 1");
    expect(matNameKey("Mat 10")).not.toBe(matNameKey("Mat 1"));
  });

  it("removes invisible format characters, so a name of nothing but them is blank and cannot be saved", () => {
    // Zero-width space, zero-width joiner, zero-width non-joiner, word joiner, byte order mark.
    expect(cleanMatName("​‍‌⁠﻿")).toBe("");
    expect(cleanMatName(" ​ ")).toBe("");
    expect(cleanMatName("Mat​ 1")).toBe("Mat 1");
    expect(matNameKey("Mat‍ 1")).toBe(matNameKey("Mat 1"));
    expect(checkLocationName("​​", true)).toEqual({ ok: false, error: LOCATION_ERRORS.empty });
    expect(checkLocationName("Cage​", true)).toEqual({ ok: true, name: "Cage" });
  });

  it("treats a composed and a decomposed accent as the same name", () => {
    expect(matNameKey("Café")).toBe(matNameKey("Café"));
  });

  it("the limits are 24 characters and 12 mats", () => {
    expect(MAT_NAME_MAX).toBe(24);
    expect(MAT_LIMIT).toBe(12);
    expect("Competition Mat Upstairs").toHaveLength(24);
  });
});

describe("compareMatNames", () => {
  it("is number-aware: Mat 2 before Mat 10", () => {
    expect(["Mat 10", "Mat 2", "Mat 1"].sort(compareMatNames)).toEqual(["Mat 1", "Mat 2", "Mat 10"]);
  });
  it("ignores capitals and is stable for equal names", () => {
    expect(["mat 2", "Cage", "Mat 1"].sort(compareMatNames)).toEqual(["Cage", "Mat 1", "mat 2"]);
    expect(compareMatNames("Mat 1", "Mat 1")).toBe(0);
  });
});

describe("placeSuggestions", () => {
  const at = (location: string | null, n = 1) => Array.from({ length: n }, () => ({ location }));

  it("lists each distinct place once, by its commonest spelling, in number-aware order, with its class count", () => {
    const out = placeSuggestions([...at("Mat 2", 3), ...at("mat 1"), ...at("Mat 1", 2), ...at("MAT  1 "), ...at("Mat 10")], []);
    expect(out.suggestions).toEqual([
      { name: "Mat 1", key: "mat 1", classCount: 4, tooLong: false, matId: null },
      { name: "Mat 2", key: "mat 2", classCount: 3, tooLong: false, matId: null },
      { name: "Mat 10", key: "mat 10", classCount: 1, tooLong: false, matId: null },
    ]);
    expect(out.noPlaceCount).toBe(0);
  });

  it("counts classes with no place, or a blank one, apart", () => {
    const out = placeSuggestions([...at(null, 2), ...at("   "), ...at("Cage")], []);
    expect(out.suggestions.map((s) => s.name)).toEqual(["Cage"]);
    expect(out.noPlaceCount).toBe(3);
  });

  it("marks a place of more than 24 characters as too long for a mat name", () => {
    const out = placeSuggestions([...at("Competition Mat Upstairs"), ...at("The big hall behind reception")], []);
    expect(out.suggestions.map((s) => [s.name, s.tooLong])).toEqual([["Competition Mat Upstairs", false], ["The big hall behind reception", true]]);
  });

  it("says which mat already has that name", () => {
    const out = placeSuggestions([...at("mat 1", 2), ...at("Cage")], [{ id: "m1", nameKey: "mat 1" }]);
    expect(out.suggestions).toEqual([
      { name: "Cage", key: "cage", classCount: 1, tooLong: false, matId: null },
      { name: "mat 1", key: "mat 1", classCount: 2, tooLong: false, matId: "m1" },
    ]);
  });

  it("settles a tie between spellings the same way every time", () => {
    const a = placeSuggestions([...at("mat 1"), ...at("Mat 1")], []);
    const b = placeSuggestions([...at("Mat 1"), ...at("mat 1")], []);
    expect(a.suggestions[0].name).toBe(b.suggestions[0].name);
  });

  it("between equally common spellings, prefers the one that reads like a name: Mat 1, then mat 1, then MAT 1", () => {
    for (const order of [["MAT 1", "mat 1", "Mat 1"], ["mat 1", "MAT 1", "Mat 1"], ["Mat 1", "MAT 1", "mat 1"]]) {
      expect(placeSuggestions(order.flatMap((s) => at(s)), []).suggestions[0].name).toBe("Mat 1");
    }
    expect(placeSuggestions([...at("MAT 1"), ...at("mat 1")], []).suggestions[0].name).toBe("mat 1");
    // A commoner spelling still wins whatever its capitals.
    expect(placeSuggestions([...at("MAT 1", 2), ...at("Mat 1")], []).suggestions[0].name).toBe("MAT 1");
  });

  it("has nothing to offer a club with no classes", () => {
    expect(placeSuggestions([], [])).toEqual({ suggestions: [], noPlaceCount: 0 });
  });
});
