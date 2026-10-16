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

import {
  AT_RISK_SUPPRESSED_NOTE,
  MATFLOW_CHECKIN_WHERE,
  atRiskMemberWhere,
  atRiskSuppressed,
  buildActionItems,
  type ActionItemsInput,
  type AtRiskGateClient,
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
    // Nothing else is due, so the to-do panel is honestly caught up.
    expect(screen.getByText("All caught up — nothing to action.")).toBeTruthy();
  });

  it("shows the count, the to-do row and the Quiet link once the club has a MatFlow check-in", () => {
    const { container } = renderStats({ ...baseStats, atRiskMembers: 3, atRiskSuppressed: false });
    expect(screen.queryByText(AT_RISK_SUPPRESSED_NOTE)).toBeNull();
    expect(screen.getByText("Not seen in 14 days")).toBeTruthy();
    expect(screen.getByText("Members not seen in 14 days")).toBeTruthy();
    expect(container.querySelector('a[href="/dashboard/members?filter=quiet"]')).not.toBeNull();
  });
});
