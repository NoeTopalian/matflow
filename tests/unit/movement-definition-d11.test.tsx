// @vitest-environment jsdom
//
// D11 (owner direction, Noe 23 Oct 2026): ONE movement definition for the
// Reports Joined tile, the charts, the tally line, the CSV and the Members
// drill-throughs (lib/membership-movement.ts). The Joined tile used to count
// Member.joinedAt (any status, tasters and import days included) while the
// chart counted status events, so the two disagreed.
//
// Worked example, all in the current club month:
//   Ana  created active                           → new
//   Ben  created as a taster                      → taster added (not joined)
//   Cara left in May, started again this month    → rejoined
//   Dan  finished a prepaid course this month     → left (completed course)
//   Eve  cancelled this month                     → left (cancelled)
//   Ivy  created by an import this month          → imported, never new
// So: Joined 2 (1 new, 1 rejoined), tasters added 1, left 2, net 0.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { fakeTx } from "./support/prisma-where-eval";

let members: Record<string, unknown>[] = [];
let events: Record<string, unknown>[] = [];
function tx() {
  return {
    ...fakeTx(members, { timezone: "Europe/London" }),
    memberStatusEvent: { findMany: async () => events },
    importedMembership: { findMany: async () => [] },
  };
}
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx()),
}));
let currentSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/dashboard/members",
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { clubMonthWindow } from "@/lib/club-month";
import { MEMBERSHIP_COPY, memberMovements, type MovementEvent } from "@/lib/membership-movement";
import { joinDateHistory, loadJoinedInWindows, loadMonthMovers } from "@/lib/membership-report";
import { getReportsData } from "@/lib/reports";
import { currentMonthMovement, joinedTileDetail, monthDrillHref, reportsCsv } from "@/components/dashboard/ReportsView";
import MembersList, { inStatusView, type MemberRow } from "@/components/dashboard/MembersList";

const NOW = new Date();
const MONTH = clubMonthWindow(NOW, "Europe/London");
const START = new Date(MONTH.monthStart).getTime();
const MIN = 60_000;
const DAY = 86_400_000;
const at = (ms: number) => new Date(ms);
const thisMonth = (minutes: number) => at(START + minutes * MIN);
const before = (days: number) => at(START - days * DAY);

function member(id: string, name: string, status: string, joinedAt: Date, cancelledAt: Date | null = null) {
  return {
    tenantId: "club", id, name, email: `${id}@example.test`, status, accountType: "adult", paymentStatus: "paid",
    membershipTierId: "tier", nextDueAt: null, stripeSubscriptionId: null, billedBy: "matflow", waiverAccepted: true,
    phone: "+447700900123", parentMemberId: null, joinedAt, cancelledAt, attendances: [],
  };
}
let seq = 0;
function ev(memberId: string, fromStatus: string | null, toStatus: string, occurredAt: Date, extra: Partial<MovementEvent> = {}) {
  seq += 1;
  return { id: `e${String(seq).padStart(3, "0")}`, memberId, fromStatus, toStatus, reason: "staff_edit", sourceAction: null, occurredAt, createdAt: occurredAt, ...extra };
}

const CLUB = [
  member("ana", "Ana New", "active", thisMonth(1)),
  member("ben", "Ben Taster", "taster", thisMonth(2)),
  member("cara", "Cara Rejoined", "active", before(400)),
  member("dan", "Dan Course", "inactive", before(200)),
  member("eve", "Eve Cancelled", "cancelled", before(150), thisMonth(5)),
  // The import stamped "now" as Ivy's join date: it must not read as a join.
  member("ivy", "Ivy Imported", "active", thisMonth(6)),
];
const EVENTS = [
  ev("ana", null, "active", thisMonth(1), { reason: "create" }),
  ev("ben", null, "taster", thisMonth(2), { reason: "create" }),
  ev("cara", null, "active", before(400), { reason: "create" }),
  ev("cara", "active", "cancelled", before(150)),
  ev("cara", "cancelled", "active", thisMonth(3)),
  ev("dan", null, "active", before(200), { reason: "create" }),
  ev("dan", "active", "inactive", thisMonth(4), { reason: "import", sourceAction: "import_refresh" }),
  ev("eve", null, "active", before(150), { reason: "create" }),
  ev("eve", "active", "cancelled", thisMonth(5)),
  ev("ivy", null, "active", at(START + 6 * MIN + 500), { reason: "import", sourceAction: "import_create" }),
];

const ATTRIBUTION = {
  rows: [],
  overall: { trials: 0, lost: 0, undecided: 0, converted: 0, conversionRate: null, churned: 0, retained: 0, retentionRate: null },
  epochStart: null,
  minTrials: 5,
};

afterEach(() => {
  cleanup();
  currentSearch = "";
});

describe("D11: one movement definition", () => {
  it("imports never manufacture joins: an import-day join date is no join; a real earlier join date still is", () => {
    const importCreate = ev("x", null, "active", thisMonth(10), { reason: "import", sourceAction: "import_create" }) as MovementEvent;
    const importDay = joinDateHistory({ id: "x", status: "active", joinedAt: thisMonth(9), cancelledAt: null }, [importCreate], NOW);
    expect(importDay).toEqual([]);
    expect(memberMovements([...importDay, importCreate]).map((m) => m.kind)).toEqual(["imported"]);
    const realJoin = joinDateHistory({ id: "x", status: "active", joinedAt: before(90), cancelledAt: null }, [importCreate], NOW);
    expect(memberMovements([...realJoin, importCreate]).map((m) => m.kind)).toEqual(["new"]);
    // A taster created in MatFlow is a taster added; an import's taster is not.
    expect(memberMovements([ev("t", null, "taster", thisMonth(1), { reason: "create" }) as MovementEvent]).map((m) => m.kind)).toEqual(["tasterAdded"]);
    expect(memberMovements([ev("t", null, "taster", thisMonth(1), { reason: "import", sourceAction: "import_create" }) as MovementEvent])).toEqual([]);
  });

  it("Reports: the tile, the chart, the tally and the CSV agree — Joined 2 (1 new, 1 rejoined), tasters 1, left 2, net 0", async () => {
    members = CLUB;
    events = EVENTS;
    const data = await getReportsData("club");
    const t = currentMonthMovement(data.membership);
    expect(t).toMatchObject({ new: 1, rejoined: 1, tasterAdded: 1, lost: 2, lostCancelled: 1, lostCompleted: 1, net: 0, imported: 1 });
    // The tiles read the same events.
    expect(data.churn.joined).toBe(2);
    expect(data.churn.net).toBe(0);
    // Churn is the cancellations: Eve. Dan's finished course is Left, not churn.
    expect(data.churn.cancelled).toBe(1);
    expect(data.summary.newMembersThisMonth).toBe(1);
    // The "Joined" chart's current month.
    expect(data.monthlySignups.find((r) => r.isCurrentMonth)?.count).toBe(2);
    expect(joinedTileDetail(t)).toBe("New 1 · Rejoined 1 · Tasters added 1 · Left 2 · Net 0");

    const csv = reportsCsv(data, ATTRIBUTION as never);
    expect(csv).toContain(`Health,${MEMBERSHIP_COPY.joinedLabel},2,"New 1 · Rejoined 1 · Tasters added 1 · Left 2 · Net 0 · ${MEMBERSHIP_COPY.definition}"`);
    expect(csv).toContain("Health,New this month,1,First ever start");
    expect(csv).toContain("Health,Rejoined this month,1,Started again after leaving");
    expect(csv).toContain("Health,Tasters added this month,1,Not in Joined or Net");
    expect(csv).toContain("Health,Left this month,2,\"Cancelled, or finished a prepaid course\"");
    // Churn's base: the members at the start plus every move into active this month (imports included, never joins).
    expect(data.churn.base).toBe(data.churn.opening + t.new + t.rejoined + t.imported + t.otherIn);
    expect(data.churn.ratePct).toBe(Math.round(1000 / data.churn.base) / 10);
    expect(csv).toContain(`Health,Churn this month,${data.churn.ratePct}% (1 of ${data.churn.base}),`);
    expect(csv).toContain("New 1 · Rejoined 1 · Left 2 (cancelled 1, completed course 1) · Tasters added 1");
    expect(csv).toContain("Brought over by an import without dated history 1");
  });

  it("Analysis and the AI report: Joined equals the Reports tile, and the imported member is not a join (review 25 Oct)", async () => {
    members = CLUB;
    events = EVENTS;
    const [cur] = await loadJoinedInWindows(tx() as never, "club", NOW, [{ start: at(START), at: NOW }]);
    // Ana (new) + Cara (rejoined); Ivy's import-stamped join date and Ben the taster are not joins.
    expect(cur.joined).toBe(2);
    expect(cur.basis).toBe("recorded");
  });

  it("Members drill-throughs list exactly the members the tile counted, for the month in month=", async () => {
    members = CLUB;
    events = EVENTS;
    const movers = await loadMonthMovers(tx() as never, "club", NOW, { start: at(START), at: NOW });
    // Dan's course ended and Eve cancelled: both Left; only Eve's cancellation is churn (owner decision, 27 Oct 2026).
    expect(movers).toEqual({ new: ["ana"], rejoined: ["cara"], lost: ["dan", "eve"], tasterAdded: ["ben"], cancelled: ["eve"] });
    expect(monthDrillHref("rejoined-this-month", { monthKey: MONTH.monthKey } as never)).toBe(`/dashboard/members?filter=rejoined-this-month&month=${MONTH.monthKey}`);

    const moved = new Map<string, MemberRow["moved"]>();
    for (const [bucket, ids] of Object.entries(movers)) for (const id of ids) moved.set(id, [...(moved.get(id) ?? []), bucket as never]);
    const rows: MemberRow[] = CLUB.map((m) => ({
      id: m.id, name: m.name, email: m.email, membershipType: "Plan", status: m.status, accountType: "adult", paymentStatus: "paid",
      waiverAccepted: true, joinedAt: m.joinedAt.toISOString(), cancelledAt: m.cancelledAt?.toISOString() ?? null,
      ...(moved.has(m.id) ? { moved: moved.get(m.id) } : {}),
    }));
    const listed = (f: string) => rows.filter((r) => inStatusView(r, f as never)).map((r) => r.id);
    expect(listed("new-this-month")).toEqual(["ana"]);
    expect(listed("rejoined-this-month")).toEqual(["cara"]);
    expect(listed("lost-this-month")).toEqual(["dan", "eve"]);
    expect(listed("tasters-this-month")).toEqual(["ben"]);
    expect(listed("churned-this-month")).toEqual(["eve"]);
    // Ivy joined "this month" by joinedAt but was imported: in no slice.
    for (const f of ["new-this-month", "rejoined-this-month", "lost-this-month", "tasters-this-month"]) expect(listed(f)).not.toContain("ivy");

    const counts = { new: 1, rejoined: 1, lost: 2, tasterAdded: 1, cancelled: 1 };
    currentSearch = "filter=lost-this-month";
    render(<MembersList members={rows} primaryColor="#3b82f6" role="owner" movers={counts} monthWindow={{ ...MONTH, isCurrent: true }} />);
    expect(screen.getByTestId("members-headline").textContent).toBe("2 left this month");
    expect(screen.queryAllByText("Eve Cancelled").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Dan Course").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Ivy Imported")).toHaveLength(0);
  });
});
