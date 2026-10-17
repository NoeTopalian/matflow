// T7c (Sean note 5): the class allowance helpers — the reader rule, the
// wording every screen shows, and the write-side normalisation both
// membership routes share. Pure; no database.
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  allowanceColumns,
  allowanceUsageText,
  classLimitLongText,
  classLimitSortValue,
  classLimitText,
  refineAllowance,
  tierAllowance,
  weeksText,
  CLASS_LIMIT_WEEK_OPTIONS,
  PAIR_MESSAGE,
  LEGACY_MIX_MESSAGE,
  classLimitSchema,
  classLimitWeeksSchema,
} from "@/lib/class-allowance";

describe("tierAllowance (the reader rule)", () => {
  it("is Unlimited when nothing is set", () => {
    expect(tierAllowance({ classLimit: null, classLimitWeeks: null, maxClassesPerWeek: null })).toBeNull();
    expect(tierAllowance({})).toBeNull();
    expect(tierAllowance(null)).toBeNull();
  });

  it("reads an existing maxClassesPerWeek as N per 1 week (no data migration)", () => {
    expect(tierAllowance({ maxClassesPerWeek: 3, classLimit: null, classLimitWeeks: null })).toEqual({ limit: 3, weeks: 1 });
  });

  it("reads a multi-week allowance from the pair", () => {
    expect(tierAllowance({ maxClassesPerWeek: null, classLimit: 4, classLimitWeeks: 4 })).toEqual({ limit: 4, weeks: 4 });
  });

  it("reads a weekly allowance through its mirror", () => {
    expect(tierAllowance({ maxClassesPerWeek: 5, classLimit: 5, classLimitWeeks: 1 })).toEqual({ limit: 5, weeks: 1 });
  });

  it("lets a value the previous build wrote during a rollback win", () => {
    // The new build saved 4 every 4 weeks (maxClassesPerWeek NULL); the old
    // build then set "5/wk". The old build's edit is the last word.
    expect(tierAllowance({ maxClassesPerWeek: 5, classLimit: 4, classLimitWeeks: 4 })).toEqual({ limit: 5, weeks: 1 });
    // The new build saved 3 every week; the old build changed it to 6/wk.
    expect(tierAllowance({ maxClassesPerWeek: 6, classLimit: 3, classLimitWeeks: 1 })).toEqual({ limit: 6, weeks: 1 });
  });

  it("does not resurrect a weekly allowance the previous build cleared", () => {
    expect(tierAllowance({ maxClassesPerWeek: null, classLimit: 3, classLimitWeeks: 1 })).toBeNull();
  });
});

describe("wording", () => {
  it("classLimitText reads as the plan table shows it", () => {
    expect(classLimitText(null)).toBe("Unlimited");
    expect(classLimitText({ limit: 4, weeks: 4 })).toBe("4 every 4 weeks");
    expect(classLimitText({ limit: 3, weeks: 1 })).toBe("3 every week");
    expect(classLimitText({ limit: 1, weeks: 2 })).toBe("1 every 2 weeks");
  });

  it("classLimitLongText carries the noun", () => {
    expect(classLimitLongText(null)).toBe("Unlimited classes");
    expect(classLimitLongText({ limit: 4, weeks: 4 })).toBe("4 classes every 4 weeks");
    expect(classLimitLongText({ limit: 1, weeks: 1 })).toBe("1 class every week");
  });

  it("weeksText and the editor options", () => {
    expect(weeksText(1)).toBe("1 week");
    expect(weeksText(8)).toBe("8 weeks");
    expect([...CLASS_LIMIT_WEEK_OPTIONS]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("allowanceUsageText is the member portal line", () => {
    expect(allowanceUsageText(2, { limit: 4, weeks: 4 })).toBe("2 of 4 classes used in the last 4 weeks");
    expect(allowanceUsageText(4, { limit: 4, weeks: 4 })).toBe("4 of 4 classes used in the last 4 weeks");
    expect(allowanceUsageText(0, { limit: 1, weeks: 1 })).toBe("0 of 1 class used in the last week");
    expect(allowanceUsageText(-1, { limit: 3, weeks: 2 })).toBe("0 of 3 classes used in the last 2 weeks");
    expect(allowanceUsageText(3, null)).toBeNull();
  });

  it("sorts Unlimited as the largest and spans by average per week", () => {
    expect(classLimitSortValue(null)).toBe(Number.MAX_SAFE_INTEGER);
    expect(classLimitSortValue({ limit: 4, weeks: 4 })).toBe(1);
    expect(classLimitSortValue({ limit: 2, weeks: 1 })).toBeGreaterThan(classLimitSortValue({ limit: 4, weeks: 4 }));
  });
});

describe("write side", () => {
  const schema = z
    .object({
      maxClassesPerWeek: z.number().int().min(1).max(30).optional().nullable(),
      classLimit: classLimitSchema.nullable().optional(),
      classLimitWeeks: classLimitWeeksSchema.nullable().optional(),
    })
    .superRefine(refineAllowance);

  const fieldErrors = (input: unknown) => {
    const r = schema.safeParse(input);
    return r.success ? null : r.error.flatten().fieldErrors;
  };

  it("accepts the pair, the null pair, the legacy field and an untouched body", () => {
    expect(fieldErrors({ classLimit: 4, classLimitWeeks: 4 })).toBeNull();
    expect(fieldErrors({ classLimit: null, classLimitWeeks: null })).toBeNull();
    expect(fieldErrors({ maxClassesPerWeek: 3 })).toBeNull();
    expect(fieldErrors({ maxClassesPerWeek: null })).toBeNull();
    expect(fieldErrors({})).toBeNull();
    expect(fieldErrors({ classLimit: 60, classLimitWeeks: 8 })).toBeNull();
    expect(fieldErrors({ classLimit: 1, classLimitWeeks: 1 })).toBeNull();
  });

  it("refuses half a pair", () => {
    expect(fieldErrors({ classLimit: 4 })?.classLimitWeeks).toEqual([PAIR_MESSAGE]);
    expect(fieldErrors({ classLimitWeeks: 4 })?.classLimitWeeks).toEqual([PAIR_MESSAGE]);
    expect(fieldErrors({ classLimit: 4, classLimitWeeks: null })?.classLimitWeeks).toEqual([PAIR_MESSAGE]);
    expect(fieldErrors({ classLimit: null, classLimitWeeks: 4 })?.classLimitWeeks).toEqual([PAIR_MESSAGE]);
  });

  it("refuses the legacy field mixed with the pair", () => {
    expect(fieldErrors({ maxClassesPerWeek: 3, classLimit: 4, classLimitWeeks: 4 })?.classLimit).toEqual([LEGACY_MIX_MESSAGE]);
  });

  it("refuses out-of-range and fractional values", () => {
    expect(fieldErrors({ classLimit: 0, classLimitWeeks: 4 })?.classLimit).toBeTruthy();
    expect(fieldErrors({ classLimit: 61, classLimitWeeks: 4 })?.classLimit).toBeTruthy();
    expect(fieldErrors({ classLimit: 2.5, classLimitWeeks: 4 })?.classLimit).toBeTruthy();
    expect(fieldErrors({ classLimit: 4, classLimitWeeks: 0 })?.classLimitWeeks).toBeTruthy();
    expect(fieldErrors({ classLimit: 4, classLimitWeeks: 9 })?.classLimitWeeks).toBeTruthy();
  });

  it("allowanceColumns writes the three columns in step", () => {
    expect(allowanceColumns({})).toBeNull();
    expect(allowanceColumns({ classLimit: 4, classLimitWeeks: 4 })).toEqual({ classLimit: 4, classLimitWeeks: 4, maxClassesPerWeek: null });
    expect(allowanceColumns({ classLimit: 3, classLimitWeeks: 1 })).toEqual({ classLimit: 3, classLimitWeeks: 1, maxClassesPerWeek: 3 });
    expect(allowanceColumns({ classLimit: null, classLimitWeeks: null })).toEqual({ classLimit: null, classLimitWeeks: null, maxClassesPerWeek: null });
    expect(allowanceColumns({ maxClassesPerWeek: 3 })).toEqual({ classLimit: 3, classLimitWeeks: 1, maxClassesPerWeek: 3 });
    expect(allowanceColumns({ maxClassesPerWeek: null })).toEqual({ classLimit: null, classLimitWeeks: null, maxClassesPerWeek: null });
  });

  it("what is written reads back as what was set", () => {
    for (const [limit, weeks] of [[4, 4], [3, 1], [60, 8], [1, 2]] as const) {
      expect(tierAllowance(allowanceColumns({ classLimit: limit, classLimitWeeks: weeks }))).toEqual({ limit, weeks });
    }
    expect(tierAllowance(allowanceColumns({ classLimit: null, classLimitWeeks: null }))).toBeNull();
    expect(tierAllowance(allowanceColumns({ maxClassesPerWeek: 5 }))).toEqual({ limit: 5, weeks: 1 });
  });
});
