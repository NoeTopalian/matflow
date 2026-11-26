// @vitest-environment jsdom
//
// The staff dashboard's classes name the class's coach (26 Nov 2026, Noe): the
// staff coach linked to the class, else the typed name (lib/class-coach.ts
// resolveCoachName, as the member pages do). A class with neither says "No
// coach assigned", quietly, and is not flagged: an open mat, or a class with no
// regular coach, is normal. It used to read "TBC" with an amber "Needs coach"
// pill on every class whose coach was linked rather than typed.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

type Args = { where?: Record<string, unknown>; include?: Record<string, unknown> };
const weekCalls: Args[] = [];
const TODAY = "2026-11-26";
const classRow = (id: string, name: string, coachName: string | null, coachUser: { id: string; name: string } | null) => ({
  id, startTime: "18:00", endTime: "19:00", date: new Date(`${TODAY}T00:00:00Z`),
  class: { name, coachName, coachUser, maxCapacity: 20, location: "Mat 2" },
  _count: { attendances: 0 },
});
const WEEK = [
  classRow("i1", "Staff coach only", null, { id: "u-casey", name: "Casey Staff" }),
  classRow("i2", "Typed name only", "Terry Typed", null),
  classRow("i3", "Both", "Terry Typed", { id: "u-casey", name: "Casey Staff" }),
  classRow("i4", "Open Mat", null, null),
];

function fakeTx() {
  const delegate = (model: string) =>
    new Proxy({}, {
      get: (_t, method: string) => async (args: Args) => {
        if (model === "tenant" && method === "findUnique") return { timezone: "Europe/London", stripeConnected: true, onboardingCompleted: true, contactEmail: "club@example.test", billingContactEmail: null };
        if (model === "classInstance" && method === "findMany" && args?.where?.date) { weekCalls.push(args); return WEEK; }
        if (method === "count") return 0;
        if (method === "findMany" || method === "groupBy") return [];
        return null;
      },
    });
  return new Proxy({}, { get: (_t, model: string) => delegate(model) });
}

vi.mock("@/lib/authz", () => ({
  requireStaff: async () => ({ session: { user: { id: "u1", tenantId: "t1", role: "owner", primaryColor: "#3b82f6", tenantName: "Club", name: "Owner" } } }),
}));
vi.mock("@/lib/prisma-tenant", () => ({ withTenantContext: async (_t: string, fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx()) }));

import DashboardPage from "@/app/dashboard/page";
import DashboardStats from "@/components/dashboard/DashboardStats";
import WeeklyCalendar, { type DayClass } from "@/components/dashboard/WeeklyCalendar";

afterEach(() => { cleanup(); weekCalls.length = 0; vi.useRealTimers(); });

async function dashboardClasses(): Promise<DayClass[]> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  const el = (await DashboardPage({})) as unknown as { props: { children: unknown[] } };
  const stats = (el.props.children as ({ props?: { classes?: DayClass[] } } | false | null)[]).find((c) => c && typeof c === "object" && c.props && "classes" in c.props);
  return (stats as { props: { classes: DayClass[] } }).props.classes;
}

describe("the staff dashboard names each class's coach", () => {
  it("staff coach only: the staff name; typed only: the typed name; both: the staff name; neither: no coach (null)", async () => {
    const classes = await dashboardClasses();
    expect(classes.map((c) => [c.name, c.coach])).toEqual([
      ["Staff coach only", "Casey Staff"],
      ["Typed name only", "Terry Typed"],
      ["Both", "Casey Staff"],
      ["Open Mat", null],
    ]);
    // The linked staff coach is read with the week's sessions (tenant-scoped, as before).
    expect(weekCalls[0].include?.class).toMatchObject({ include: { coachUser: { select: { id: true, name: true } } } });
  });

  it("Today's Classes: each card names its coach; a class with none says 'No coach assigned', and nothing is flagged 'Needs coach'", async () => {
    const classes = await dashboardClasses();
    vi.useRealTimers();
    const stats = { totalActive: 1, newThisMonth: 0, attendanceThisWeek: 0, attendanceThisMonth: 0, waiverMissing: 0, missingPhone: 0, paymentsDue: 0, atRiskMembers: 0 };
    render(<DashboardStats todayKey={TODAY} stats={stats} classes={classes} tenantName="Club" primaryColor="#3b82f6" />);
    const card = (name: string) => screen.getByText(`18:00 · ${name}`).closest("a") as HTMLElement;
    expect(within(card("Staff coach only")).getByText("Casey Staff · Mat 2")).toBeTruthy();
    expect(within(card("Typed name only")).getByText("Terry Typed · Mat 2")).toBeTruthy();
    expect(within(card("Both")).getByText("Casey Staff · Mat 2")).toBeTruthy();
    expect(within(card("Open Mat")).getByText("No coach assigned · Mat 2")).toBeTruthy();
    expect(screen.queryByText("Needs coach")).toBeNull();
    expect(screen.queryByText(/TBC/)).toBeNull();
    // The pill is the next status in line: here, every class has room.
    expect(within(card("Open Mat")).getByText("Ready")).toBeTruthy();
  });

  it("the week calendar names the coach, or 'No coach assigned', and never 'TBC'", async () => {
    const classes = await dashboardClasses();
    vi.useRealTimers();
    // jsdom has no scrolling; the calendar scrolls today's pill into view.
    Element.prototype.scrollIntoView = vi.fn();
    render(<WeeklyCalendar todayKey={TODAY} classes={classes} primaryColor="#3b82f6" role="owner" />);
    expect(screen.getAllByText("Casey Staff").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Terry Typed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("No coach assigned").length).toBeGreaterThan(0);
    expect(screen.queryByText(/TBC/)).toBeNull();
  });
});
