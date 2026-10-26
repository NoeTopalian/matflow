// @vitest-environment jsdom
// NetNewMembersCard (T8c): the view switch (Bars, Net line, Members), the
// subtitle that follows the view, the window/tally/definition above the
// chart, the zero-based labelled Members axis whose last point is today, the
// estimated caption, the per-viewer memory in localStorage that must never
// break the render when storage throws, the honest empty state, and the
// tokens-only rule (UI-RULES §2/§11).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import NetNewMembersCard, { NET_NEW_VIEW_STORAGE_KEY, resetNetNewViewCache } from "@/components/dashboard/NetNewMembersCard";
import { emptyMembershipReport, type MembershipReport } from "@/lib/membership-report";

// recharts measures its container; jsdom has no layout, so the chart body is
// replaced by markers that record which chart and which axis props were asked for.
vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    ResponsiveContainer: Pass,
    BarChart: ({ children }: { children?: React.ReactNode }) => <div data-chart="bar">{children}</div>,
    ComposedChart: ({ children }: { children?: React.ReactNode }) => <div data-chart="composed">{children}</div>,
    Bar: (p: { dataKey: string }) => <span data-bar={p.dataKey} />,
    Area: () => null,
    Line: (p: { dataKey: string }) => <span data-line={p.dataKey} />,
    XAxis: () => null,
    YAxis: (p: { domain?: [number, number]; label?: { value: string } }) => (
      <span data-y-domain={p.domain ? p.domain.join(",") : ""} data-y-label={p.label?.value ?? ""} />
    ),
    CartesianGrid: () => null,
    Tooltip: () => null,
    ReferenceLine: (p: { y: number }) => <span data-reference-line={p.y} />,
    ReferenceArea: (p: { x1: string; x2: string }) => <span data-estimated-band={`${p.x1}|${p.x2}`} />,
  };
});

function report(overrides: Partial<MembershipReport> = {}): MembershipReport {
  const base = emptyMembershipReport();
  const mv = (month: string, label: string, n: number, r: number, lc: number, lp: number, basis: "recorded" | "estimated" | "mixed", current = false) => ({
    month, label, new: n, rejoined: r, lostCancelled: lc, lostCompleted: lp, lost: lc + lp, net: n + r - lc - lp, imported: 0, otherIn: 0, otherOut: 0, tasterAdded: 0, basis, isCurrentMonth: current,
  });
  const hc = (month: string, label: string, headcount: number, basis: "recorded" | "estimated" | "mixed", current = false) => ({
    month, label, headcount, basis, isCurrentMonth: current, at: `${month}-28T00:00:00.000Z`,
  });
  return {
    ...base,
    boundary: "2026-10-03T11:39:57.000Z",
    window: { from: "Aug 26", to: "Oct 26", months: 3 },
    openingHeadcount: 38,
    movementsByMonth: [
      mv("2026-08", "Aug 26", 5, 0, 2, 0, "estimated"),
      mv("2026-09", "Sep 26", 1, 1, 3, 1, "estimated"),
      mv("2026-10", "Oct 26", 2, 0, 0, 0, "mixed", true),
    ],
    headcountByMonth: [
      hc("2026-08", "Aug 26", 41, "estimated"),
      hc("2026-09", "Sep 26", 39, "estimated"),
      hc("2026-10", "Oct 26", 41, "recorded", true),
    ],
    totals: { new: 8, rejoined: 1, lostCancelled: 5, lostCompleted: 1, lost: 6, net: 3, imported: 0, otherIn: 0, otherOut: 0, tasterAdded: 0 },
    historySource: "backfill",
    ...overrides,
  };
}

function storageMock(initial: Record<string, string> = {}, throwing = false) {
  const store = new Map(Object.entries(initial));
  const throwIf = () => { if (throwing) throw new Error("storage blocked"); };
  return {
    getItem: vi.fn((k: string) => { throwIf(); return store.get(k) ?? null; }),
    setItem: vi.fn((k: string, v: string) => { throwIf(); store.set(k, v); }),
    removeItem: vi.fn((k: string) => { store.delete(k); }),
    clear: vi.fn(() => store.clear()),
    key: vi.fn(), length: 0,
    _store: store,
  };
}

let storage: ReturnType<typeof storageMock>;
beforeEach(() => {
  resetNetNewViewCache();
  storage = storageMock();
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
});

describe("NetNewMembersCard", () => {
  it("offers Bars, Net line and Members, Bars pressed by default, and the subtitle names the view", () => {
    render(<NetNewMembersCard membership={report()} />);
    const group = screen.getByRole("group", { name: "Net new members view" });
    const buttons = ["Bars", "Net line", "Members"].map((n) => screen.getByRole("button", { name: n }));
    expect(group).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Running total" })).toBeNull();
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1].getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Joined vs lost per month")).toBeTruthy();
    expect(screen.getByTestId("net-new-chart").getAttribute("data-view")).toBe("bars");
    expect(document.querySelector("[data-bar='joined']")).toBeTruthy();
    expect(document.querySelector("[data-bar='lost']")).toBeTruthy();
  });

  it("shows the window, the tally (new, rejoined, lost with its split, net), today's members and the definition — not just a signed number", () => {
    render(<NetNewMembersCard membership={report()} />);
    const tally = screen.getByTestId("net-new-tally").textContent ?? "";
    expect(tally).toContain("Aug 26 – Oct 26");
    expect(tally).toMatch(/8 new · 1 rejoined · 6 left \(5 cancelled, 1 completed course\) · net \+3 · 0 tasters added/);
    expect(tally).toContain("41 active members today");
    expect(screen.getByTestId("net-new-definition").textContent).toMatch(/New: first ever start\. Rejoined: started again after leaving\. Joined = new \+ rejoined\. Left: cancelled, or finished a prepaid course\. Net = new \+ rejoined − left\. Tasters added are counted apart, and imports are never joins\./);
  });

  it("a period that ended before this month names its last month, never 'today' (review 26 Oct 2026)", () => {
    const past = report();
    past.headcountByMonth = past.headcountByMonth.map((h) => ({ ...h, isCurrentMonth: false }));
    past.reconciled = 2;
    render(<NetNewMembersCard membership={past} />);
    const tally = screen.getByTestId("net-new-tally").textContent ?? "";
    expect(tally).toContain("41 active members at the end of Oct 26");
    expect(tally).not.toContain("today");
    // The reconciliation is today's correction, not part of a past window.
    expect(document.body.textContent).not.toContain("did not match their current status");
  });

  it("marks months before the first recorded event as estimated from TeamUp history, and carries the deletion caveat", () => {
    render(<NetNewMembersCard membership={report()} />);
    expect(screen.getByTestId("net-new-estimated").textContent).toMatch(/^Estimated from your TeamUp history: months before 3 Oct 2026/);
    expect(document.querySelector("[data-estimated-band='Aug 26|Sep 26']")).toBeTruthy();
    expect(screen.getByTestId("net-new-notes").textContent).toContain("Members deleted from MatFlow are not in past months.");
  });

  it("names what the estimate came from: join and cancellation dates for a club without TeamUp history", () => {
    render(<NetNewMembersCard membership={report({ historySource: "none", fromJoinDates: 6 })} />);
    const note = screen.getByTestId("net-new-estimated").textContent ?? "";
    expect(note).toMatch(/^Estimated from join and cancellation dates: months before 3 Oct 2026/);
    expect(note).not.toContain("TeamUp");
  });

  it("the line views run the estimated band to the next month's point, so one estimated month is never a zero-width band", async () => {
    render(<NetNewMembersCard membership={report()} />);
    // Bars (band scale): the band covers the estimated months whole.
    expect(document.querySelector("[data-estimated-band='Aug 26|Sep 26']")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Members" }).getAttribute("aria-pressed")).toBe("true"));
    expect(document.querySelector("[data-estimated-band='Aug 26|Oct 26']")).toBeTruthy();
  });

  it("says nothing is estimated when every month is recorded", () => {
    const r = report();
    render(
      <NetNewMembersCard
        membership={{
          ...r,
          movementsByMonth: r.movementsByMonth.map((m) => ({ ...m, basis: "recorded" as const })),
          headcountByMonth: r.headcountByMonth.map((m) => ({ ...m, basis: "recorded" as const })),
        }}
      />,
    );
    expect(screen.queryByTestId("net-new-estimated")).toBeNull();
    expect(document.querySelector("[data-estimated-band]")).toBeNull();
  });

  it("the Members view draws headcount on a zero-based, labelled axis", async () => {
    render(<NetNewMembersCard membership={report()} />);
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Members" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByText("Active members at month end, from zero")).toBeTruthy();
    expect(screen.getByTestId("net-new-chart").getAttribute("data-view")).toBe("members");
    expect(document.querySelector("[data-line='headcount']")).toBeTruthy();
    const y = document.querySelector("[data-y-domain]")!;
    expect(y.getAttribute("data-y-domain")?.split(",")[0]).toBe("0");
    expect(Number(y.getAttribute("data-y-domain")?.split(",")[1])).toBeGreaterThan(41);
    expect(y.getAttribute("data-y-label")).toBe("Active members");
    expect(storage.setItem).toHaveBeenCalledWith(NET_NEW_VIEW_STORAGE_KEY, "members");
  });

  it("switching to the net line draws the composed chart with a zero reference line", async () => {
    render(<NetNewMembersCard membership={report()} />);
    fireEvent.click(screen.getByRole("button", { name: "Net line" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Net line" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByText("Net change per month, against zero")).toBeTruthy();
    expect(document.querySelector("[data-chart='composed']")).toBeTruthy();
    expect(document.querySelector("[data-reference-line='0']")).toBeTruthy();
  });

  it("a remembered 'running' opens the Members view that replaced it; an unknown value falls back to Bars", async () => {
    storage = storageMock({ [NET_NEW_VIEW_STORAGE_KEY]: "running" });
    Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
    render(<NetNewMembersCard membership={report()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Members" }).getAttribute("aria-pressed")).toBe("true"));

    resetNetNewViewCache();
    storage = storageMock({ [NET_NEW_VIEW_STORAGE_KEY]: "pie" });
    Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
    const second = render(<NetNewMembersCard membership={report()} />);
    await waitFor(() => expect(second.container.querySelector("[data-view]")?.getAttribute("data-view")).toBe("bars"));
  });

  it("renders, switches and keeps working when localStorage throws", async () => {
    resetNetNewViewCache();
    storage = storageMock({}, true);
    Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
    render(<NetNewMembersCard membership={report()} />);
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Members" }).getAttribute("aria-pressed")).toBe("true"));
  });

  it("names imports and other changes beside the tally so the headcount adds up, and says when history was reconciled or undated", () => {
    render(
      <NetNewMembersCard
        membership={report({
          totals: { new: 8, rejoined: 1, lostCancelled: 5, lostCompleted: 1, lost: 6, net: 3, imported: 120, otherIn: 1, otherOut: 2, tasterAdded: 0 },
          reconciled: 3,
          undatedHistory: 4,
        })}
      />,
    );
    const other = screen.getByTestId("net-new-other-moves").textContent ?? "";
    expect(other).toContain("+120 brought over by an import without dated history");
    expect(other).toContain("+1 / −2 other changes");
    const notes = screen.getByTestId("net-new-notes").textContent ?? "";
    expect(notes).toContain("4 imported members have TeamUp history without dates");
    expect(notes).toContain("3 members' recorded history did not match their current status");
  });

  it("shows the honest empty frame, not an empty chart, when nothing moved and nobody is active", () => {
    const r = report();
    render(
      <NetNewMembersCard
        membership={{
          ...r,
          movementsByMonth: r.movementsByMonth.map((m) => ({ ...m, new: 0, rejoined: 0, lost: 0, lostCancelled: 0, lostCompleted: 0, net: 0 })),
          headcountByMonth: r.headcountByMonth.map((m) => ({ ...m, headcount: 0 })),
        }}
      />,
    );
    expect(screen.getByText("No membership movement data yet")).toBeTruthy();
    expect(screen.queryByTestId("net-new-chart")).toBeNull();
    // The empty state stands alone: no zero tally, definition or caveats around it.
    expect(screen.queryByTestId("net-new-tally")).toBeNull();
    expect(screen.queryByTestId("net-new-definition")).toBeNull();
    expect(screen.queryByTestId("net-new-notes")).toBeNull();
    // The switch is still offered: the view is a preference, not a data state.
    expect(screen.getByRole("group", { name: "Net new members view" })).toBeTruthy();
  });
});

describe("tokens only, no hex literals (UI-RULES §2/§11)", () => {
  for (const rel of [
    "components/dashboard/NetNewMembersCard.tsx",
    "components/dashboard/reports-primitives.tsx",
    "lib/net-new-series.ts",
    "lib/membership-movement.ts",
  ]) {
    it(`${rel} has no 6-digit hex literal`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src.match(/#[0-9a-fA-F]{6}\b/g) ?? []).toEqual([]);
    });
  }
});
