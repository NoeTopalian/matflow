// @vitest-environment jsdom
//
// T2a Part U (agent default adopted 17 Oct 2026; not an owner decision),
// extended 24 Oct 2026 for sparse check-ins after an import. The dashboard
// At-Risk tile, its to-do row and the named "Not seen in 14+ days" list are
// shown only once MatFlow has been the club's register for the whole 14-day
// window: a check-in recorded in MatFlow before the window starts, and MatFlow
// check-ins in each 7-day half of it. Imported attendance (marker:
// checkInMethod <> 'import' AND importJobId IS NULL is a MatFlow check-in, the
// same one the attendance undo uses) never opens the gate, but once it is open
// imported visits count as visits. The population is active TRAINING members,
// so guardian drafts can never appear.
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
  atRiskClosedCopy,
  atRiskMemberWhere,
  atRiskSuppressed,
  buildActionItems,
  readAtRisk,
  readAtRiskGate,
  type ActionItemsInput,
  type AtRiskGateClient,
  type AtRiskReadClient,
  type AtRiskWhere,
} from "@/lib/dashboard-action-items";
import DashboardStats from "@/components/dashboard/DashboardStats";

const NOW = new Date("2026-10-24T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

type Row = {
  id: string;
  tenantId: string;
  memberId: string;
  checkInMethod: string;
  importJobId: string | null;
  checkInTime: Date;
};

let seq = 0;
function visit(memberId: string, ago: number, kind: "import" | "matflow", tenantId = "t1"): Row {
  seq += 1;
  return {
    id: `r${seq}`,
    tenantId,
    memberId,
    checkInMethod: kind === "import" ? "import" : "kiosk",
    importJobId: kind === "import" ? "job-teamup" : null,
    checkInTime: daysAgo(ago),
  };
}

type Member = { id: string; name: string; tenantId: string; status: string; accountType: string; joinedAt: Date };

/**
 * A fake client that applies the gate's and the predicate's `where` to fixture
 * rows the way Postgres would, so the tests exercise the real rule rather than
 * a hard-coded answer.
 */
function fakeTx(rows: Row[], members: Member[] = []) {
  const gateCalls: unknown[] = [];
  const memberCalls: unknown[] = [];
  const gate: AtRiskGateClient = {
    attendanceRecord: {
      async findFirst(args) {
        gateCalls.push(args);
        const { where, orderBy } = args;
        const hits = rows
          .filter(
            (r) =>
              r.tenantId === where.tenantId &&
              r.checkInMethod !== where.checkInMethod.not &&
              (where.importJobId === null ? r.importJobId === null : true) &&
              (where.checkInTime.lt === undefined || r.checkInTime < where.checkInTime.lt) &&
              (where.checkInTime.gte === undefined || r.checkInTime >= where.checkInTime.gte),
          )
          .sort((a, b) => a.checkInTime.getTime() - b.checkInTime.getTime());
        if (orderBy?.checkInTime === "desc") hits.reverse();
        return hits[0] ? { checkInTime: hits[0].checkInTime } : null;
      },
    },
  };
  const matches = (where: AtRiskWhere) => {
    const since = where.attendances.none.checkInTime.gte;
    const joinedBefore = where.OR[0].joinedAt!.lt;
    return members.filter((m) => {
      const mine = rows.filter((r) => r.memberId === m.id && r.tenantId === m.tenantId);
      return (
        m.tenantId === where.tenantId &&
        m.status === where.status &&
        m.accountType !== where.accountType.not &&
        !mine.some((r) => r.checkInTime >= since) &&
        (m.joinedAt < joinedBefore || mine.length > 0)
      );
    });
  };
  const tx: AtRiskReadClient = {
    ...gate,
    member: {
      async count(args) {
        memberCalls.push({ count: args });
        return matches(args.where).length;
      },
      async findMany(args) {
        memberCalls.push({ findMany: args });
        return matches(args.where).slice(0, args.take).map(({ id, name }) => ({ id, name }));
      },
    },
  };
  return { tx, gateCalls, memberCalls };
}

function member(id: string, name: string, joinedDaysAgo = 400, extra: Partial<Member> = {}): Member {
  return { id, name, tenantId: "t1", status: "active", accountType: "adult", joinedAt: daysAgo(joinedDaysAgo), ...extra };
}

function input(partial: Partial<ActionItemsInput>): ActionItemsInput {
  return { now: NOW, overdue: [], recentFailed: [], missingWaiver: [], atRisk: [], birthdayCandidates: [], ...partial };
}

/** A club fresh off TeamUp: two years of imported visits that stop at the export, 30 days ago. */
const MEMBERS = [member("m1", "Alex Regular"), member("m2", "Sam Regular"), member("m3", "Jo Regular"), member("m4", "Lee Lapsed")];
function importedHistory(exportDaysAgo: number): Row[] {
  const rows: Row[] = [];
  for (const m of ["m1", "m2", "m3"]) for (let d = exportDaysAgo; d < exportDaysAgo + 60; d += 3) rows.push(visit(m, d, "import"));
  // Lee stopped coming long before the export.
  rows.push(visit("m4", exportDaysAgo + 60, "import"));
  // An older importer kept the source method: still imported (importJobId set).
  rows.push({ ...visit("m1", exportDaysAgo + 1, "import"), checkInMethod: "admin" });
  // Another club's live check-in must not open this club's gate.
  rows.push(visit("x1", 1, "matflow", "t2"));
  return rows;
}

describe("At-Risk gate: no MatFlow check-ins", () => {
  it("stays closed ('none') when every visit on record is imported", async () => {
    const { tx, gateCalls } = fakeTx(importedHistory(3));
    expect(await readAtRiskGate(tx, "t1", NOW)).toEqual({ open: false, reason: "none" });
    expect(await atRiskSuppressed(tx, "t1", NOW)).toBe(true);
    // Tenant-scoped and uses the shared import marker on every probe.
    for (const c of gateCalls as { where: Record<string, unknown> }[]) {
      expect(c.where).toMatchObject({ tenantId: "t1", ...MATFLOW_CHECKIN_WHERE });
    }
    expect(MATFLOW_CHECKIN_WHERE).toEqual({ checkInMethod: { not: "import" }, importJobId: null });
  });

  it("stays closed for a club with no attendance at all", async () => {
    expect(await readAtRiskGate(fakeTx([]).tx, "t1", NOW)).toEqual({ open: false, reason: "none" });
  });

  it("drops every at-risk row from the named list even when members were passed in", () => {
    const items = buildActionItems(
      input({ atRisk: [{ id: "m1", name: "Alex" }], missingWaiver: [{ id: "w1", name: "Wendy" }], atRiskSuppressed: true }),
    );
    expect(items.filter((i) => i.kind === "retention")).toEqual([]);
    expect(items.map((i) => i.id)).toEqual(["admin-waiver-w1"]);
  });
});

describe("At-Risk after the first MatFlow check-in", () => {
  it("one check-in today does not flag the whole club: the gate warms up for 14 days and no member query runs", async () => {
    // The import stopped 30 days ago; the earlier gate opened on this one row
    // and every member's last visit was already more than 14 days old.
    const rows = [...importedHistory(30), visit("m1", 0, "matflow")];
    const { tx, memberCalls } = fakeTx(rows, MEMBERS);

    // What the earlier gate would have shown: the whole club.
    const where = atRiskMemberWhere("t1", NOW);
    expect(await tx.member.count({ where })).toBe(3); // m2, m3, m4 — everyone but the one who checked in
    memberCalls.length = 0;

    const read = await readAtRisk(tx, "t1", NOW, "Europe/London");
    expect(read.suppressed).toBe(true);
    expect(read.count).toBe(0);
    expect(read.members).toEqual([]);
    expect(memberCalls).toEqual([]);
    // Starts 14 days after the first MatFlow check-in, said with the date.
    expect(read.copy?.note).toBe("Starts 7 Nov");
    expect(read.copy?.detail).toBe("Needs 14 days of check-ins recorded in MatFlow");
  });

  it("names the start date from the FIRST MatFlow check-in, not the latest", async () => {
    const rows = [...importedHistory(20), visit("m1", 10, "matflow"), visit("m2", 2, "matflow")];
    const gate = await readAtRiskGate(fakeTx(rows).tx, "t1", NOW);
    // 14 calendar days (setDate), so a clock change in between keeps the wall time.
    const startsAt = daysAgo(10);
    startsAt.setDate(startsAt.getDate() + 14);
    expect(gate).toEqual({ open: false, reason: "warming_up", startsAt });
  });

  it("sparse check-ins (one 20 days ago, none since) pause At-Risk instead of flagging everyone", async () => {
    const rows = [...importedHistory(25), visit("m1", 20, "matflow")];
    const { tx, memberCalls } = fakeTx(rows, MEMBERS);
    const read = await readAtRisk(tx, "t1", NOW);
    expect(read).toMatchObject({ suppressed: true, count: 0, members: [] });
    expect(read.copy?.note).toBe("Paused");
    expect(memberCalls).toEqual([]);
  });

  it("one stray check-in months ago does not open the gate early (review 25 Oct): it warms up from the restart", async () => {
    const rows = [...importedHistory(70), visit("m1", 60, "matflow")];
    for (let d = 0; d <= 8; d += 1) rows.push(visit("m2", d, "matflow"));
    const gate = await readAtRiskGate(fakeTx(rows).tx, "t1", NOW);
    const startsAt = daysAgo(8);
    startsAt.setDate(startsAt.getDate() + 14);
    expect(gate).toEqual({ open: false, reason: "warming_up", startsAt });
  });

  it("check-ins once, none for three weeks: paused, not 'none yet'", async () => {
    const rows = [...importedHistory(70), visit("m1", 40, "matflow"), visit("m2", 30, "matflow")];
    expect(await readAtRiskGate(fakeTx(rows).tx, "t1", NOW)).toEqual({ open: false, reason: "paused" });
  });

  it("a week with no MatFlow check-ins (a closure) pauses At-Risk", async () => {
    // Registers before the window and in the last 7 days, none in days 7–14.
    const rows = [...importedHistory(40), visit("m1", 30, "matflow"), visit("m1", 20, "matflow"), visit("m2", 3, "matflow")];
    expect(await readAtRiskGate(fakeTx(rows).tx, "t1", NOW)).toEqual({ open: false, reason: "paused" });
  });
});

describe("At-Risk once MatFlow has been the register for the whole window", () => {
  // Switched 30 days ago (export 31 days ago), registers taken every few days since.
  function switchedClub(extraRows: Row[] = [], extraMembers: Member[] = []) {
    const rows = [...importedHistory(31), ...extraRows];
    for (const d of [29, 22, 16, 12, 9, 5, 2]) rows.push(visit("m1", d, "matflow"));
    rows.push(visit("m2", 6, "matflow"));
    return fakeTx(rows, [...MEMBERS, ...extraMembers]);
  }

  it("opens, and flags only members with no visit — imported or MatFlow — in 14 days", async () => {
    const { tx, memberCalls } = switchedClub();
    expect(await readAtRiskGate(tx, "t1", NOW)).toEqual({ open: true });
    const read = await readAtRisk(tx, "t1", NOW);
    expect(read.suppressed).toBe(false);
    // m1 and m2 trained at MatFlow registers inside the window; m3's last
    // visit is imported, 31 days ago; Lee's is imported, 91 days ago.
    expect(read.members.map((m) => m.id).sort()).toEqual(["m3", "m4"]);
    expect(read.count).toBe(2);
    const where = atRiskMemberWhere("t1", NOW);
    expect(memberCalls).toEqual([
      { count: { where } },
      { findMany: { where, select: { id: true, name: true }, take: AT_RISK_LIST_TAKE } },
    ]);
  });

  it("a long-absent member whose only visits are imported is flagged", async () => {
    const { tx } = switchedClub([visit("m9", 200, "import")], [member("m9", "Pat Long-Gone", 800)]);
    const read = await readAtRisk(tx, "t1", NOW);
    expect(read.members.map((m) => m.id)).toContain("m9");
  });

  it("an imported visit inside the window counts as a visit", async () => {
    // A late import row (e.g. a refresh) dated 5 days ago keeps m3 off the list.
    const { tx } = switchedClub([visit("m3", 5, "import")]);
    const read = await readAtRisk(tx, "t1", NOW);
    expect(read.members.map((m) => m.id)).toEqual(["m4"]);
  });

  it("never flags a new joiner inside the window, or a guardian account", async () => {
    const { tx } = switchedClub([], [member("n1", "New Joiner", 3), member("g1", "Guardian Draft", 400, { accountType: "parent" })]);
    const ids = (await readAtRisk(tx, "t1", NOW)).members.map((m) => m.id);
    expect(ids).not.toContain("n1");
    expect(ids).not.toContain("g1");
  });

  it("lists the lapsed members when not suppressed", () => {
    const items = buildActionItems(input({ atRisk: [{ id: "m3", name: "Jo" }], atRiskSuppressed: false }));
    expect(items.filter((i) => i.kind === "retention").map((i) => i.memberId)).toEqual(["m3"]);
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
  totalActive: 40,
  newThisMonth: 0,
  attendanceThisWeek: 0,
  attendanceThisMonth: 0,
  waiverMissing: 0,
  missingPhone: 0,
  paymentsDue: 0,
  atRiskMembers: 0,
};

type Stats = typeof baseStats & { atRiskSuppressed?: boolean; atRiskCopy?: ReturnType<typeof atRiskClosedCopy> };

function renderStats(stats: Stats) {
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
    const { container } = renderStats({ ...baseStats, atRiskMembers: 29, atRiskSuppressed: true });
    expect(screen.getByText(AT_RISK_SUPPRESSED_NOTE)).toBeTruthy();
    expect(screen.queryByText("29")).toBeNull();
    expect(screen.queryByText("Not seen in 14 days")).toBeNull();
    expect(screen.queryByText("Members not seen in 14 days")).toBeNull();
    expect(container.querySelector('a[href="/dashboard/members?filter=quiet"]')).toBeNull();
    // At-Risk is not yet known rather than zero (UI-RULES §7).
    expect(screen.getByText("All caught up — nothing to action.")).toBeTruthy();
    expect(screen.getByText(AT_RISK_SUPPRESSED_TODO_NOTE)).toBeTruthy();
  });

  it("says when At-Risk starts while warming up", () => {
    const copy = atRiskClosedCopy({ open: false, reason: "warming_up", startsAt: new Date("2026-11-07T12:00:00Z") }, "Europe/London");
    renderStats({ ...baseStats, atRiskMembers: 29, atRiskSuppressed: true, atRiskCopy: copy });
    expect(screen.getByText("Starts 7 Nov")).toBeTruthy();
    expect(screen.getByText("Needs 14 days of check-ins recorded in MatFlow")).toBeTruthy();
    expect(screen.getByText("At-Risk members start on 7 Nov, after 14 days of check-ins recorded in MatFlow.")).toBeTruthy();
    expect(screen.queryByText("29")).toBeNull();
  });

  it("says why while paused", () => {
    renderStats({ ...baseStats, atRiskSuppressed: true, atRiskCopy: atRiskClosedCopy({ open: false, reason: "paused" }) });
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText("No check-ins recorded in MatFlow for a week of the last 14 days")).toBeTruthy();
  });

  it("drops the named 'Not seen in 14+ days' rows from the action list on the same flag", () => {
    const actionItems = buildActionItems(input({ atRisk: [{ id: "m1", name: "Alex Lapsed" }], atRiskSuppressed: true }));
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
  });

  it("shows the count, the to-do row and the Quiet link once the gate is open", () => {
    const { container } = renderStats({ ...baseStats, atRiskMembers: 3, atRiskSuppressed: false });
    expect(screen.queryByText(AT_RISK_SUPPRESSED_NOTE)).toBeNull();
    expect(screen.queryByText(AT_RISK_SUPPRESSED_TODO_NOTE)).toBeNull();
    expect(screen.getByText("Not seen in 14 days")).toBeTruthy();
    expect(screen.getByText("Members not seen in 14 days")).toBeTruthy();
    expect(container.querySelector('a[href="/dashboard/members?filter=quiet"]')).not.toBeNull();
  });
});

describe("dashboard page wiring", () => {
  // The page is an async server component that needs a session and a database,
  // so its wiring is pinned at source level: At-Risk is read once by
  // readAtRisk and that one value reaches both the stats tile and the list.
  const src = readFileSync(path.join(process.cwd(), "app/dashboard/page.tsx"), "utf8");

  it("reads At-Risk exactly once, in the club's zone, and hands the same value to getStats and getActionItems", () => {
    expect(src.match(/readAtRisk\(/g)).toHaveLength(1);
    expect(src).toMatch(/const atRisk = await readAtRisk\(tx, session!\.user\.tenantId, new Date\(\), club\?\.timezone\);/);
    // The viewer's role stays for the role-aware payments count (#39, round-3 review L5).
    expect(src).toMatch(/getStats\(tx, session!\.user\.tenantId, session!\.user\.role, atRisk\)/);
    expect(src).toMatch(/getActionItems\(tx, session!\.user\.tenantId, atRisk\)/);
  });

  it("takes the tile and the list from that value, with no second at-risk query", () => {
    expect(src).not.toMatch(/atRiskMemberWhere/);
    expect(src).not.toMatch(/atRiskSuppressed\(/);
    expect(src).not.toMatch(/readAtRiskGate\(/);
    expect(src).toMatch(/atRiskMembers: atRisk\.count/);
    expect(src).toMatch(/atRiskCopy: atRisk\.copy/);
    expect(src.match(/atRiskSuppressed: atRisk\.suppressed/g)).toHaveLength(2);
    expect(src).toMatch(/atRisk: atRisk\.members/);
  });
});

describe("closed-gate copy names the real trigger", () => {
  it("speaks of check-ins recorded in MatFlow, not only a register, and of the 14-day wait", () => {
    expect(AT_RISK_SUPPRESSED_NOTE).toBe("Starts 14 days after the first check-in recorded in MatFlow");
    expect(AT_RISK_SUPPRESSED_NOTE).not.toMatch(/register/i);
    expect(AT_RISK_SUPPRESSED_TODO_NOTE).toMatch(/14 days after the first check-in recorded in MatFlow/);
  });

  it("describes the wait, not a permanent exclusion of imported visits", () => {
    // Once open, imported visits still count as visits (residual U2).
    expect(AT_RISK_SUPPRESSED_DETAIL).not.toMatch(/not counted/i);
    expect(AT_RISK_SUPPRESSED_DETAIL).toMatch(/^Hidden until then/);
  });
});
