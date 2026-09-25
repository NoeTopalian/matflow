// @vitest-environment jsdom
// NetNewMembersCard: the view switch (three pressed-state buttons), the
// subtitle that follows the view, the per-viewer memory in localStorage that
// must never break the render when storage throws, the honest empty state,
// and the tokens-only rule for the two new files (UI-RULES §2/§11).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import NetNewMembersCard, { NET_NEW_VIEW_STORAGE_KEY, resetNetNewViewCache } from "@/components/dashboard/NetNewMembersCard";

// recharts measures its container; jsdom has no layout, so the chart body is
// replaced by a marker that records which chart type was asked for.
vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    ResponsiveContainer: Pass,
    BarChart: ({ children }: { children?: React.ReactNode }) => <div data-chart="bar">{children}</div>,
    ComposedChart: ({ children }: { children?: React.ReactNode }) => <div data-chart="composed">{children}</div>,
    Bar: () => null, Area: () => null, Line: () => null, XAxis: () => null, YAxis: () => null,
    CartesianGrid: () => null, Tooltip: () => null, ReferenceLine: (p: { y: number }) => <span data-reference-line={p.y} />,
  };
});

const rows = [
  { month: "Apr", joined: 5, cancelled: 2, net: 3 },
  { month: "May", joined: 1, cancelled: 4, net: -3 },
];

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
  it("offers three views, Bars pressed by default, and the subtitle names the view", () => {
    render(<NetNewMembersCard rows={rows} />);
    const group = screen.getByRole("group", { name: "Net new members view" });
    const buttons = ["Bars", "Net line", "Running total"].map((n) => screen.getByRole("button", { name: n }));
    expect(group).toBeTruthy();
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1].getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Joined vs cancelled per month, last 6 months")).toBeTruthy();
    expect(screen.getByTestId("net-new-chart").getAttribute("data-view")).toBe("bars");
  });

  it("switching to the net line draws the composed chart with a zero reference line, flips aria-pressed and the subtitle, and remembers the choice", async () => {
    render(<NetNewMembersCard rows={rows} />);
    fireEvent.click(screen.getByRole("button", { name: "Net line" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Net line" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByRole("button", { name: "Bars" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Net change per month, against zero")).toBeTruthy();
    expect(screen.getByTestId("net-new-chart").getAttribute("data-view")).toBe("net");
    expect(document.querySelector("[data-chart='composed']")).toBeTruthy();
    expect(document.querySelector("[data-reference-line='0']")).toBeTruthy();
    expect(storage.setItem).toHaveBeenCalledWith(NET_NEW_VIEW_STORAGE_KEY, "net");
  });

  it("reads a remembered view back after mount, and ignores a value it does not know", async () => {
    storage = storageMock({ [NET_NEW_VIEW_STORAGE_KEY]: "running" });
    Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
    render(<NetNewMembersCard rows={rows} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Running total" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByText("Running total of net change, from zero")).toBeTruthy();

    resetNetNewViewCache();
    storage = storageMock({ [NET_NEW_VIEW_STORAGE_KEY]: "pie" });
    Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
    const second = render(<NetNewMembersCard rows={rows} />);
    await waitFor(() => expect(second.container.querySelector("[data-view]")?.getAttribute("data-view")).toBe("bars"));
  });

  it("renders, switches and keeps working when localStorage throws", async () => {
    resetNetNewViewCache();
    storage = storageMock({}, true);
    Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
    render(<NetNewMembersCard rows={rows} />);
    fireEvent.click(screen.getByRole("button", { name: "Running total" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Running total" }).getAttribute("aria-pressed")).toBe("true"));
  });

  it("shows the honest empty frame, not an empty chart, when nothing moved", () => {
    render(<NetNewMembersCard rows={[{ month: "Sep", joined: 0, cancelled: 0, net: 0 }]} />);
    expect(screen.getByText("No membership movement data yet")).toBeTruthy();
    expect(screen.queryByTestId("net-new-chart")).toBeNull();
    // The switch is still offered: the view is a preference, not a data state.
    expect(screen.getByRole("group", { name: "Net new members view" })).toBeTruthy();
  });
});

describe("tokens only, no hex literals (UI-RULES §2/§11)", () => {
  for (const rel of ["components/dashboard/NetNewMembersCard.tsx", "components/dashboard/reports-primitives.tsx", "lib/net-new-series.ts"]) {
    it(`${rel} has no 6-digit hex literal`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src.match(/#[0-9a-fA-F]{6}\b/g) ?? []).toEqual([]);
    });
  }
});
