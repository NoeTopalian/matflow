// @vitest-environment jsdom
//
// T2a Part U (owner decision Q4 A-3 option (c), 17 Oct 2026): the dashboard
// At-Risk tile, its to-do row and the named "Not seen in 14+ days" list are
// suppressed while the club has no MatFlow check-in. Imported attendance does
// not count (marker: checkInMethod <> 'import' AND importJobId IS NULL, the
// same one the attendance undo uses). The population is active TRAINING
// members, so guardian drafts can never appear.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/dashboard",
}));

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AT_RISK_LIST_TAKE,
  AT_RISK_SUPPRESSED_DETAIL,
  AT_RISK_SUPPRESSED_NOTE,
  AT_RISK_SUPPRESSED_TODO_NOTE,
  MATFLOW_CHECKIN_WHERE,
  atRiskMemberWhere,
  atRiskSuppressed,
  buildActionItems,
  readAtRisk,
  type ActionItemsInput,
  type AtRiskGateClient,
  type AtRiskReadClient,
} from "@/lib/dashboard-action-items";
import DashboardStats from "@/components/dashboard/DashboardStats";

type Row = { id: string; tenantId: string; checkInMethod: string; importJobId: string | null };

/** A fake client that applies the gate's `where` to fixture rows the way Postgres would. */
function fakeTx(rows: Row[]) {
  const calls: unknown[] = [];
  const tx: AtRiskGateClient = {
    attendanceRecord: {
      async findFirst(args) {
        calls.push(args);
        const { where } = args;
        const hit = rows.find(
          (r) =>
            r.tenantId === where.tenantId &&
            r.checkInMethod !== where.checkInMethod.not &&
            (where.importJobId === null ? r.importJobId === null : true),
        );
        return hit ? { id: hit.id } : null;
      },
    },
  };
  return { tx, calls };
}

const NOW = new Date("2026-10-17T12:00:00Z");
const LAPSED = [
  { id: "m1", name: "Alex Lapsed" },
  { id: "m2", name: "Sam Lapsed" },
];

function input(partial: Partial<ActionItemsInput>): ActionItemsInput {
  return { now: NOW, overdue: [], recentFailed: [], missingWaiver: [], atRisk: [], birthdayCandidates: [], ...partial };
}

const IMPORTED_ONLY: Row[] = [
  { id: "a1", tenantId: "t1", checkInMethod: "import", importJobId: "job-3-oct" },
  { id: "a2", tenantId: "t1", checkInMethod: "import", importJobId: "job-3-oct" },
  // Imported by an older importer that kept the source method: still imported.
  { id: "a3", tenantId: "t1", checkInMethod: "admin", importJobId: "job-3-oct" },
  // Another club's live check-in must not switch this club's tile on.
  { id: "b1", tenantId: "t2", checkInMethod: "kiosk", importJobId: null },
];

describe("At-Risk gate: no MatFlow check-ins", () => {
  it("is suppressed when every visit on record is imported", async () => {
    const { tx, calls } = fakeTx(IMPORTED_ONLY);
    expect(await atRiskSuppressed(tx, "t1")).toBe(true);
    // Tenant-scoped and uses the shared import marker.
    expect(calls).toEqual([{ where: { tenantId: "t1", ...MATFLOW_CHECKIN_WHERE }, select: { id: true } }]);
    expect(MATFLOW_CHECKIN_WHERE).toEqual({ checkInMethod: { not: "import" }, importJobId: null });
  });

  it("is suppressed for a club with no attendance at all", async () => {
    expect(await atRiskSuppressed(fakeTx([]).tx, "t1")).toBe(true);
  });

  it("drops every at-risk row from the named list even when members whose only visits are imported were passed in", () => {
    const items = buildActionItems(
      input({ atRisk: LAPSED, missingWaiver: [{ id: "w1", name: "Wendy" }], atRiskSuppressed: true }),
    );
    expect(items.filter((i) => i.kind === "retention")).toEqual([]);
    // Other signals are untouched.
    expect(items.map((i) => i.id)).toEqual(["admin-waiver-w1"]);
  });
});

describe("At-Risk gate: one MatFlow check-in", () => {
  it("is computed again after a single register tick", async () => {
    const rows = [...IMPORTED_ONLY, { id: "a9", tenantId: "t1", checkInMethod: "admin", importJobId: null }];
    expect(await atRiskSuppressed(fakeTx(rows).tx, "t1")).toBe(false);
  });

  it("lists the lapsed members when not suppressed", () => {
    const items = buildActionItems(input({ atRisk: LAPSED, atRiskSuppressed: false }));
    expect(items.filter((i) => i.kind === "retention").map((i) => i.memberId)).toEqual(["m1", "m2"]);
    expect(items[0].detail).toBe("Not seen in 14+ days");
  });
});

describe("At-Risk population: active training members only", () => {
  it("never counts parent/guardian accounts", () => {
    const where = atRiskMemberWhere("t1", NOW);
    expect(where.tenantId).toBe("t1");
    expect(where.status).toBe("active");
    expect(where.accountType).toEqual({ not: "parent" });
  });
});

const baseStats = {
  totalActive: 312,
  newThisMonth: 0,
  attendanceThisWeek: 0,
  attendanceThisMonth: 0,
  waiverMissing: 0,
  missingPhone: 0,
  paymentsDue: 0,
  atRiskMembers: 0,
};

function renderStats(stats: typeof baseStats & { atRiskSuppressed?: boolean }) {
  return render(
    <DashboardStats
      stats={stats}
      classes={[]}
      tenantName="Test Club"
      primaryColor="#3b82f6"
      userName="Owner Person"
      currentUserId="u1"
      currentUserRole="owner"
    />,
  );
}

describe("DashboardStats At-Risk tile", () => {
  it("shows the neutral line, no number, no to-do row and no Quiet link while suppressed", () => {
    // A stale count must not leak through if one is ever passed alongside the flag.
    const { container } = renderStats({ ...baseStats, atRiskMembers: 296, atRiskSuppressed: true });
    expect(screen.getByText(AT_RISK_SUPPRESSED_NOTE)).toBeTruthy();
    expect(screen.queryByText("296")).toBeNull();
    expect(screen.queryByText("Not seen in 14 days")).toBeNull();
    expect(screen.queryByText("Members not seen in 14 days")).toBeNull();
    expect(container.querySelector('a[href="/dashboard/members?filter=quiet"]')).toBeNull();
    // Nothing else is due, so the to-do panel is caught up, but it says
    // At-Risk is not yet known rather than implying it is zero (UI-RULES §7).
    expect(screen.getByText("All caught up — nothing to action.")).toBeTruthy();
    expect(screen.getByText(AT_RISK_SUPPRESSED_TODO_NOTE)).toBeTruthy();
  });

  it("drops the named 'Not seen in 14+ days' rows from the action list on the same flag", () => {
    const actionItems = buildActionItems(input({ atRisk: LAPSED, atRiskSuppressed: true }));
    render(
      <DashboardStats
        stats={{ ...baseStats, atRiskSuppressed: true }}
        classes={[]}
        tenantName="Test Club"
        primaryColor="#3b82f6"
        userName="Owner Person"
        currentUserId="u1"
        currentUserRole="owner"
        actionItems={actionItems}
      />,
    );
    expect(screen.queryByText("Not seen in 14+ days")).toBeNull();
    expect(screen.queryByText("Alex Lapsed")).toBeNull();
    expect(screen.queryByText("Sam Lapsed")).toBeNull();
  });

  it("shows the count, the to-do row and the Quiet link once the club has a MatFlow check-in", () => {
    const { container } = renderStats({ ...baseStats, atRiskMembers: 3, atRiskSuppressed: false });
    expect(screen.queryByText(AT_RISK_SUPPRESSED_NOTE)).toBeNull();
    expect(screen.queryByText(AT_RISK_SUPPRESSED_TODO_NOTE)).toBeNull();
    expect(screen.getByText("Not seen in 14 days")).toBeTruthy();
    expect(screen.getByText("Members not seen in 14 days")).toBeTruthy();
    expect(container.querySelector('a[href="/dashboard/members?filter=quiet"]')).not.toBeNull();
  });
});

/** A read client whose member queries throw unless the test allows them. */
function readTx(rows: Row[], member?: { count: number; list: { id: string; name: string }[] }) {
  const { tx: gate } = fakeTx(rows);
  const memberCalls: unknown[] = [];
  const tx: AtRiskReadClient = {
    ...gate,
    member: {
      async count(args) {
        memberCalls.push({ count: args });
        if (!member) throw new Error("member.count must not run while At-Risk is suppressed");
        return member.count;
      },
      async findMany(args) {
        memberCalls.push({ findMany: args });
        if (!member) throw new Error("member.findMany must not run while At-Risk is suppressed");
        return member.list;
      },
    },
  };
  return { tx, memberCalls };
}

describe("readAtRisk: one answer for the tile, the to-do row and the named list", () => {
  it("returns suppressed, count 0 and no names without running any member query", async () => {
    const { tx, memberCalls } = readTx(IMPORTED_ONLY);
    const read = await readAtRisk(tx, "t1", NOW);
    expect(read).toEqual({ suppressed: true, count: 0, members: [] });
    expect(memberCalls).toEqual([]);
    // Fed to the builder the way the page does, the named list is empty.
    const items = buildActionItems(input({ atRisk: read.members, atRiskSuppressed: read.suppressed }));
    expect(items.filter((i) => i.kind === "retention")).toEqual([]);
  });

  it("reads the count and the names from the same predicate once a MatFlow check-in exists", async () => {
    const rows = [...IMPORTED_ONLY, { id: "a9", tenantId: "t1", checkInMethod: "kiosk", importJobId: null }];
    const { tx, memberCalls } = readTx(rows, { count: 2, list: LAPSED });
    const read = await readAtRisk(tx, "t1", NOW);
    expect(read).toEqual({ suppressed: false, count: 2, members: LAPSED });
    const where = atRiskMemberWhere("t1", NOW);
    expect(memberCalls).toEqual([
      { count: { where } },
      { findMany: { where, select: { id: true, name: true }, take: AT_RISK_LIST_TAKE } },
    ]);
  });
});

describe("dashboard page wiring", () => {
  // The page is an async server component that needs a session and a database,
  // so its wiring is pinned at source level: At-Risk is read once by
  // readAtRisk and that one value reaches both the stats tile and the list.
  const src = readFileSync(path.join(process.cwd(), "app/dashboard/page.tsx"), "utf8");

  it("reads At-Risk exactly once and hands the same value to getStats and getActionItems", () => {
    expect(src.match(/readAtRisk\(/g)).toHaveLength(1);
    expect(src).toMatch(/const atRisk = await readAtRisk\(tx, session!\.user\.tenantId, new Date\(\)\);/);
    expect(src).toMatch(/getStats\(tx, session!\.user\.tenantId, atRisk\)/);
    expect(src).toMatch(/getActionItems\(tx, session!\.user\.tenantId, atRisk\)/);
  });

  it("takes the tile and the list from that value, with no second at-risk query", () => {
    expect(src).not.toMatch(/atRiskMemberWhere/);
    expect(src).not.toMatch(/atRiskSuppressed\(/);
    expect(src).toMatch(/atRiskMembers: atRisk\.count/);
    expect(src).toMatch(/atRiskSuppressed: atRisk\.suppressed/g);
    expect(src.match(/atRiskSuppressed: atRisk\.suppressed/g)).toHaveLength(2);
    expect(src).toMatch(/atRisk: atRisk\.members/);
  });
});

describe("suppressed copy names the real trigger", () => {
  it("speaks of a check-in recorded in MatFlow, not only a register", () => {
    // Any non-import row lifts the gate: register, kiosk, QR, self or auto check-in.
    expect(AT_RISK_SUPPRESSED_NOTE).toBe("Starts after the first check-in recorded in MatFlow");
    expect(AT_RISK_SUPPRESSED_NOTE).not.toMatch(/register/i);
    expect(AT_RISK_SUPPRESSED_TODO_NOTE).toMatch(/first check-in recorded in MatFlow/);
  });

  it("describes the suppression, not a permanent exclusion of imported visits", () => {
    // Once lifted, imported visits still count as visits (residual U2).
    expect(AT_RISK_SUPPRESSED_DETAIL).not.toMatch(/not counted/i);
    expect(AT_RISK_SUPPRESSED_DETAIL).toMatch(/^Hidden until then/);
  });
});
