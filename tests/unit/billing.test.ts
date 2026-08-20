import { describe, it, expect } from "vitest";
import { buildOutstandingRows, totalOutstandingPence, type OutstandingInput } from "@/lib/billing";

const NOW = new Date("2026-06-29T12:00:00Z");

function input(partial: Partial<OutstandingInput>): OutstandingInput {
  return { now: NOW, overdueMembers: [], latestFailed: new Map(), ...partial };
}

describe("buildOutstandingRows", () => {
  it("attaches the latest failed amount + age to an overdue member", () => {
    const rows = buildOutstandingRows(input({
      overdueMembers: [{ id: "m1", name: "Jane", membershipType: "Adult" }],
      latestFailed: new Map([["m1", { amountPence: 4000, createdAt: new Date("2026-06-26T12:00:00Z"), failureReason: "card_declined" }]]),
    }));
    expect(rows[0]).toMatchObject({
      memberId: "m1", memberName: "Jane", amountPence: 4000, reason: "card_declined", daysOverdue: 3,
    });
  });

  it("leaves amount/days null for an overdue member with no failed row", () => {
    const rows = buildOutstandingRows(input({
      overdueMembers: [{ id: "m2", name: "Tom", membershipType: null }],
    }));
    expect(rows[0]).toMatchObject({ memberId: "m2", amountPence: null, daysOverdue: null, lastAttempt: null });
  });

  it("ranks most-overdue first, known-age above bare overdue, then by amount", () => {
    const rows = buildOutstandingRows(input({
      overdueMembers: [
        { id: "bare", name: "Bare", membershipType: null },
        { id: "small5d", name: "Small", membershipType: null },
        { id: "big5d", name: "Big", membershipType: null },
        { id: "old10d", name: "Old", membershipType: null },
      ],
      latestFailed: new Map([
        ["small5d", { amountPence: 1000, createdAt: new Date("2026-06-24T12:00:00Z"), failureReason: null }],
        ["big5d", { amountPence: 9000, createdAt: new Date("2026-06-24T12:00:00Z"), failureReason: null }],
        ["old10d", { amountPence: 2000, createdAt: new Date("2026-06-19T12:00:00Z"), failureReason: null }],
      ]),
    }));
    expect(rows.map((r) => r.memberId)).toEqual(["old10d", "big5d", "small5d", "bare"]);
  });

  it("totalOutstandingPence sums only known failed amounts", () => {
    const rows = buildOutstandingRows(input({
      overdueMembers: [
        { id: "a", name: "A", membershipType: null },
        { id: "b", name: "B", membershipType: null },
      ],
      latestFailed: new Map([["a", { amountPence: 4000, createdAt: NOW, failureReason: null }]]),
    }));
    expect(totalOutstandingPence(rows)).toBe(4000);
  });
});
