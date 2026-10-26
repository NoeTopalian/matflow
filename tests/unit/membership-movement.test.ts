// T8c (17 Oct 2026): movement and headcount replayed from status history
// (lib/membership-movement.ts) and the join-date fallback
// (lib/membership-report.ts joinDateHistory). Pure, so every rule is pinned
// here: replay order and ties, rollback reversals at one instant, members
// with no events, the club calendar, the owner's Q6 definitions, the
// estimated basis, reconciliation to the live tile, and the movement
// identity as a property over randomised streams.
import { describe, it, expect } from "vitest";
import {
  buildMembership,
  clubMonthWindows,
  compareEvents,
  estimatedCaption,
  headcountSeries,
  memberMovements,
  movements,
  stateAt,
  tallyChange,
  type MovementEvent,
} from "@/lib/membership-movement";
import { joinDateHistory } from "@/lib/membership-report";

const TZ = "Europe/London";
const NOW = new Date("2026-10-17T10:00:00.000Z");
const IMPORT_DAY = new Date("2026-10-03T11:39:57.000Z");

let seq = 0;
function ev(memberId: string, toStatus: string, at: string | Date, extra: Partial<MovementEvent> = {}): MovementEvent {
  const occurredAt = typeof at === "string" ? new Date(at) : at;
  seq += 1;
  return {
    id: `e${String(seq).padStart(5, "0")}`,
    memberId,
    toStatus,
    occurredAt,
    createdAt: extra.createdAt ?? occurredAt,
    reason: "staff_edit",
    ...extra,
  };
}

describe("stateAt", () => {
  it("is the toStatus of the latest event at or before the instant, and null before any", () => {
    const es = [ev("a", "active", "2026-01-10T00:00:00Z"), ev("a", "cancelled", "2026-03-05T00:00:00Z")];
    expect(stateAt(es, new Date("2026-01-09T23:59:59Z"))).toBeNull();
    expect(stateAt(es, new Date("2026-01-10T00:00:00Z"))).toBe("active");
    expect(stateAt(es, new Date("2026-03-04T00:00:00Z"))).toBe("active");
    expect(stateAt(es, new Date("2026-03-05T00:00:00Z"))).toBe("cancelled");
  });

  it("breaks a tie on occurredAt by createdAt, then by id, whatever the input order", () => {
    const at = "2026-05-01T09:00:00Z";
    const first = ev("a", "cancelled", at, { createdAt: new Date("2026-05-01T09:00:00Z") });
    const second = ev("a", "active", at, { createdAt: new Date("2026-05-01T09:00:01Z") });
    expect(stateAt([second, first], new Date(at))).toBe("active");
    expect(stateAt([first, second], new Date(at))).toBe("active");
    const x = { ...ev("a", "inactive", at), id: "b", createdAt: new Date(at) };
    const y = { ...ev("a", "taster", at), id: "a", createdAt: new Date(at) };
    expect(compareEvents(y, x)).toBeLessThan(0);
    expect(stateAt([x, y], new Date(at))).toBe("inactive");
  });
});

describe("headcountSeries", () => {
  it("counts members active at each instant, and a member with no events never", () => {
    const es = [
      ev("a", "active", "2026-01-10T00:00:00Z"),
      ev("b", "active", "2026-02-10T00:00:00Z"),
      ev("b", "cancelled", "2026-04-01T00:00:00Z"),
      ev("c", "inactive", "2026-01-01T00:00:00Z"),
    ];
    const at = ["2026-01-31T23:59:59Z", "2026-02-28T23:59:59Z", "2026-04-30T23:59:59Z"].map((s) => new Date(s));
    expect(headcountSeries(es, at)).toEqual([1, 2, 1]);
    expect(headcountSeries([], at)).toEqual([0, 0, 0]);
  });
});

describe("memberMovements: the owner's Q6 definitions", () => {
  it("first start is new, a start after leaving is rejoined, a cancellation is lost", () => {
    const moves = memberMovements([
      ev("a", "active", "2025-11-10T00:00:00Z"),
      ev("a", "cancelled", "2026-06-12T00:00:00Z"),
      ev("a", "active", "2026-09-03T00:00:00Z"),
    ]);
    expect(moves.map((m) => m.kind)).toEqual(["new", "lostCancelled", "rejoined"]);
  });

  it("a completed prepaid course from the ledger is a loss of its own kind; a staff 'inactive' is another change", () => {
    const course = memberMovements([
      ev("a", "active", "2026-01-16T00:00:00Z", { reason: "import", sourceAction: "import_backfill", estimated: true }),
      ev("a", "inactive", "2026-07-25T00:01:35Z", { reason: "import", sourceAction: "import_backfill", estimated: true }),
    ]);
    expect(course.map((m) => m.kind)).toEqual(["new", "lostCompleted"]);
    expect(course.every((m) => m.estimated)).toBe(true);
    const staff = memberMovements([ev("b", "active", "2026-01-16T00:00:00Z"), ev("b", "inactive", "2026-03-01T00:00:00Z")]);
    expect(staff.map((m) => m.kind)).toEqual(["new", "otherOut"]);
    const refresh = memberMovements([ev("c", "active", "2026-01-16T00:00:00Z"), ev("c", "inactive", "2026-10-10T00:00:00Z", { reason: "import", sourceAction: "import_refresh", fromStatus: "active" })]);
    expect(refresh.map((m) => m.kind)).toEqual(["new", "lostCompleted"]);
  });

  it("an import create with no earlier history is an opening balance, not a join; with history it moves nobody", () => {
    const opening = memberMovements([ev("a", "active", IMPORT_DAY, { reason: "import", fromStatus: null, sourceAction: "import_create" })]);
    expect(opening.map((m) => m.kind)).toEqual(["imported"]);
    const preT8d = memberMovements([ev("a", "active", IMPORT_DAY, { reason: "import", fromStatus: null, sourceAction: null })]);
    expect(preT8d.map((m) => m.kind)).toEqual(["imported"]);
    const withHistory = memberMovements([
      ev("b", "active", "2024-03-01T00:00:00Z", { reason: "import", sourceAction: "import_backfill", estimated: true }),
      ev("b", "active", IMPORT_DAY, { reason: "import", fromStatus: null, sourceAction: "import_create" }),
    ]);
    expect(withHistory.map((m) => m.kind)).toEqual(["new"]);
  });

  it("a refresh and the rollback that undoes it at the same occurredAt move nobody", () => {
    const at = "2026-10-12T00:00:00Z";
    const moves = memberMovements([
      ev("a", "active", "2026-02-01T00:00:00Z"),
      ev("a", "cancelled", at, { reason: "import", fromStatus: "active", sourceAction: "import_refresh", createdAt: new Date("2026-10-12T08:00:00Z") }),
      ev("a", "active", at, { reason: "import", fromStatus: "cancelled", sourceAction: "import_rollback", createdAt: new Date("2026-10-13T08:00:00Z") }),
    ]);
    expect(moves.map((m) => m.kind)).toEqual(["new"]);
  });

  it("a rollback dated later than its refresh is a correction, never a rejoin", () => {
    const moves = memberMovements([
      ev("a", "active", "2026-02-01T00:00:00Z"),
      ev("a", "cancelled", "2026-10-12T00:00:00Z", { reason: "import", fromStatus: "active", sourceAction: "import_refresh" }),
      ev("a", "active", "2026-10-14T00:00:00Z", { reason: "import", fromStatus: "cancelled", sourceAction: "import_rollback" }),
    ]);
    expect(moves.map((m) => m.kind)).toEqual(["new", "lostCancelled", "otherIn"]);
  });

  it("a member with no events has no movement", () => {
    expect(memberMovements([])).toEqual([]);
  });

  it("set inactive by hand, then active again: a pause and its reversal, never a rejoin", () => {
    const moves = memberMovements([
      ev("a", "active", "2026-01-10T00:00:00Z"),
      ev("a", "inactive", "2026-04-02T00:00:00Z", { fromStatus: "active" }),
      ev("a", "active", "2026-05-20T00:00:00Z", { fromStatus: "inactive" }),
    ]);
    expect(moves.map((m) => m.kind)).toEqual(["new", "otherOut", "otherIn"]);
  });

  it("set inactive by hand, then cancelled: a loss at the cancellation, paired with the pause reversed", () => {
    const moves = memberMovements([
      ev("a", "active", "2026-01-10T00:00:00Z"),
      ev("a", "inactive", "2026-04-02T00:00:00Z", { fromStatus: "active" }),
      ev("a", "cancelled", "2026-06-15T00:00:00Z", { fromStatus: "inactive" }),
      ev("a", "active", "2026-09-01T00:00:00Z", { fromStatus: "cancelled" }),
    ]);
    expect(moves.map((m) => m.kind)).toEqual(["new", "otherOut", "otherIn", "lostCancelled", "rejoined"]);
    expect(moves[2].at.toISOString()).toBe(moves[3].at.toISOString());
  });

  it("a taster who went to cancelled and later started is new; a former member brought over by an import is a rejoin", () => {
    const taster = memberMovements([
      ev("a", "taster", "2026-01-10T00:00:00Z"),
      ev("a", "cancelled", "2026-01-20T00:00:00Z", { fromStatus: "taster" }),
      ev("a", "active", "2026-03-01T00:00:00Z", { fromStatus: "cancelled" }),
    ]);
    // D11: the taster start is a taster added (its own line); the first start is still new.
    expect(taster.map((m) => m.kind)).toEqual(["tasterAdded", "new"]);
    const former = memberMovements([
      ev("b", "cancelled", IMPORT_DAY, { reason: "import", fromStatus: null, sourceAction: "import_create" }),
      ev("b", "active", "2026-10-12T00:00:00Z", { fromStatus: "cancelled" }),
    ]);
    expect(former.map((m) => m.kind)).toEqual(["rejoined"]);
  });
});

describe("clubMonthWindows: calendar months in the club's timezone", () => {
  it("ends with the month holding now, and a London month starts at local midnight (BST is UTC+1)", () => {
    const w = clubMonthWindows(NOW, TZ, 12);
    expect(w).toHaveLength(12);
    expect(w[0].key).toBe("2025-11");
    expect(w[0].label).toBe("Nov 25");
    expect(w[11].key).toBe("2026-10");
    expect(w[11].isCurrent).toBe(true);
    expect(w[11].at.toISOString()).toBe(NOW.toISOString());
    expect(w[11].start.toISOString()).toBe("2026-09-30T23:00:00.000Z");
    expect(w[10].at.toISOString()).toBe("2026-09-30T22:59:59.999Z");
    // November is GMT: midnight is midnight UTC.
    expect(w[0].start.toISOString()).toBe("2025-11-01T00:00:00.000Z");
  });

  it("an event at 23:30 UTC on 31 Aug belongs to September in London", () => {
    const m = buildMembership({
      events: [ev("a", "active", "2026-08-31T23:30:00Z")],
      live: [{ id: "a", status: "active" }],
      now: NOW,
      timeZone: TZ,
      boundary: new Date("2025-01-01T00:00:00Z"),
    });
    expect(m.movementsByMonth.find((r) => r.month === "2026-08")?.new).toBe(0);
    expect(m.movementsByMonth.find((r) => r.month === "2026-09")?.new).toBe(1);
  });
});

describe("clubMonthWindows / buildMembership with an end month (statistics period, 26 Oct 2026)", () => {
  const HISTORY = () => [
    ev("a", "active", "2025-03-01T00:00:00Z"),
    ev("a", "cancelled", "2026-06-15T10:00:00Z"),
    ev("a", "active", "2026-09-10T10:00:00Z"),
    ev("b", "active", "2025-04-01T00:00:00Z"),
    ev("b", "cancelled", "2026-08-20T10:00:00Z"),
    ev("c", "active", "2026-07-05T10:00:00Z"),
  ];
  const LIVE = [{ id: "a", status: "active" }, { id: "b", status: "cancelled" }, { id: "c", status: "active" }];

  it("windows end with the given month, each counted to its last instant, and none is current", () => {
    const w = clubMonthWindows(NOW, TZ, 3, "2026-08");
    expect(w.map((x) => x.key)).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(w.every((x) => !x.isCurrent)).toBe(true);
    expect(w[2].at.toISOString()).toBe("2026-08-31T22:59:59.999Z");
  });

  it("an end month of this month (or later) is the same as none", () => {
    expect(clubMonthWindows(NOW, TZ, 4, "2026-10")).toEqual(clubMonthWindows(NOW, TZ, 4));
    expect(clubMonthWindows(NOW, TZ, 4, "2027-03")).toEqual(clubMonthWindows(NOW, TZ, 4));
  });

  it("a past period's totals and opening headcount match the same months in the full series", () => {
    const full = buildMembership({ events: HISTORY(), live: LIVE, now: NOW, timeZone: TZ, boundary: new Date("2025-01-01T00:00:00Z") });
    const jun_aug = buildMembership({ events: HISTORY(), live: LIVE, now: NOW, timeZone: TZ, boundary: new Date("2025-01-01T00:00:00Z"), months: 3, endMonth: "2026-08" });
    const months = full.movementsByMonth.filter((r) => r.month >= "2026-06" && r.month <= "2026-08");
    const sum = (k: "new" | "rejoined" | "lost" | "net") => months.reduce((n, r) => n + r[k], 0);
    expect(jun_aug.totals).toMatchObject({ new: sum("new"), rejoined: sum("rejoined"), lost: sum("lost"), net: sum("net") });
    expect(jun_aug.totals).toMatchObject({ new: 1, lost: 2, net: -1 }); // c joined July; a left June, b left August
    // Opening = active at the end of May = the full series' May headcount (a and b).
    expect(jun_aug.openingHeadcount).toBe(full.headcountByMonth.find((r) => r.month === "2026-05")!.headcount);
    expect(jun_aug.openingHeadcount).toBe(2);
    expect(jun_aug.headcountByMonth.map((r) => r.headcount)).toEqual(
      full.headcountByMonth.filter((r) => r.month >= "2026-06" && r.month <= "2026-08").map((r) => r.headcount),
    );
  });

  it("without an end month nothing changes", () => {
    const a = buildMembership({ events: HISTORY(), live: LIVE, now: NOW, timeZone: TZ, boundary: null });
    const b = buildMembership({ events: HISTORY(), live: LIVE, now: NOW, timeZone: TZ, boundary: null, endMonth: undefined });
    expect(b).toEqual(a);
  });
});

describe("buildMembership", () => {
  it("acceptance 2: cancelled in June, active again in September — June lost, September rejoined, neither drops them", () => {
    const m = buildMembership({
      events: [
        ev("a", "active", "2025-03-01T00:00:00Z"),
        ev("a", "cancelled", "2026-06-15T10:00:00Z"),
        ev("a", "active", "2026-09-10T10:00:00Z"),
      ],
      live: [{ id: "a", status: "active" }],
      now: NOW,
      timeZone: TZ,
      boundary: new Date("2025-01-01T00:00:00Z"),
    });
    const by = (k: string) => m.movementsByMonth.find((r) => r.month === k)!;
    expect(by("2026-06")).toMatchObject({ lost: 1, lostCancelled: 1, rejoined: 0, net: -1 });
    expect(by("2026-09")).toMatchObject({ rejoined: 1, new: 0, lost: 0, net: 1 });
    const head = (k: string) => m.headcountByMonth.find((r) => r.month === k)!.headcount;
    expect([head("2026-05"), head("2026-06"), head("2026-08"), head("2026-09")]).toEqual([1, 0, 0, 1]);
    expect(m.totals).toMatchObject({ new: 0, rejoined: 1, lost: 1, net: 0 });
  });

  it("acceptance 3: months before the import day are estimated, never recorded; the import month is partly estimated", () => {
    const m = buildMembership({
      events: [
        ev("a", "active", "2025-06-01T00:00:00Z", { reason: "import", sourceAction: "import_backfill", estimated: true }),
        ev("a", "active", IMPORT_DAY, { reason: "import", fromStatus: null, sourceAction: "import_create" }),
        ev("b", "active", "2026-10-02T00:00:00Z", { reason: "import", sourceAction: "import_backfill", estimated: true }),
        ev("b", "active", IMPORT_DAY, { reason: "import", fromStatus: null, sourceAction: "import_create" }),
      ],
      live: [{ id: "a", status: "active" }, { id: "b", status: "active" }],
      now: NOW,
      timeZone: TZ,
      boundary: IMPORT_DAY,
    });
    expect(m.boundary).toBe(IMPORT_DAY.toISOString());
    for (const r of m.movementsByMonth.slice(0, 11)) expect(r.basis).toBe("estimated");
    for (const r of m.headcountByMonth.slice(0, 11)) expect(r.basis).toBe("estimated");
    expect(m.movementsByMonth[11].basis).toBe("mixed");
    expect(m.headcountByMonth[11].basis).toBe("recorded");
    expect(m.movementsByMonth[11]).toMatchObject({ new: 1, imported: 0 });
  });

  it("no event of any kind: every month has no data (never a fabricated zero)", () => {
    const m = buildMembership({ events: [], live: [], now: NOW, timeZone: TZ, boundary: null });
    expect(m.movementsByMonth.every((r) => r.basis === "none")).toBe(true);
    expect(m.headcountByMonth.every((r) => r.basis === "none" && r.headcount === null)).toBe(true);
    expect(m.firstDataAt).toBeNull();
  });

  it("months that end before the earliest event of any kind are 'none', and the window starts at the first month with data", () => {
    const m = buildMembership({
      events: [
        ev("a", "active", "2026-03-10T00:00:00Z", { estimated: true }),
        ev("a", "active", IMPORT_DAY, { reason: "import", fromStatus: null, sourceAction: "import_create" }),
      ],
      live: [{ id: "a", status: "active" }],
      now: NOW,
      timeZone: TZ,
      boundary: IMPORT_DAY,
    });
    const march = m.headcountByMonth.findIndex((h) => h.month === "2026-03");
    for (const h of m.headcountByMonth.slice(0, march)) expect(h).toMatchObject({ basis: "none", headcount: null });
    for (const r of m.movementsByMonth.slice(0, march)) expect(r.basis).toBe("none");
    expect(m.headcountByMonth[march]).toMatchObject({ basis: "estimated", headcount: 1 });
    expect(m.window).toEqual({ from: "Mar 26", to: "Oct 26", months: 8 });
    expect(m.firstDataAt).toBe("2026-03-10T00:00:00.000Z");
  });

  it("a pause undone in the same month: no rejoin, net 0, and the headcount still adds up", () => {
    const m = buildMembership({
      events: [
        ev("a", "active", "2025-06-01T00:00:00Z"),
        ev("a", "inactive", "2026-10-06T09:00:00Z", { fromStatus: "active" }),
        // The Activity-log undo writes a staff_edit event back to active.
        ev("a", "active", "2026-10-06T09:05:00Z", { fromStatus: "inactive" }),
      ],
      live: [{ id: "a", status: "active" }],
      now: NOW,
      timeZone: TZ,
      boundary: new Date("2025-01-01T00:00:00Z"),
    });
    expect(m.movementsByMonth[11]).toMatchObject({ rejoined: 0, new: 0, lost: 0, net: 0, otherIn: 1, otherOut: 1 });
    expect(m.headcountByMonth[11].headcount).toBe(1);
  });

  it("a pause then a cancellation: the cancellation month counts one lost and the movement identity holds", () => {
    const m = buildMembership({
      events: [
        ev("a", "active", "2025-06-01T00:00:00Z"),
        ev("a", "inactive", "2026-07-02T00:00:00Z", { fromStatus: "active" }),
        ev("a", "cancelled", "2026-09-10T00:00:00Z", { fromStatus: "inactive" }),
      ],
      live: [{ id: "a", status: "cancelled" }],
      now: NOW,
      timeZone: TZ,
      boundary: new Date("2025-01-01T00:00:00Z"),
    });
    const by = (k: string) => m.movementsByMonth.find((r) => r.month === k)!;
    expect(by("2026-07")).toMatchObject({ otherOut: 1, lost: 0, net: 0 });
    expect(by("2026-09")).toMatchObject({ lostCancelled: 1, otherIn: 1, net: -1 });
    let prev = m.openingHeadcount;
    m.headcountByMonth.forEach((h, i) => {
      expect((h.headcount ?? 0) - prev).toBe(tallyChange(m.movementsByMonth[i]));
      prev = h.headcount ?? 0;
    });
  });

  it("reconciles a replay that disagrees with the current status, so today equals the live active count", () => {
    const m = buildMembership({
      events: [ev("a", "active", "2026-01-01T00:00:00Z"), ev("b", "active", "2026-01-01T00:00:00Z")],
      // b was cancelled by a writer that left no event; c has no events and is active.
      live: [{ id: "a", status: "active" }, { id: "b", status: "cancelled" }, { id: "c", status: "active" }, { id: "d", status: "inactive" }],
      now: NOW,
      timeZone: TZ,
      boundary: new Date("2025-01-01T00:00:00Z"),
    });
    expect(m.headcountByMonth[11].headcount).toBe(2);
    expect(m.reconciled).toBe(2);
    expect(m.movementsByMonth[11]).toMatchObject({ otherIn: 1, otherOut: 1, new: 0, lost: 0 });
    expect(m.movementsByMonth[11].basis).toBe("mixed");
  });

  it("ignores events for anyone outside the live training population", () => {
    const m = buildMembership({
      events: [ev("guardian", "active", "2026-01-01T00:00:00Z")],
      live: [],
      now: NOW,
      timeZone: TZ,
      boundary: new Date("2025-01-01T00:00:00Z"),
    });
    expect(m.headcountByMonth.every((r) => !r.headcount)).toBe(true);
    expect(m.totals.new).toBe(0);
  });

  it("acceptance 1: 10 training members over 12 months — every month adds up, and today equals the tile", () => {
    const D = (s: string) => `${s}T12:00:00Z`;
    const events: MovementEvent[] = [
      ev("m1", "active", D("2025-09-01")),
      ev("m2", "active", D("2025-12-03")), ev("m2", "cancelled", D("2026-02-20")),
      ev("m3", "active", D("2026-01-05")), ev("m3", "cancelled", D("2026-04-01")), ev("m3", "active", D("2026-07-07")),
      ev("m4", "active", D("2026-02-01"), { reason: "import", sourceAction: "import_backfill", estimated: true }),
      ev("m4", "inactive", D("2026-08-01"), { reason: "import", sourceAction: "import_backfill", estimated: true }),
      ev("m5", "taster", D("2026-03-01")), ev("m5", "active", D("2026-03-15")),
      ev("m6", "active", D("2026-05-01")), ev("m6", "inactive", D("2026-06-01")),
      ev("m7", "active", IMPORT_DAY, { reason: "import", fromStatus: null, sourceAction: "import_create" }),
      ev("m8", "cancelled", IMPORT_DAY, { reason: "import", fromStatus: null, sourceAction: "import_create" }),
      ev("m9", "active", D("2026-10-10")),
      ev("m10", "active", D("2025-01-01")), ev("m10", "cancelled", D("2025-12-31")),
    ];
    const live = [
      { id: "m1", status: "active" }, { id: "m2", status: "cancelled" }, { id: "m3", status: "active" }, { id: "m4", status: "inactive" },
      { id: "m5", status: "active" }, { id: "m6", status: "inactive" }, { id: "m7", status: "active" }, { id: "m8", status: "cancelled" },
      { id: "m9", status: "active" }, { id: "m10", status: "cancelled" },
    ];
    const m = buildMembership({ events, live, now: NOW, timeZone: TZ, boundary: IMPORT_DAY });
    let prev = m.openingHeadcount;
    m.headcountByMonth.forEach((h, i) => {
      expect((h.headcount ?? 0) - prev).toBe(tallyChange(m.movementsByMonth[i]));
      prev = h.headcount ?? 0;
    });
    expect(m.headcountByMonth[11].headcount).toBe(live.filter((x) => x.status === "active").length);
    expect(m.reconciled).toBe(0);
    expect(m.totals).toMatchObject({ new: 6, rejoined: 1, lostCancelled: 3, lostCompleted: 1, imported: 1, otherOut: 1 });
    expect(m.totals.net).toBe(6 + 1 - 4);
  });
});

describe("movements: window edges", () => {
  it("a move belongs to the window whose start it is at or after and whose instant it is at or before", () => {
    const windows = [
      { start: new Date("2026-01-01T00:00:00Z"), at: new Date("2026-01-31T23:59:59.999Z") },
      { start: new Date("2026-02-01T00:00:00Z"), at: new Date("2026-02-28T23:59:59.999Z") },
    ];
    const t = movements(
      [
        { memberId: "a", at: new Date("2026-01-31T23:59:59.999Z"), kind: "new", estimated: false },
        { memberId: "b", at: new Date("2026-02-01T00:00:00Z"), kind: "lostCancelled", estimated: false },
        { memberId: "c", at: new Date("2025-12-31T00:00:00Z"), kind: "new", estimated: false },
      ],
      windows,
    );
    expect(t[0]).toMatchObject({ new: 1, net: 1 });
    expect(t[1]).toMatchObject({ lost: 1, lostCancelled: 1, net: -1 });
  });
});

describe("the movement identity, as a property over randomised streams", () => {
  // mulberry32: a small seeded PRNG, so a failure reproduces from its seed.
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const STATUSES = ["active", "active", "inactive", "cancelled", "taster"];
  const KINDS: Partial<MovementEvent>[] = [
    { reason: "staff_edit" },
    { reason: "stripe_webhook" },
    { reason: "import", fromStatus: null, sourceAction: "import_create" },
    { reason: "import", fromStatus: "active", sourceAction: "import_refresh" },
    { reason: "import", fromStatus: "cancelled", sourceAction: "import_rollback" },
    { reason: "import", sourceAction: "import_backfill", estimated: true },
  ];
  const START = new Date("2025-08-01T00:00:00Z").getTime();
  const SPAN = NOW.getTime() - START;

  for (let seed = 1; seed <= 200; seed += 1) {
    it(`seed ${seed}: headcount change equals the tally every month, and today equals the live count`, () => {
      const r = rng(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
      const events: MovementEvent[] = [];
      const live: { id: string; status: string }[] = [];
      for (let i = 0; i < 10; i += 1) {
        const id = `m${i}`;
        const n = Math.floor(r() * 6);
        let lastAt = START + Math.floor(r() * SPAN);
        for (let k = 0; k < n; k += 1) {
          // Sometimes reuse the previous instant to force ties.
          const at = r() < 0.2 ? lastAt : START + Math.floor(r() * SPAN);
          lastAt = at;
          events.push(
            ev(id, pick(STATUSES), new Date(at), {
              ...pick(KINDS),
              createdAt: new Date(at + Math.floor(r() * 5000)),
            }),
          );
        }
        live.push({ id, status: pick(STATUSES) });
      }
      const m = buildMembership({ events, live, now: NOW, timeZone: TZ, boundary: new Date(START + SPAN / 2) });
      let prev = m.openingHeadcount;
      m.headcountByMonth.forEach((h, i) => {
        if (h.basis === "none") expect(h.headcount).toBeNull();
        expect((h.headcount ?? 0) - prev).toBe(tallyChange(m.movementsByMonth[i]));
        prev = h.headcount ?? 0;
      });
      for (const t of m.movementsByMonth) {
        expect(t.lost).toBe(t.lostCancelled + t.lostCompleted);
        expect(t.net).toBe(t.new + t.rejoined - t.lost);
      }
      expect(m.headcountByMonth[m.headcountByMonth.length - 1].headcount).toBe(live.filter((x) => x.status === "active").length);
    });
  }
});

describe("joinDateHistory: earlier history from join and cancellation dates", () => {
  const member = (status: string, joined: string, cancelled: string | null = null) => ({
    id: "x",
    status,
    joinedAt: new Date(joined),
    cancelledAt: cancelled ? new Date(cancelled) : null,
  });

  it("a member with no events who is active: active from their join date, estimated", () => {
    const out = joinDateHistory(member("active", "2025-04-02T00:00:00Z"), [], NOW);
    expect(out.map((e) => [e.toStatus, e.occurredAt.toISOString(), e.estimated])).toEqual([["active", "2025-04-02T00:00:00.000Z", true]]);
  });

  it("a member who had left by the import, with a date: active then cancelled", () => {
    const opening = ev("x", "cancelled", IMPORT_DAY, { reason: "import", fromStatus: null, sourceAction: "import_create" });
    const out = joinDateHistory(member("cancelled", "2024-01-10T00:00:00Z", "2025-08-31T00:00:00Z"), [opening], NOW);
    expect(out.map((e) => e.toStatus)).toEqual(["active", "cancelled"]);
  });

  it("a member who predates the event log: the first transition's fromStatus is their earlier state, so a staff cancellation after the boundary is one lost", () => {
    const cancel = ev("x", "cancelled", "2026-10-05T10:00:00Z", { fromStatus: "active" });
    const prior = joinDateHistory(member("cancelled", "2025-02-01T00:00:00Z", "2026-10-05T10:00:00Z"), [cancel], NOW);
    expect(prior.map((e) => [e.toStatus, e.occurredAt.toISOString(), e.estimated])).toEqual([["active", "2025-02-01T00:00:00.000Z", true]]);
    const m = buildMembership({
      events: [cancel, ...prior],
      live: [{ id: "x", status: "cancelled" }],
      now: NOW,
      timeZone: TZ,
      boundary: new Date("2026-10-05T10:00:00Z"),
    });
    expect(m.movementsByMonth[11]).toMatchObject({ lostCancelled: 1, net: -1 });
    expect(m.headcountByMonth[10]).toMatchObject({ headcount: 1, basis: "estimated" });
    // A join date not before the event: the earlier state sits 1 ms before it.
    const late = joinDateHistory(member("cancelled", "2026-10-06T00:00:00Z"), [cancel], NOW);
    expect(late.map((e) => e.occurredAt.toISOString())).toEqual(["2026-10-05T09:59:59.999Z"]);
  });

  it("invents nothing: no cancellation date, inactive, a non-import first event, or a join after it", () => {
    const opening = (to: string) => ev("x", to, IMPORT_DAY, { reason: "import", fromStatus: null, sourceAction: "import_create" });
    expect(joinDateHistory(member("cancelled", "2024-01-10T00:00:00Z"), [opening("cancelled")], NOW)).toEqual([]);
    expect(joinDateHistory(member("inactive", "2024-01-10T00:00:00Z"), [opening("inactive")], NOW)).toEqual([]);
    expect(joinDateHistory(member("active", "2024-01-10T00:00:00Z"), [ev("x", "active", "2026-01-01T00:00:00Z")], NOW)).toEqual([]);
    expect(joinDateHistory(member("active", "2026-10-05T00:00:00Z"), [opening("active")], NOW)).toEqual([]);
  });
});

describe("estimatedCaption: what an estimate came from", () => {
  it("names TeamUp only when the estimate came from the TeamUp ledger", () => {
    expect(estimatedCaption({ historySource: "backfill", fromJoinDates: 0 })).toBe("Estimated from your TeamUp history");
    expect(estimatedCaption({ historySource: "ledger", fromJoinDates: 3 })).toBe("Estimated from your TeamUp history and join and cancellation dates");
    expect(estimatedCaption({ historySource: "none", fromJoinDates: 2 })).toBe("Estimated from join and cancellation dates");
    expect(estimatedCaption({ historySource: "none", fromJoinDates: 0 })).toBe("Estimated");
  });
});

// Churn the normal way (D4, Noe 26 Oct 2026): of the members active just before
// the window, how many left inside it — each person once, so n ≤ m always.
describe("openingChurned: churn's numerator", () => {
  const B = new Date("2025-01-01T00:00:00Z");
  const build = (events: MovementEvent[], live: { id: string; status: string }[]) =>
    buildMembership({ events, live, now: NOW, timeZone: TZ, boundary: B, months: 3, endMonth: "2026-10" });

  it("a member there before the window who left in it is churn", () => {
    const m = build([ev("a", "active", "2025-03-01T00:00:00Z"), ev("a", "cancelled", "2026-09-10T10:00:00Z", { fromStatus: "active" })], [{ id: "a", status: "cancelled" }]);
    expect([m.openingChurned, m.openingHeadcount]).toEqual([1, 1]);
  });

  it("someone who joined and left inside the window is not churn (never in the base), though they are Left", () => {
    const m = build([ev("j", "active", "2026-08-05T10:00:00Z"), ev("j", "cancelled", "2026-09-20T10:00:00Z", { fromStatus: "active" })], [{ id: "j", status: "cancelled" }]);
    expect([m.openingChurned, m.openingHeadcount, m.totals.lost]).toEqual([0, 0, 1]);
  });

  it("paused (inactive) before the window and cancelled in it: not active at the start, so not churn", () => {
    const m = build([
      ev("p", "active", "2025-03-01T00:00:00Z"),
      ev("p", "inactive", "2026-06-01T10:00:00Z", { fromStatus: "active" }),
      ev("p", "cancelled", "2026-09-01T10:00:00Z", { fromStatus: "inactive" }),
    ], [{ id: "p", status: "cancelled" }]);
    expect(m.openingChurned).toBe(0);
  });

  it("left twice in the window counts once; left and came back still left", () => {
    const m = build([
      ev("t", "active", "2025-03-01T00:00:00Z"),
      ev("t", "cancelled", "2026-08-10T10:00:00Z", { fromStatus: "active" }),
      ev("t", "active", "2026-09-01T10:00:00Z", { fromStatus: "cancelled" }),
      ev("t", "cancelled", "2026-10-02T10:00:00Z", { fromStatus: "active" }),
      ev("r", "active", "2025-03-01T00:00:00Z"),
      ev("r", "cancelled", "2026-08-10T10:00:00Z", { fromStatus: "active" }),
      ev("r", "active", "2026-09-01T10:00:00Z", { fromStatus: "cancelled" }),
    ], [{ id: "t", status: "cancelled" }, { id: "r", status: "active" }]);
    expect([m.openingChurned, m.openingHeadcount]).toEqual([2, 2]);
    expect(m.totals.lost).toBe(3);
  });
});

describe("moversAndBasisInWindow: joins as moves (Analysis agrees with the Reports Joined tile)", () => {
  it("a member who rejoined twice in the window is one person but two joins", async () => {
    const { moversAndBasisInWindow } = await import("@/lib/membership-movement");
    const r = moversAndBasisInWindow({
      events: [
        ev("x", "active", "2025-03-01T00:00:00Z"),
        ev("x", "cancelled", "2026-07-02T10:00:00Z", { fromStatus: "active" }),
        ev("x", "active", "2026-08-02T10:00:00Z", { fromStatus: "cancelled" }),
        ev("x", "cancelled", "2026-08-20T10:00:00Z", { fromStatus: "active" }),
        ev("x", "active", "2026-09-02T10:00:00Z", { fromStatus: "cancelled" }),
      ],
      live: [{ id: "x", status: "active" }],
      now: NOW,
      boundary: new Date("2025-01-01T00:00:00Z"),
    }, { start: new Date("2026-07-31T23:00:00Z"), at: NOW });
    expect(r.movers.rejoined).toEqual(["x"]);
    expect(r.joinedMoves).toBe(2);
  });
});
