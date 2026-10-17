/**
 * T1 (17 Oct 2026): every server population (a Prisma `where` fragment) has a
 * client twin (a predicate over the row the Members page holds). If the two
 * ever disagree, the Members page and Reports show different numbers for the
 * same word — the defect Sean reported ("ensure this is accurate").
 *
 * This walks every status × accountType × paymentStatus combination the
 * database CHECK constraints allow (prisma/schema.prisma: status, accountType,
 * paymentStatus) through each twin and through a small evaluator of the
 * fragment's own operators (equals, not, in), and requires them to agree.
 * The real-database proof of the same agreement is
 * tests/integration/member-population-parity.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  ACTIVE_MEMBER,
  CAN_TRAIN_MEMBER,
  CURRENT_MEMBER,
  GUARDIAN_ACCOUNT,
  LEFT_MEMBER,
  ON_HOLD,
  POPULATION_COPY,
  TRAINING_MEMBER,
  isActiveMember,
  isCanTrainMember,
  isCurrentMember,
  isGuardianAccount,
  isLeftMember,
  isOnHold,
  isTrainingMember,
  type PopulationRow,
} from "@/lib/member-population";

const STATUSES = ["active", "inactive", "cancelled", "taster"] as const;
const ACCOUNT_TYPES = ["adult", "junior", "kids", "parent"] as const;
const PAYMENT_STATUSES = ["paid", "overdue", "paused", "free", "pending", "cancelled"] as const;

type Row = { status: string; accountType: string; paymentStatus: string };

const ROWS: Row[] = STATUSES.flatMap((status) =>
  ACCOUNT_TYPES.flatMap((accountType) => PAYMENT_STATUSES.map((paymentStatus) => ({ status, accountType, paymentStatus }))),
);

/** Evaluates a flat Prisma scalar filter: a literal (equals), { not }, or { in }. */
function matches(where: Record<string, unknown>, row: Row): boolean {
  return Object.entries(where).every(([field, cond]) => {
    const value = (row as Record<string, string>)[field];
    if (typeof cond === "string") return value === cond;
    const c = cond as { not?: string; in?: readonly string[] };
    if ("not" in c) return value !== c.not;
    if ("in" in c) return (c.in ?? []).includes(value);
    throw new Error(`unsupported operator on ${field}`);
  });
}

const PAIRS: [string, Record<string, unknown>, (m: PopulationRow) => boolean][] = [
  ["TRAINING_MEMBER", TRAINING_MEMBER, isTrainingMember],
  ["ACTIVE_MEMBER", ACTIVE_MEMBER, isActiveMember],
  ["CURRENT_MEMBER", CURRENT_MEMBER, isCurrentMember],
  ["CAN_TRAIN_MEMBER", CAN_TRAIN_MEMBER, isCanTrainMember],
  ["LEFT_MEMBER", LEFT_MEMBER, isLeftMember],
  ["GUARDIAN_ACCOUNT", GUARDIAN_ACCOUNT, isGuardianAccount],
  ["ON_HOLD", ON_HOLD, isOnHold],
];

describe("member populations — server fragment and client twin agree on every row", () => {
  it(`covers all ${ROWS.length} status × accountType × paymentStatus combinations`, () => {
    expect(ROWS).toHaveLength(4 * 4 * 6);
  });

  for (const [name, where, twin] of PAIRS) {
    it(`${name} and its twin agree`, () => {
      const disagreements = ROWS.filter((r) => matches(where, r) !== twin(r));
      expect(disagreements).toEqual([]);
    });
  }

  it("every population except GUARDIAN_ACCOUNT and ON_HOLD is a subset of TRAINING_MEMBER", () => {
    for (const twin of [isActiveMember, isCurrentMember, isCanTrainMember, isLeftMember]) {
      for (const r of ROWS) if (twin(r)) expect(isTrainingMember(r)).toBe(true);
    }
  });

  it("active is inside current, which is active + inactive + taster; left is the rest of training", () => {
    for (const r of ROWS) {
      if (isActiveMember(r)) expect(isCurrentMember(r)).toBe(true);
      if (isTrainingMember(r)) expect(isCurrentMember(r) !== isLeftMember(r)).toBe(true);
    }
  });

  it("a hold never changes the status population: an active member on hold is still an active member", () => {
    expect(isActiveMember({ status: "active", accountType: "adult", paymentStatus: "paused" })).toBe(true);
    expect(isOnHold({ paymentStatus: "paused" })).toBe(true);
  });

  it("a row without accountType reads as the column default (adult) — a training member", () => {
    expect(isTrainingMember({})).toBe(true);
    expect(isActiveMember({ status: "active" })).toBe(true);
    expect(isGuardianAccount({})).toBe(false);
  });

  it("the synthetic club in the T1 acceptance: Active 3, Current 5, Left 2, guardians 2, On hold 1", () => {
    const club: Row[] = [
      { status: "active", accountType: "adult", paymentStatus: "paid" },
      { status: "active", accountType: "adult", paymentStatus: "paid" },
      { status: "active", accountType: "kids", paymentStatus: "paused" },
      { status: "inactive", accountType: "adult", paymentStatus: "paid" },
      { status: "taster", accountType: "adult", paymentStatus: "pending" },
      { status: "cancelled", accountType: "adult", paymentStatus: "cancelled" },
      { status: "cancelled", accountType: "junior", paymentStatus: "cancelled" },
      { status: "active", accountType: "parent", paymentStatus: "paid" },
      { status: "active", accountType: "parent", paymentStatus: "paid" },
    ];
    expect(club.filter(isActiveMember)).toHaveLength(3);
    expect(club.filter(isCurrentMember)).toHaveLength(5);
    expect(club.filter(isLeftMember)).toHaveLength(2);
    expect(club.filter(isGuardianAccount)).toHaveLength(2);
    expect(club.filter((m) => isCurrentMember(m) && isOnHold(m))).toHaveLength(1);
  });

  it("every population has a label and both halves of its scope sentence", () => {
    for (const [key, copy] of Object.entries(POPULATION_COPY)) {
      expect(copy.label, key).toMatch(/^[A-Z][a-z]/);
      expect(copy.includes.length, key).toBeGreaterThan(0);
      expect(copy.excludes.length, key).toBeGreaterThan(0);
    }
    expect(POPULATION_COPY.active.label).toBe("Active members");
    expect(POPULATION_COPY.current.excludes).toMatch(/cancelled members and guardians/);
    expect(POPULATION_COPY.current.includes).toMatch(/inactive members and tasters/);
  });
});
