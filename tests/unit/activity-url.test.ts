// The Activity page keeps its filters in the address bar and nowhere else.
// These are the pure pieces: reading them, writing a change without losing a
// concurrent one, naming a selection, and the request each state produces.
import { describe, it, expect } from "vitest";
import { ACTIVITY_TYPES, defaultTypeKeys, visibleTypeKeys } from "@/lib/activity-types";
import { NO_FILTERS, apiQuery, dayHeading, hasSubjectFilter, matchingView, readFilters, shiftDay, typesLabel, typesValue, writeFilters } from "@/lib/activity-url";

const params = (query: string) => new URLSearchParams(query);

describe("readFilters", () => {
  it("reads each filter, and treats blank as absent", () => {
    expect(readFilters(params("types=money&memberId=m1&classId=c1&paymentId=p1&tierId=t1&userId=u1&day=2026-11-04"))).toEqual({ types: "money", memberId: "m1", classId: "c1", paymentId: "p1", tierId: "t1", userId: "u1", day: "2026-11-04" });
    expect(readFilters(params(""))).toEqual(NO_FILTERS);
    expect(readFilters(params("memberId=&day=%20"))).toEqual(NO_FILTERS);
  });

  it("a day that is not a date and an id that is not an id are not filters (the server ignores them too)", () => {
    for (const day of ["abc", "2026-13-01", "2026-02-30", "2026-11-4", "20261104"]) expect(readFilters(params(`day=${day}`)).day, day).toBeNull();
    expect(readFilters(params("day=2028-02-29")).day).toBe("2028-02-29");
    expect(readFilters(params(`memberId=${encodeURIComponent("a b")}&classId=${encodeURIComponent("x/y")}&userId=${"u".repeat(101)}`))).toEqual(NO_FILTERS);
    // Seeded ids are readable, not cuids.
    expect(readFilters(params("classId=inst-gi-2026-11-04-19:00")).classId).toBe("inst-gi-2026-11-04-19:00");
  });
});

describe("writeFilters", () => {
  it("sets, clears and leaves alone", () => {
    expect(writeFilters("?types=money&memberId=m1", { memberId: null })).toBe("?types=money");
    expect(writeFilters("?types=money", { memberId: "m2", day: "2026-11-03" })).toBe("?types=money&memberId=m2&day=2026-11-03");
    expect(writeFilters("?memberId=m1", { memberId: null })).toBe("");
    expect(writeFilters("", {})).toBe("");
  });

  it("keeps parameters the page does not own", () => {
    expect(writeFilters("?denied=1&types=all", { types: null })).toBe("?denied=1");
  });

  it("two changes made one after the other both land, because each starts from the address as it is", () => {
    const first = writeFilters("", { memberId: "m1" });
    const second = writeFilters(first, { userId: "u1" });
    expect(second).toBe("?memberId=m1&userId=u1");
  });

  it("resetting clears every filter at once", () => {
    expect(writeFilters("?types=money&memberId=m1&classId=c1&paymentId=p1&tierId=t1&userId=u1&day=2026-11-04", NO_FILTERS)).toBe("");
  });
});

describe("naming a selection", () => {
  const all = ACTIVITY_TYPES.map((t) => t.key);

  it("a selection equal to a view is that view", () => {
    expect(matchingView(defaultTypeKeys("owner"), "owner")).toBe("club");
    expect(matchingView(visibleTypeKeys("owner"), "owner")).toBe("all");
    expect(matchingView(["checkin", "checkin_exception", "checkin_removed"], "owner")).toBe("attendance");
    expect(matchingView(["checkin_removed", "checkin", "checkin_exception"], "owner")).toBe("attendance");
    expect(matchingView(["checkin", "refund"], "owner")).toBeNull();
    expect(matchingView([], "owner")).toBeNull();
  });

  it("the control says the view's name, one type's name, or how many", () => {
    expect(typesLabel(defaultTypeKeys("owner"), "owner")).toBe("Club activity");
    expect(typesLabel(all, "owner")).toBe("Everything");
    expect(typesLabel(visibleTypeKeys("manager"), "manager")).toBe("Everything");
    expect(typesLabel(["refund"], "owner")).toBe("Refund");
    expect(typesLabel(["refund", "checkin"], "owner")).toBe("2 activity types");
  });

  it("the address carries a view key when the selection is one, else the list in taxonomy order", () => {
    expect(typesValue(defaultTypeKeys("owner"), "owner")).toBe("club");
    expect(typesValue(all, "owner")).toBe("all");
    expect(typesValue(["refund", "checkin"], "owner")).toBe("checkin,refund");
    // Types the role may not see never reach the address.
    expect(typesValue(["checkin", "staff"], "manager")).toBe("checkin");
  });

  it("knows when the page is narrowed to a subject", () => {
    expect(hasSubjectFilter(NO_FILTERS)).toBe(false);
    expect(hasSubjectFilter({ ...NO_FILTERS, types: "money", day: "2026-11-04" })).toBe(false);
    for (const key of ["memberId", "classId", "paymentId", "tierId", "userId"] as const) expect(hasSubjectFilter({ ...NO_FILTERS, [key]: "x" }), key).toBe(true);
  });
});

describe("days", () => {
  it("moves a day key by calendar days, across months and years", () => {
    expect(shiftDay("2026-11-01", -1)).toBe("2026-10-31");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDay("2026-03-29", 1)).toBe("2026-03-30");
  });

  it("heads a day against the club's today, not the reader's clock", () => {
    expect(dayHeading("2026-11-05", "2026-11-05")).toBe("Today");
    expect(dayHeading("2026-11-04", "2026-11-05")).toBe("Yesterday");
    expect(dayHeading("2026-11-03", "2026-11-05")).toBe("Tuesday 3 November 2026");
    expect(dayHeading("2026-10-31", "2026-11-01")).toBe("Yesterday");
  });
});

describe("apiQuery", () => {
  it("always sends the types explicitly, and only the filters that are set", () => {
    expect(apiQuery(NO_FILTERS, { types: "club" })).toBe("/api/activity?types=club");
    expect(apiQuery({ ...NO_FILTERS, memberId: "m1", day: "2026-11-04" }, { types: "checkin,refund", cursor: "a1", take: 50 })).toBe("/api/activity?types=checkin%2Crefund&memberId=m1&day=2026-11-04&take=50&cursor=a1");
  });

  it("an embedded timeline asks for everything, a few rows, and no undo decisions", () => {
    expect(apiQuery({ ...NO_FILTERS, memberId: "m1" }, { types: "all", take: 20, embed: true })).toBe("/api/activity?types=all&memberId=m1&take=20&embed=1");
  });
});
