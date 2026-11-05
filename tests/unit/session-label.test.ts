// A session is named by its class, its DAY MARKER and its stored start time.
// `ClassInstance.date` is a UTC day marker and `startTime` is the club's wall
// clock as "HH:mm", so the label formats the marker in UTC and prints the time
// verbatim — it must read the same whatever zone the server or browser is in.
import { describe, it, expect } from "vitest";
import { sessionLabel } from "@/lib/session-label";
import { parseIdParam } from "@/lib/id-param";
import { formatDayLabel } from "@/lib/date";

describe("sessionLabel", () => {
  it("names the class, the marker's day and the stored time", () => {
    expect(sessionLabel("Advanced No-Gi", new Date("2026-11-04T00:00:00.000Z"), "19:00")).toBe("Advanced No-Gi · Wed 4 Nov, 19:00");
  });

  it("accepts the marker as an ISO string", () => {
    expect(sessionLabel("Little Squad", "2026-07-14T00:00:00.000Z", "16:50")).toBe("Little Squad · Tue 14 Jul, 16:50");
  });
});

describe("formatDayLabel time zone", () => {
  it("names the day in the zone it is given", () => {
    const noonUtc = new Date("2026-11-04T12:00:00.000Z");
    expect(formatDayLabel(noonUtc, "UTC")).toBe("Wed 4 Nov");
    // 01:00 the next day in Auckland (UTC+13 in November).
    expect(formatDayLabel(noonUtc, "Pacific/Auckland")).toBe("Thu 5 Nov");
  });
});

describe("parseIdParam", () => {
  it("passes a record id through", () => {
    expect(parseIdParam("cmh2x9k3a0001abcd1234efgh")).toBe("cmh2x9k3a0001abcd1234efgh");
  });

  it("refuses anything that is not one plain id", () => {
    expect(parseIdParam(undefined)).toBeNull();
    expect(parseIdParam("")).toBeNull();
    expect(parseIdParam("a b")).toBeNull();
    expect(parseIdParam("x';drop")).toBeNull();
    expect(parseIdParam(["a", "b"])).toBeNull();
    expect(parseIdParam("a".repeat(51))).toBeNull();
  });
});
