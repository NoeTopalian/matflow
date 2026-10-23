// @vitest-environment jsdom
//
// Review L4 (23 Oct 2026): "this month" is the CLUB's month, resolved once on
// the server as the half-open window [monthStart, nextMonthStart), and every
// surface uses those two instants — Reports' tiles, the Reports CSV and the
// Members drill-through rows. Before this change Reports used the server
// process's month and the drill-through recomputed the month in the BROWSER's
// zone, so near a month boundary the tile and the rows behind it disagreed.
//
// The cases put the club, the server and the browser in three different
// zones at an instant where they do not agree on the month, run the real
// getReportsData over in-memory rows (its real Prisma wheres, evaluated with
// SQL semantics), build the real CSV, and render the real drill-through.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { fakeTx } from "./support/prisma-where-eval";

let members: Record<string, unknown>[] = [];
let clubZone = "Pacific/Auckland";
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakeTx(members, { timezone: clubZone })),
}));

let currentSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/dashboard/members",
}));

import { clubMonthWindow, clubMonthWindowForKey, inMonthWindow } from "@/lib/club-month";
import { getReportsData } from "@/lib/reports";
import { reportsCsv, monthDrillHref } from "@/components/dashboard/ReportsView";
import MembersList, { type MemberRow } from "@/components/dashboard/MembersList";

const ATTRIBUTION = {
  rows: [],
  overall: { trials: 0, lost: 0, undecided: 0, converted: 0, conversionRate: null, churned: 0, retained: 0, retentionRate: null },
  epochStart: null,
  minTrials: 5,
};

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  process.env.TZ = ORIGINAL_TZ;
});

describe("clubMonthWindow — the boundary helper", () => {
  it("2026-10-31T23:30Z: an Auckland club is already in November while UTC and Los Angeles are in October", () => {
    const at = new Date("2026-10-31T23:30:00Z");
    const club = clubMonthWindow(at, "Pacific/Auckland");
    expect(club.monthKey).toBe("2026-11");
    // Midnight on 1 November, NZDT (UTC+13), and midnight on 1 December.
    expect(club.monthStart).toBe("2026-10-31T11:00:00.000Z");
    expect(club.nextMonthStart).toBe("2026-11-30T11:00:00.000Z");
    expect(club.label).toBe("November 2026");
    expect(clubMonthWindow(at, "UTC").monthKey).toBe("2026-10");
    expect(clubMonthWindow(at, "America/Los_Angeles").monthKey).toBe("2026-10");
  });

  it("mirror at the start of a month: 2026-11-01T05:00Z is still October for a Los Angeles club, November in UTC and Auckland", () => {
    const at = new Date("2026-11-01T05:00:00Z");
    const club = clubMonthWindow(at, "America/Los_Angeles");
    expect(club.monthKey).toBe("2026-10");
    // Midnight on 1 October and on 1 November, PDT (UTC−7) both.
    expect(club.monthStart).toBe("2026-10-01T07:00:00.000Z");
    expect(club.nextMonthStart).toBe("2026-11-01T07:00:00.000Z");
    expect(clubMonthWindow(at, "UTC").monthKey).toBe("2026-11");
    expect(clubMonthWindow(at, "Pacific/Auckland").monthKey).toBe("2026-11");
  });

  it("is half-open: monthStart is in, nextMonthStart is out", () => {
    const w = clubMonthWindow(new Date("2026-10-31T23:30:00Z"), "Pacific/Auckland");
    expect(inMonthWindow(w.monthStart, w)).toBe(true);
    expect(inMonthWindow(new Date(new Date(w.monthStart).getTime() - 1), w)).toBe(false);
    expect(inMonthWindow(new Date(new Date(w.nextMonthStart).getTime() - 1), w)).toBe(true);
    expect(inMonthWindow(w.nextMonthStart, w)).toBe(false);
    expect(inMonthWindow(null, w)).toBe(false);
  });

  it("a Reports link's month key resolves to the same window; a malformed key is refused; a bad zone falls back", () => {
    const w = clubMonthWindow(new Date("2026-10-31T23:30:00Z"), "Pacific/Auckland");
    expect(clubMonthWindowForKey("2026-11", "Pacific/Auckland")).toEqual(w);
    expect(clubMonthWindowForKey("2026-13", "Pacific/Auckland")).toBeNull();
    expect(clubMonthWindowForKey("November", "Pacific/Auckland")).toBeNull();
    expect(clubMonthWindow(new Date("2026-10-15T12:00:00Z"), "Not/AZone").timeZone).toBe("Europe/London");
  });
});

type Fixture = { id: string; name: string; status?: string; accountType?: string; joinedAt: string; cancelledAt?: string | null };

function rowsFor(fixture: Fixture[]) {
  return fixture.map((f) => ({
    tenantId: "club",
    id: f.id,
    name: f.name,
    email: `${f.id}@example.test`,
    status: f.status ?? "active",
    accountType: f.accountType ?? "adult",
    paymentStatus: "paid",
    billedBy: "matflow",
    joinedAt: new Date(f.joinedAt),
    cancelledAt: f.cancelledAt ? new Date(f.cancelledAt) : null,
  }));
}

function memberRows(fixture: Fixture[]): MemberRow[] {
  return fixture.map((f) => ({
    id: f.id,
    name: f.name,
    email: `${f.id}@example.test`,
    status: f.status ?? "active",
    accountType: f.accountType ?? "adult",
    paymentStatus: "paid",
    joinedAt: new Date(f.joinedAt).toISOString(),
    cancelledAt: f.cancelledAt ? new Date(f.cancelledAt).toISOString() : null,
  }));
}

const shown = (name: string) => screen.queryAllByText(name).length > 0;

/**
 * Runs Reports on the "server" (process zone UTC), then the CSV and the
 * drill-through in the "browser" (process zone `browserZone`), and returns
 * what each surface says.
 */
async function threeSurfaces(at: string, browserZone: string, fixture: Fixture[]) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  members = rowsFor(fixture);

  process.env.TZ = "UTC";
  const data = await getReportsData("club");
  // What the Members page server resolves for the link the tile carries.
  const href = monthDrillHref("new-this-month", data.period);
  const monthKey = new URL(href, "http://x").searchParams.get("month");
  const current = clubMonthWindow(new Date(), clubZone);
  const fromLink = clubMonthWindowForKey(monthKey, clubZone)!;
  const monthWindow = { ...fromLink, isCurrent: fromLink.monthKey === current.monthKey };

  process.env.TZ = browserZone;
  const csv = reportsCsv(data, ATTRIBUTION as never);
  const csvValue = (metric: string) => csv.split("\r\n").find((line) => line.split(",")[1] === metric)?.split(",")[2];

  const listed = (filter: string) => {
    currentSearch = `filter=${filter}&month=${monthKey}`;
    const view = render(<MembersList members={memberRows(fixture)} primaryColor="#3b82f6" role="owner" monthWindow={monthWindow} />);
    const names = fixture.filter((f) => shown(f.name)).map((f) => f.id);
    const headline = screen.getByTestId("members-headline").textContent;
    view.unmount();
    return { names, headline };
  };

  return { data, csvValue, csv, newRows: listed("new-this-month"), churnedRows: listed("churned-this-month") };
}

describe("Reports tiles, CSV and drill-through agree on the club's month", () => {
  beforeEach(() => {
    currentSearch = "";
  });

  it("Auckland club, UTC server, Los Angeles browser, 2026-10-31T23:30Z: all three count November", async () => {
    clubZone = "Pacific/Auckland";
    const fixture: Fixture[] = [
      // Club's November (from 2026-10-31T11:00Z):
      { id: "n1", name: "Nia November", joinedAt: "2026-10-31T12:00:00Z" },
      { id: "n2", name: "Ned Boundary", joinedAt: "2026-10-31T11:00:00Z" }, // exactly monthStart: in
      { id: "c1", name: "Cal Cancelled", status: "cancelled", joinedAt: "2026-06-01T00:00:00Z", cancelledAt: "2026-10-31T20:00:00Z" },
      { id: "g1", name: "Gil Guardian", accountType: "parent", joinedAt: "2026-10-31T13:00:00Z" }, // never a member
      // Club's October, though UTC and Los Angeles also call these October:
      { id: "o1", name: "Ola October", joinedAt: "2026-10-15T00:00:00Z" },
      { id: "o2", name: "Oz Lastminute", joinedAt: "2026-10-31T10:59:59Z" }, // one second before monthStart
      { id: "c2", name: "Cy Octobercancel", status: "cancelled", joinedAt: "2026-06-01T00:00:00Z", cancelledAt: "2026-10-30T09:00:00Z" },
      { id: "a1", name: "Ava Active", joinedAt: "2026-01-10T00:00:00Z" },
    ];
    const { data, csvValue, csv, newRows, churnedRows } = await threeSurfaces("2026-10-31T23:30:00Z", "America/Los_Angeles", fixture);

    expect(data.period.monthKey).toBe("2026-11");
    // Tiles.
    expect(data.summary.newMembersThisMonth).toBe(2);
    expect(data.churn.joined).toBe(2);
    expect(data.churn.cancelled).toBe(1);
    expect(data.monthlySignups.at(-1)).toEqual({ month: "Nov 26", count: 2, isCurrentMonth: true });
    // The movement series (T8c) buckets on the same club month: with no status
    // history it falls back to these join and cancel dates, so it agrees here.
    expect(data.membership.movementsByMonth.at(-1)).toMatchObject({ month: data.period.monthKey, new: 2, lostCancelled: 1 });
    // CSV: the same numbers, and it says which month and zone.
    expect(csvValue("New members this month")).toBe("2");
    expect(csvValue("Joined this month")).toBe("2");
    expect(csv).toContain("This month,November 2026");
    expect(csv).toContain("Pacific/Auckland");
    // Drill-through: the same members, by id.
    expect(newRows.names.sort()).toEqual(["n1", "n2"]);
    expect(newRows.headline).toBe("2 joined this month");
    expect(churnedRows.names).toEqual(["c1"]);
    expect(churnedRows.headline).toBe("1 cancelled this month");
  });

  it("mirror: Los Angeles club, UTC server, Auckland browser, 2026-11-01T05:00Z: all three still count October", async () => {
    clubZone = "America/Los_Angeles";
    const fixture: Fixture[] = [
      { id: "o1", name: "Ola October", joinedAt: "2026-10-20T00:00:00Z" },
      { id: "o2", name: "Oz Lastevening", joinedAt: "2026-11-01T03:00:00Z" }, // 31 Oct 20:00 in LA: October
      { id: "c1", name: "Cal Cancelled", status: "cancelled", joinedAt: "2026-06-01T00:00:00Z", cancelledAt: "2026-11-01T01:00:00Z" },
      { id: "s1", name: "Sam September", joinedAt: "2026-10-01T06:59:59Z" }, // 30 Sep 23:59:59 in LA
      { id: "a1", name: "Ava Active", joinedAt: "2026-01-10T00:00:00Z" },
    ];
    const { data, csvValue, newRows, churnedRows } = await threeSurfaces("2026-11-01T05:00:00Z", "Pacific/Auckland", fixture);

    expect(data.period.monthKey).toBe("2026-10");
    expect(data.membership.movementsByMonth.at(-1)).toMatchObject({ month: "2026-10", new: 2, lostCancelled: 1 });
    expect(data.summary.newMembersThisMonth).toBe(2);
    expect(data.churn.cancelled).toBe(1);
    expect(csvValue("Joined this month")).toBe("2");
    expect(newRows.names.sort()).toEqual(["o1", "o2"]);
    expect(newRows.headline).toBe("2 joined this month");
    expect(churnedRows.names).toEqual(["c1"]);
  });

  it("a cached report's link keeps its month after the calendar turns: the drill-through names that month", async () => {
    clubZone = "Pacific/Auckland";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-02T00:00:00Z"));
    const fixture: Fixture[] = [{ id: "n1", name: "Nia November", joinedAt: "2026-11-05T00:00:00Z" }];
    const fromLink = clubMonthWindowForKey("2026-11", clubZone)!;
    currentSearch = "filter=new-this-month&month=2026-11";
    render(
      <MembersList
        members={memberRows(fixture)}
        primaryColor="#3b82f6"
        role="owner"
        monthWindow={{ ...fromLink, isCurrent: false }}
      />,
    );
    expect(shown("Nia November")).toBe(true);
    expect(screen.getByTestId("members-headline").textContent).toBe("1 joined in November 2026");
  });
});
