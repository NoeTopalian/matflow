// How a club's timetable splits classes at the same time, when nobody has
// chosen and when somebody has (plan §4.9, §5.3).

import { describe, expect, it } from "vitest";
import { effectiveLayout, isTimetableLayout, matsInUse } from "@/lib/timetable-layout";

describe("effectiveLayout", () => {
  it("is by time while no mat has a class on it, whatever is stored", () => {
    expect(effectiveLayout(null, 0)).toBe("time");
    expect(effectiveLayout("mat", 0)).toBe("time");
    expect(effectiveLayout("time", 0)).toBe("time");
  });

  it("with nothing stored follows the mats: one in use is by time, two or more by mat", () => {
    expect(effectiveLayout(null, 1)).toBe("time");
    expect(effectiveLayout(undefined, 1)).toBe("time");
    expect(effectiveLayout(null, 2)).toBe("mat");
    expect(effectiveLayout(null, 5)).toBe("mat");
  });

  it("a stored choice wins once a mat is in use", () => {
    expect(effectiveLayout("mat", 1)).toBe("mat");
    expect(effectiveLayout("time", 2)).toBe("time");
    expect(effectiveLayout("time", 12)).toBe("time");
  });

  it("treats a value it does not know as nothing stored", () => {
    expect(effectiveLayout("grid", 2)).toBe("mat");
    expect(effectiveLayout("", 1)).toBe("time");
  });
});

describe("isTimetableLayout", () => {
  it("admits exactly the two choices", () => {
    expect(isTimetableLayout("mat")).toBe(true);
    expect(isTimetableLayout("time")).toBe(true);
    for (const v of ["Mat", "", null, undefined, 1, {}]) expect(isTimetableLayout(v)).toBe(false);
  });
});

describe("matsInUse", () => {
  const mats = [{ id: "m1" }, { id: "m2" }, { id: "m3" }];
  it("counts the club's mats that have at least one of the classes given", () => {
    expect(matsInUse([], mats)).toBe(0);
    expect(matsInUse([{ matId: null }, { matId: "m1" }, { matId: "m1" }], mats)).toBe(1);
    expect(matsInUse([{ matId: "m3" }, { matId: "m1" }], mats)).toBe(2);
  });
  it("does not count a mat id that is not one of the club's mats", () => {
    expect(matsInUse([{ matId: "gone" }, { matId: "m2" }], mats)).toBe(1);
  });
});
