/**
 * lib/attribution.ts — the per-step conversion FUNNEL (Reports UX cycle,
 * 2026-09-23).
 *
 * Every trial a coach ran ends up in exactly one of three buckets (converted,
 * lost, still deciding) and every conversion in one of two (still active,
 * churned). These tests pin the partition, the bucket PRIORITY (a member who
 * joined then cancelled is a churned conversion, never a lost trial), the
 * min-N guard on both rates, and that the club-wide funnel re-derives its
 * rates from the sums rather than averaging per-coach percentages.
 *
 * Red-on-revert: reverting the funnel extension makes `lost`/`retained`/
 * `buildFunnel` undefined and every case below fails.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildStaffConversionRows,
  buildFunnel,
  computeRate,
  computeConversionRate,
  MIN_TRIALS_FOR_RATE,
} from "@/lib/attribution";

const STAFF = [
  { id: "coach-a", name: "Marco Silva" },
  { id: "coach-b", name: "Priya Nair" },
  { id: "coach-c", name: "Never Ran One" },
];

// Coach A ran 6 trials: 3 converted (2 still active, 1 churned), 2 lost, 1 deciding.
// Coach B ran 2 trials: 1 converted (active), 1 deciding — under min-N.
const TRIAL_MEMBERS = [
  { id: "m1", trialRunById: "coach-a", status: "active" },     // converted, retained
  { id: "m2", trialRunById: "coach-a", status: "active" },     // converted, retained
  { id: "m3", trialRunById: "coach-a", status: "cancelled" },  // converted then churned (ALSO has a taster→cancelled? no — see priority test)
  { id: "m4", trialRunById: "coach-a", status: "cancelled" },  // lost
  { id: "m5", trialRunById: "coach-a", status: "cancelled" },  // lost
  { id: "m6", trialRunById: "coach-a", status: "taster" },     // deciding
  { id: "m7", trialRunById: "coach-b", status: "active" },     // converted, retained
  { id: "m8", trialRunById: "coach-b", status: "taster" },     // deciding
  { id: "m9", trialRunById: null, status: "active" },          // no coach — not in anyone's funnel
];
const CONVERTED = new Set(["m1", "m2", "m3", "m7", "m9"]);
const LOST = new Set(["m4", "m5"]);

describe("buildStaffConversionRows — the per-coach funnel partition", () => {
  const rows = buildStaffConversionRows({
    staff: STAFF,
    trialMembers: TRIAL_MEMBERS,
    signUpMembers: [],
    convertedMemberIds: CONVERTED,
    lostMemberIds: LOST,
  });
  const a = rows.find((r) => r.userId === "coach-a")!;
  const b = rows.find((r) => r.userId === "coach-b")!;

  it("partitions every trial into converted + lost + undecided", () => {
    expect(a.trialsRun).toBe(6);
    expect(a.conversions).toBe(3);
    expect(a.lost).toBe(2);
    expect(a.undecided).toBe(1);
    expect(a.conversions + a.lost + a.undecided).toBe(a.trialsRun);
  });

  it("partitions every conversion into retained + churned by CURRENT status", () => {
    expect(a.retained).toBe(2);
    expect(a.churned).toBe(1);
    expect(a.retained + a.churned).toBe(a.conversions);
  });

  it("rates: conversion 3/6 = 50.0%, retention 2/3 = 66.7%", () => {
    expect(a.conversionRate).toBe(50);
    expect(a.retentionRate).toBe(66.7);
  });

  it("min-N guard applies to BOTH rates: 2 trials / 1 conversion → null, never 50% or 100%", () => {
    expect(b.trialsRun).toBe(2);
    expect(b.conversionRate).toBeNull();
    expect(b.retentionRate).toBeNull();
    expect(b.retained).toBe(1);
  });

  it("a coach with no activity is not a zero-row; an unattributed trial is in nobody's funnel", () => {
    expect(rows.map((r) => r.userId)).toEqual(["coach-a", "coach-b"]);
    expect(rows.reduce((s, r) => s + r.trialsRun, 0)).toBe(8); // m9 excluded
  });

  it("PRIORITY: a member in both the converted and lost sets is a churned conversion, not a lost trial", () => {
    // m3 joined (→active) and later cancelled; a naive writer might also have
    // recorded taster→cancelled for them. Converted must win.
    const rows2 = buildStaffConversionRows({
      staff: STAFF,
      trialMembers: TRIAL_MEMBERS,
      signUpMembers: [],
      convertedMemberIds: CONVERTED,
      lostMemberIds: new Set([...LOST, "m3"]),
    });
    const a2 = rows2.find((r) => r.userId === "coach-a")!;
    expect(a2.conversions).toBe(3);
    expect(a2.churned).toBe(1);
    expect(a2.lost).toBe(2);
    expect(a2.conversions + a2.lost + a2.undecided).toBe(a2.trialsRun);
  });

  it("stays backwards-compatible: no status / no lost set → nothing lost, nothing retained, all conversions churned-unknown", () => {
    const legacy = buildStaffConversionRows({
      staff: STAFF,
      trialMembers: TRIAL_MEMBERS.map(({ id, trialRunById }) => ({ id, trialRunById })),
      signUpMembers: [],
      convertedMemberIds: CONVERTED,
    });
    const la = legacy.find((r) => r.userId === "coach-a")!;
    expect(la.lost).toBe(0);
    expect(la.undecided).toBe(3);
    expect(la.conversionRate).toBe(50);
  });
});

describe("buildStaffConversionRows — the two rules lane 4 found missing (2026-09-23)", () => {
  const staff = [{ id: "coach-a", name: "Marco Silva" }];

  it("a taster retired by setting them INACTIVE (not cancelled) is lost, not an open decision", () => {
    const rows = buildStaffConversionRows({
      staff,
      trialMembers: [
        { id: "t1", trialRunById: "coach-a", status: "inactive" },  // no event in the lost set — status alone says it
        { id: "t2", trialRunById: "coach-a", status: "cancelled" }, // same, via cancelled
        { id: "t3", trialRunById: "coach-a", status: "taster" },    // genuinely no decision
      ],
      signUpMembers: [],
      convertedMemberIds: new Set(),
      lostMemberIds: new Set(),
    });
    const a = rows[0];
    expect(a.trialsRun).toBe(3);
    expect(a.lost).toBe(2);
    expect(a.undecided).toBe(1);
  });

  it("an imported member with a coach attached is NOT a trial (guard 3 applied both ways)", () => {
    const rows = buildStaffConversionRows({
      staff,
      trialMembers: [
        { id: "i1", trialRunById: "coach-a", status: "active" }, // imported, back-filled coach — must not count
        { id: "m1", trialRunById: "coach-a", status: "active" },
        { id: "m2", trialRunById: "coach-a", status: "active" },
        { id: "m3", trialRunById: "coach-a", status: "taster" },
      ],
      signUpMembers: [],
      convertedMemberIds: new Set(["m1", "m2", "i1"]),
      importedMemberIds: new Set(["i1"]),
    });
    const a = rows[0];
    expect(a.trialsRun).toBe(3);      // i1 excluded
    expect(a.conversions).toBe(2);
    expect(a.conversionRate).toBe(66.7); // 2/3, not 2/4 or 3/4
  });
});

describe("buildFunnel — the club-wide funnel", () => {
  const rows = buildStaffConversionRows({
    staff: STAFF,
    trialMembers: TRIAL_MEMBERS,
    signUpMembers: [],
    convertedMemberIds: CONVERTED,
    lostMemberIds: LOST,
  });
  const overall = buildFunnel(rows);

  it("sums the steps and keeps both invariants", () => {
    expect(overall).toMatchObject({ trials: 8, converted: 4, retained: 3, churned: 1, lost: 2, undecided: 2 });
    expect(overall.converted + overall.lost + overall.undecided).toBe(overall.trials);
    expect(overall.retained + overall.churned).toBe(overall.converted);
  });

  it("re-derives rates from the SUMS (4/8 = 50%, 3/4 = 75%), not by averaging coach percentages", () => {
    // Averaging would be (50 + null)/… — meaningless. Sums: 50.0 and 75.0.
    expect(overall.conversionRate).toBe(50);
    expect(overall.retentionRate).toBe(75);
  });

  it("an empty club yields an all-zero funnel with null rates (rendered as EmptyState, never zero bars)", () => {
    expect(buildFunnel([])).toEqual({
      trials: 0, converted: 0, retained: 0, lost: 0, undecided: 0, churned: 0,
      conversionRate: null, retentionRate: null,
    });
  });
});

describe("computeRate / computeConversionRate", () => {
  it("null below MIN_TRIALS_FOR_RATE, one-decimal percentage at or above it", () => {
    expect(computeRate(MIN_TRIALS_FOR_RATE - 1, 1)).toBeNull();
    expect(computeRate(3, 1)).toBe(33.3);
    expect(computeConversionRate(3, 3)).toBe(100);
  });
});

describe("ConversionFunnel + Select — tokens only, no hex literals (UI-RULES §2/§11)", () => {
  // A source scan, like tests/unit/sticky-bars-are-opaque.test.ts: the defect
  // ("someone painted a funnel bar #22c55e") is visible in the file whether or
  // not any spec renders it. Runtime tenant colours arrive via CSS vars.
  for (const rel of ["components/dashboard/ConversionFunnel.tsx", "components/ui/select.tsx"]) {
    it(`${rel} has no 6-digit hex literal`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src.match(/#[0-9a-fA-F]{6}\b/g) ?? []).toEqual([]);
    });
  }
});
