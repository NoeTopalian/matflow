// Noe, 18 Sep 2026: "put asterisks on the parts of the new class form that
// need to be filled; the rest is optional." The API requires name and
// duration; a schedule is optional but a class without one is invisible on
// the weekly timetable, so the form says so rather than starring it.
//
// Source-text assertions, comment-stripped: the drawer has no render
// harness and building one for three labels is disproportionate.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const src = readFileSync("components/dashboard/TimetableManager.tsx", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("ClassForm marks required fields", () => {
  it("stars Class Name and Duration, and says what the star means", () => {
    expect(src).toContain(">Class Name *<");
    expect(src).toContain(">Duration (mins) *<");
    expect(src).toMatch(/\*\s*required/i);
  });

  it("flags the two inputs as required for assistive tech", () => {
    expect(src).toMatch(/aria-label="Class Name"[\s\S]{0,200}aria-required/);
    expect(src).toMatch(/aria-label="Duration \(mins\)"[\s\S]{0,200}aria-required/);
  });

  it("tells the operator a class with no day will not appear on the timetable", () => {
    expect(src).toMatch(/no day[^<]*timetable/i);
  });
});
