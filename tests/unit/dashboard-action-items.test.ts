import { describe, it, expect } from "vitest";
import { buildActionItems, daysUntilBirthday, type ActionItemsInput } from "@/lib/dashboard-action-items";

const NOW = new Date("2026-06-29T12:00:00Z");

function input(partial: Partial<ActionItemsInput>): ActionItemsInput {
  return {
    now: NOW,
    overdue: [],
    recentFailed: [],
    missingWaiver: [],
    atRisk: [],
    birthdayCandidates: [],
    ...partial,
  };
}

describe("buildActionItems — money", () => {
  it("turns a failed payment into a named, dated item", () => {
    const items = buildActionItems(input({
      recentFailed: [{ memberId: "m1", memberName: "Jane Smith", amountPence: 4000, createdAt: new Date("2026-06-26T12:00:00Z") }],
    }));
    expect(items[0]).toMatchObject({
      kind: "money",
      memberName: "Jane Smith",
      detail: "£40.00 payment failed 3 days ago",
      href: "/dashboard/members/m1?tab=payments",
    });
  });

  it("falls back to 'Payment overdue' for an overdue member with no failed row", () => {
    const items = buildActionItems(input({ overdue: [{ id: "m2", name: "Tom" }] }));
    expect(items[0]).toMatchObject({ kind: "money", memberName: "Tom", detail: "Payment overdue" });
  });

  it("dedupes a member who is both failed AND overdue (failed wins, appears once)", () => {
    const items = buildActionItems(input({
      recentFailed: [{ memberId: "m1", memberName: "Jane", amountPence: 4000, createdAt: NOW }],
      overdue: [{ id: "m1", name: "Jane" }],
    }));
    expect(items.filter((i) => i.memberId === "m1")).toHaveLength(1);
    expect(items[0].detail).toContain("failed");
  });
});

describe("buildActionItems — birthdays", () => {
  it("includes a birthday today and computes the age", () => {
    // Born 2018-06-29 → turns 8 today (now = 2026-06-29).
    const items = buildActionItems(input({
      birthdayCandidates: [{ id: "k1", name: "Mia", dateOfBirth: new Date("2018-06-29T00:00:00Z") }],
    }));
    const bday = items.find((i) => i.kind === "moment");
    expect(bday).toMatchObject({ memberName: "Mia", detail: "Birthday today — turning 8" });
  });

  it("includes a birthday within 7 days and excludes one beyond", () => {
    const items = buildActionItems(input({
      birthdayCandidates: [
        { id: "a", name: "Soon", dateOfBirth: new Date("2000-07-03T00:00:00Z") }, // +4 days
        { id: "b", name: "Later", dateOfBirth: new Date("2000-08-15T00:00:00Z") }, // way out
      ],
    }));
    const names = items.filter((i) => i.kind === "moment").map((i) => i.memberName);
    expect(names).toContain("Soon");
    expect(names).not.toContain("Later");
  });
});

describe("buildActionItems — ordering & cap", () => {
  it("orders money → retention → admin → moment", () => {
    const items = buildActionItems(input({
      overdue: [{ id: "money", name: "Money" }],
      atRisk: [{ id: "ret", name: "Ret" }],
      missingWaiver: [{ id: "adm", name: "Adm" }],
      birthdayCandidates: [{ id: "mom", name: "Mom", dateOfBirth: NOW }],
    }));
    expect(items.map((i) => i.kind)).toEqual(["money", "retention", "admin", "moment"]);
  });

  it("caps at 15 items", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, name: `M${i}` }));
    expect(buildActionItems(input({ atRisk: many })).length).toBe(15);
  });
});

describe("daysUntilBirthday", () => {
  it("is 0 on the birthday and wraps to next year after it passes", () => {
    expect(daysUntilBirthday(NOW, new Date("1990-06-29"))).toBe(0);
    expect(daysUntilBirthday(NOW, new Date("1990-06-28"))).toBe(364); // already passed → next year
  });
});
