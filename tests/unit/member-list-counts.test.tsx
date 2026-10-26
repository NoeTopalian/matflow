// @vitest-environment jsdom
//
// Review L5 (23 Oct 2026): the Members page's headline, tiles and chip counts
// are counted on the SERVER over the club's full population, so the 1,500-row
// display cap no longer shrinks them.
//
// 1. The server count builder (memberListCountWheres): for every total, the
//    Prisma where — evaluated with SQL's three-valued logic — selects exactly
//    the rows the browser predicate counts, over a fixture that crosses every
//    status, account type, payment status, due-date shape, billing source,
//    waiver, phone and visit state; and nothing from another tenant.
// 2. getMemberListCounts runs every where inside one tenant transaction.
// 3. MembersList given a truncated row array and the server totals shows the
//    server totals everywhere (headline, tiles, chips), and the notice says
//    the cap limits the list only.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { evalWhere, matchRows } from "./support/prisma-where-eval";

let txRows: Record<string, unknown>[] = [];
const txCalls: { tenantId: string; wheres: unknown[] }[] = [];
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(tenantId: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const call = { tenantId, wheres: [] as unknown[] };
    txCalls.push(call);
    return fn({
      member: {
        count: async (args: { where: Record<string, unknown> }) => {
          call.wheres.push(args.where);
          return matchRows(txRows, args.where).length;
        },
      },
    });
  },
}));

let currentSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/dashboard/members",
}));

import {
  MEMBER_LIST_COUNT_KEYS,
  countMemberRows,
  memberListCountWheres,
  type MemberListCounts,
} from "@/lib/member-list-counts";
import { getMemberListCounts } from "@/lib/member-list-counts-server";
import { clubMonthWindow } from "@/lib/club-month";
import { overdueClause, shownPaymentStatus } from "@/lib/overdue";
import MembersList, { type MemberRow } from "@/components/dashboard/MembersList";

const NOW = new Date("2026-10-23T10:00:00Z");
const MONTH = clubMonthWindow(NOW, "Europe/London");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

type DbRow = Record<string, unknown> & {
  id: string;
  tenantId: string;
  status: string;
  accountType: string;
  paymentStatus: string;
  nextDueAt: Date | null;
  stripeSubscriptionId: string | null;
  billedBy: string;
  waiverAccepted: boolean;
  phone: string | null;
  parentMemberId: string | null;
  joinedAt: Date;
  cancelledAt: Date | null;
  attendances: { checkInTime: Date }[];
};

/** Every combination that changes a count, for one tenant. */
function fixture(tenantId: string): DbRow[] {
  const rows: DbRow[] = [];
  let n = 0;
  const statuses = ["active", "inactive", "cancelled", "taster"];
  const types = ["adult", "kids", "parent"];
  const pays = ["paid", "overdue", "paused", "free", "pending", "cancelled"];
  const dues: (Date | null)[] = [null, ago(3), new Date(NOW.getTime() + 5 * DAY)];
  const billing: { stripeSubscriptionId: string | null; billedBy: string }[] = [
    { stripeSubscriptionId: null, billedBy: "matflow" },
    { stripeSubscriptionId: "sub_x", billedBy: "matflow" },
    { stripeSubscriptionId: null, billedBy: "teamup" },
  ];
  const visits: { joinedAt: Date; attendances: { checkInTime: Date }[] }[] = [
    { joinedAt: ago(100), attendances: [] }, // never visited, long joined: quiet if active+paid
    { joinedAt: ago(3), attendances: [] }, // never visited, new: not quiet (and joined this month)
    { joinedAt: ago(100), attendances: [{ checkInTime: ago(2) }, { checkInTime: ago(40) }] }, // recent visit
    { joinedAt: ago(100), attendances: [{ checkInTime: ago(14) }] }, // exactly 14 days: quiet
  ];
  for (const status of statuses)
    for (const accountType of types)
      for (const paymentStatus of pays)
        for (const nextDueAt of dues)
          for (const b of billing) {
            const v = visits[n % visits.length];
            n += 1;
            rows.push({
              id: `${tenantId}-${n}`,
              tenantId,
              status,
              accountType,
              paymentStatus,
              nextDueAt,
              ...b,
              waiverAccepted: n % 2 === 0,
              phone: n % 3 === 0 ? null : n % 3 === 1 ? "" : "+447700900123",
              parentMemberId: accountType === "kids" ? `${tenantId}-guardian` : null,
              joinedAt: v.joinedAt,
              cancelledAt: status === "cancelled" ? (n % 2 ? ago(2) : ago(60)) : null,
              attendances: v.attendances,
            });
          }
  return rows;
}

/** The row the Members page holds for a database row (app/dashboard/members/page.tsx mapping). */
function toListRow(r: DbRow): MemberRow {
  const lastVisit = r.attendances.map((a) => a.checkInTime.getTime()).sort((a, b) => b - a)[0];
  return {
    id: r.id,
    name: r.id,
    email: `${r.id}@example.test`,
    phone: r.phone,
    status: r.status,
    accountType: r.accountType,
    paymentStatus: shownPaymentStatus(r, NOW),
    waiverAccepted: r.waiverAccepted,
    parentMemberId: r.parentMemberId,
    joinedAt: r.joinedAt.toISOString(),
    cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
    lastVisitAt: lastVisit ? new Date(lastVisit).toISOString() : null,
  };
}

afterEach(() => {
  cleanup();
  txCalls.length = 0;
});

describe("memberListCountWheres — the server count builder", () => {
  const club = fixture("club-a");
  const other = fixture("club-b");
  const all = [...club, ...other];
  const wheres = memberListCountWheres("club-a", NOW, MONTH);
  const browser = countMemberRows(club.map(toListRow), NOW, MONTH);

  it("covers every total the page shows", () => {
    expect(Object.keys(wheres).sort()).toEqual([...MEMBER_LIST_COUNT_KEYS].sort());
    expect(club.length).toBeGreaterThan(600);
  });

  for (const key of MEMBER_LIST_COUNT_KEYS) {
    it(`${key}: the where (SQL semantics) counts what the browser predicate counts, and only this club`, () => {
      expect(wheres[key]).toMatchObject({ tenantId: "club-a" });
      const matched = matchRows(all, wheres[key]);
      expect(matched.every((r) => r.tenantId === "club-a")).toBe(true);
      expect(matched.length).toBe(browser[key]);
    });
  }

  it("the fixture is not degenerate: every total is non-zero and the totals differ", () => {
    for (const key of MEMBER_LIST_COUNT_KEYS) expect(browser[key], key).toBeGreaterThan(0);
    expect(new Set(Object.values(browser)).size).toBeGreaterThan(8);
  });

  it("why Paid is written positively: NOT (overdue) drops every paid member with no due date under SQL rules", () => {
    const paidNoDue = club.find((r) => r.status === "active" && r.paymentStatus === "paid" && r.nextDueAt === null && !r.stripeSubscriptionId && r.billedBy === "matflow")!;
    expect(evalWhere(paidNoDue, { paymentStatus: "paid", NOT: { OR: overdueClause(NOW) } })).toBe(null);
    expect(evalWhere(paidNoDue, wheres.paid)).toBe(true);
  });
});

describe("getMemberListCounts", () => {
  it("runs every count in ONE tenant transaction for the signed-in club, each where carrying its tenantId", async () => {
    txRows = [...fixture("club-a"), ...fixture("club-b")];
    const counts = await getMemberListCounts("club-a", NOW, MONTH);
    expect(txCalls).toHaveLength(1);
    expect(txCalls[0].tenantId).toBe("club-a");
    expect(txCalls[0].wheres).toHaveLength(MEMBER_LIST_COUNT_KEYS.length);
    for (const w of txCalls[0].wheres) expect(w).toMatchObject({ tenantId: "club-a" });
    expect(counts).toEqual(countMemberRows(fixture("club-a").map(toListRow), NOW, MONTH));
  });
});

describe("MembersList — totals independent of the row cap", () => {
  // 40 active members, 6 tasters, 4 cancelled; the page "loaded" only the
  // first 10 by name.
  const rows: MemberRow[] = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, name: `Active ${String(i).padStart(2, "0")}`, email: `a${i}@example.test`, status: "active", joinedAt: ago(100).toISOString(), paymentStatus: "paid", waiverAccepted: true, phone: "+447700900123", lastVisitAt: ago(1).toISOString() })),
    ...Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, name: `Taster ${i}`, email: `t${i}@example.test`, status: "taster", joinedAt: ago(3).toISOString(), waiverAccepted: true, phone: "+447700900123" })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, name: `Cancelled ${i}`, email: `c${i}@example.test`, status: "cancelled", joinedAt: ago(200).toISOString(), cancelledAt: ago(2).toISOString() })),
  ];
  const full: MemberListCounts = countMemberRows(rows, NOW, MONTH);
  const loaded = rows.slice(0, 10);

  it("the headline, the tiles and the chips show the full club's totals, not the loaded rows'", () => {
    currentSearch = "filter=active";
    render(<MembersList members={loaded} primaryColor="#3b82f6" role="owner" truncatedAt={10} serverCounts={full} monthWindow={{ ...MONTH, isCurrent: true }} />);
    expect(screen.getByTestId("members-headline").textContent).toBe("40 active members");
    expect(screen.getByTestId("members-tile-headline").querySelector("p")!.textContent).toBe("40");
    expect(screen.getByTestId("members-tile-tasters").querySelector("p")!.textContent).toBe("6");
    expect(screen.getByRole("button", { name: "Active · 40" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "All current · 46" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancelled · 4" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Every total on this page counts all of them");
    expect(screen.getByRole("status").textContent).toContain("the list and search show only the first 10 by name");
  });

  it("the drill-through slices use the server's month totals too", () => {
    currentSearch = "filter=churned-this-month";
    // The churn slice counts the server's movement replay (churned: active when the month began, then left).
    render(<MembersList members={loaded} primaryColor="#3b82f6" role="owner" truncatedAt={10} serverCounts={full} movers={{ new: 0, rejoined: 0, lost: 5, tasterAdded: 0, churned: 4 }} monthWindow={{ ...MONTH, isCurrent: true }} />);
    expect(screen.getByTestId("members-headline").textContent).toBe("4 churned this month");
  });

  it("without server totals (older callers) the counts still come from the rows", () => {
    currentSearch = "filter=active";
    render(<MembersList members={loaded} primaryColor="#3b82f6" role="owner" />);
    expect(screen.getByTestId("members-headline").textContent).toBe("10 active members");
  });
});
