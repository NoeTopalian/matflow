// T7c (Sean note 5): a membership plan's class allowance — the reader rule from
// the columns, the wording, and the write side both membership routes share.
// Product decision 20 Oct 2026: an explicit reset basis (week, month, every N
// weeks from a start date); Unlimited clears every column.
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  ALLOWANCE_FIELDS,
  CLASS_LIMIT_WEEK_OPTIONS,
  allowanceColumns,
  classLimitAnchorSchema,
  classLimitLongText,
  classLimitSchema,
  classLimitSortValue,
  classLimitText,
  classLimitWeeksSchema,
  LEGACY_MIX_MESSAGE,
  PAIR_MESSAGE,
  refineAllowance,
  tierAllowance,
  WEEKS_MESSAGE,
  type AllowanceInput,
} from "@/lib/class-allowance";

describe("tierAllowance (the reader rule)", () => {
  it("is Unlimited when nothing is set", () => {
    expect(tierAllowance(null)).toBeNull();
    expect(tierAllowance({})).toBeNull();
    expect(tierAllowance({ classLimit: null, classLimitBasis: null, classLimitWeeks: null, classLimitAnchor: null, maxClassesPerWeek: null })).toBeNull();
  });

  it("reads an existing maxClassesPerWeek as N each calendar week (no data migration, no rolling window)", () => {
    expect(tierAllowance({ maxClassesPerWeek: 3 })).toEqual({ limit: 3, basis: "week" });
  });

  it("reads each basis from its columns; the anchor comes as a Date from Prisma or a string from the API", () => {
    expect(tierAllowance({ classLimit: 3, classLimitBasis: "week", maxClassesPerWeek: 3 })).toEqual({ limit: 3, basis: "week" });
    expect(tierAllowance({ classLimit: 8, classLimitBasis: "month" })).toEqual({ limit: 8, basis: "month" });
    expect(tierAllowance({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: new Date("2026-10-20T00:00:00.000Z") })).toEqual({
      limit: 4, basis: "weeks", weeks: 4, anchor: "2026-10-20",
    });
    expect(tierAllowance({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-10-20" })).toEqual({
      limit: 4, basis: "weeks", weeks: 4, anchor: "2026-10-20",
    });
  });

  it("an every-N-weeks row with no weeks or no start date is Unlimited rather than a guess", () => {
    expect(tierAllowance({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: null, classLimitAnchor: "2026-10-20" })).toBeNull();
    expect(tierAllowance({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: null })).toBeNull();
  });

  it("the basis wins over a stale legacy mirror", () => {
    expect(tierAllowance({ classLimit: 8, classLimitBasis: "month", maxClassesPerWeek: 3 })).toEqual({ limit: 8, basis: "month" });
  });

  it("a limit with no basis and no legacy value (a pre-release rolling pair) is Unlimited", () => {
    expect(tierAllowance({ classLimit: 4, classLimitWeeks: 4 })).toBeNull();
  });
});

describe("wording", () => {
  it("classLimitText reads as the plan table shows it", () => {
    expect(classLimitText(null)).toBe("Unlimited");
    expect(classLimitText({ limit: 3, basis: "week" })).toBe("3 each week");
    expect(classLimitText({ limit: 8, basis: "month" })).toBe("8 each month");
    expect(classLimitText({ limit: 4, basis: "weeks", weeks: 4, anchor: "2026-10-20" })).toBe("4 every 4 weeks");
  });

  it("classLimitLongText carries the noun", () => {
    expect(classLimitLongText(null)).toBe("Unlimited classes");
    expect(classLimitLongText({ limit: 1, basis: "week" })).toBe("1 class each week");
    expect(classLimitLongText({ limit: 4, basis: "weeks", weeks: 4, anchor: "2026-10-20" })).toBe("4 classes every 4 weeks");
  });

  it("the editor's every-N-weeks options start at 2 (1 week is the weekly basis)", () => {
    expect([...CLASS_LIMIT_WEEK_OPTIONS]).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("sorts Unlimited as the largest and other bases by average per week", () => {
    const weekly = classLimitSortValue({ limit: 2, basis: "week" });
    const monthly = classLimitSortValue({ limit: 8, basis: "month" });
    const four = classLimitSortValue({ limit: 4, basis: "weeks", weeks: 4, anchor: "2026-10-20" });
    expect(four).toBeLessThan(monthly);
    expect(monthly).toBeLessThan(weekly);
    expect(classLimitSortValue(null)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("write side", () => {
  const body = z
    .object({
      classLimit: classLimitSchema.nullable().optional(),
      classLimitBasis: z.enum(["week", "month", "weeks"]).nullable().optional(),
      classLimitWeeks: classLimitWeeksSchema.nullable().optional(),
      classLimitAnchor: classLimitAnchorSchema.nullable().optional(),
      maxClassesPerWeek: z.number().int().min(1).max(30).nullable().optional(),
    })
    .superRefine(refineAllowance);
  const issues = (b: AllowanceInput) => body.safeParse(b).error?.issues.map((i) => i.message) ?? [];

  it("accepts each basis, the cleared set, the legacy field and an untouched body", () => {
    expect(issues({ classLimit: 3, classLimitBasis: "week" })).toEqual([]);
    expect(issues({ classLimit: 8, classLimitBasis: "month" })).toEqual([]);
    expect(issues({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-10-20" })).toEqual([]);
    expect(issues({ classLimit: null, classLimitBasis: null, classLimitWeeks: null, classLimitAnchor: null })).toEqual([]);
    expect(issues({ classLimit: null, classLimitBasis: null })).toEqual([]);
    expect(issues({ maxClassesPerWeek: 3 })).toEqual([]);
    expect(issues({})).toEqual([]);
  });

  it("refuses a limit without a basis, a basis without a limit, and weeks data on another basis", () => {
    expect(issues({ classLimit: 3 })).toEqual([PAIR_MESSAGE]);
    expect(issues({ classLimitBasis: "week" })).toEqual([PAIR_MESSAGE]);
    expect(issues({ classLimit: 3, classLimitBasis: null })).toEqual([PAIR_MESSAGE]);
    expect(issues({ classLimit: 3, classLimitBasis: "week", classLimitWeeks: 4 })).toEqual([PAIR_MESSAGE]);
  });

  it("refuses every-N-weeks without the weeks or the start date", () => {
    expect(issues({ classLimit: 4, classLimitBasis: "weeks", classLimitAnchor: "2026-10-20" })).toEqual([WEEKS_MESSAGE]);
    expect(issues({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4 })).toEqual([WEEKS_MESSAGE]);
  });

  it("refuses the legacy field mixed with the new fields", () => {
    expect(issues({ classLimit: 3, classLimitBasis: "week", maxClassesPerWeek: 3 })).toEqual([LEGACY_MIX_MESSAGE]);
  });

  it("refuses out-of-range, fractional and impossible values", () => {
    expect(issues({ classLimit: 0, classLimitBasis: "week" }).length).toBeGreaterThan(0);
    expect(issues({ classLimit: 61, classLimitBasis: "week" }).length).toBeGreaterThan(0);
    expect(issues({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 1, classLimitAnchor: "2026-10-20" }).length).toBeGreaterThan(0);
    expect(issues({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 9, classLimitAnchor: "2026-10-20" }).length).toBeGreaterThan(0);
    expect(issues({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-02-30" }).length).toBeGreaterThan(0);
    expect(issues({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "20/10/2026" }).length).toBeGreaterThan(0);
  });

  it("allowanceColumns writes every column in step", () => {
    expect(allowanceColumns({})).toBeNull();
    expect(allowanceColumns({ classLimit: 3, classLimitBasis: "week" })).toEqual({
      classLimit: 3, classLimitBasis: "week", classLimitWeeks: null, classLimitAnchor: null, maxClassesPerWeek: 3,
    });
    expect(allowanceColumns({ classLimit: 8, classLimitBasis: "month" })).toEqual({
      classLimit: 8, classLimitBasis: "month", classLimitWeeks: null, classLimitAnchor: null, maxClassesPerWeek: null,
    });
    expect(allowanceColumns({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-10-20" })).toEqual({
      classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: new Date("2026-10-20T00:00:00.000Z"), maxClassesPerWeek: null,
    });
    expect(allowanceColumns({ classLimit: null, classLimitBasis: null })).toEqual({
      classLimit: null, classLimitBasis: null, classLimitWeeks: null, classLimitAnchor: null, maxClassesPerWeek: null,
    });
    expect(allowanceColumns({ maxClassesPerWeek: 2 })).toEqual({
      classLimit: 2, classLimitBasis: "week", classLimitWeeks: null, classLimitAnchor: null, maxClassesPerWeek: 2,
    });
    expect(allowanceColumns({ maxClassesPerWeek: null })?.classLimit).toBeNull();
  });

  it("what is written reads back as what was set", () => {
    for (const input of [
      { classLimit: 3, classLimitBasis: "week" as const },
      { classLimit: 8, classLimitBasis: "month" as const },
      { classLimit: 4, classLimitBasis: "weeks" as const, classLimitWeeks: 4, classLimitAnchor: "2026-10-20" },
    ]) {
      const cols = allowanceColumns(input)!;
      const back = tierAllowance(cols)!;
      expect(back.limit).toBe(input.classLimit);
      expect(back.basis).toBe(input.classLimitBasis);
      if (back.basis === "weeks") expect([back.weeks, back.anchor]).toEqual([4, "2026-10-20"]);
    }
    expect(ALLOWANCE_FIELDS).toEqual(["maxClassesPerWeek", "classLimit", "classLimitBasis", "classLimitWeeks", "classLimitAnchor"]);
  });
});
