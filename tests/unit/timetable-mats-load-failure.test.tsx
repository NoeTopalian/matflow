// @vitest-environment jsdom
//
// The mats could not be read (plan §4.14). They are read apart from the
// classes, in their own transaction, so a failed mats statement can never
// blank the timetable: the classes still render, split by time, with one line
// that says so and a way to try again. Proved here; there is no fault switch
// in production code.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import { weekChips, weekDay } from "./helpers/week";
import { PROPS, cls, stubFetch } from "./helpers/timetable-fixture";

const { refresh, toast, tenantTx } = vi.hoisted(() => ({ refresh: vi.fn(), toast: vi.fn(), tenantTx: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/prisma-tenant", () => ({ withTenantContext: (tenantId: string, fn: (tx: unknown) => unknown) => tenantTx(tenantId, fn) }));

import { readMatsForTimetable } from "@/lib/mats-store";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 5, 10, 0));
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The SQL text of each $executeRaw tagged-template call, in order. */
function executed(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?"));
}

describe("readMatsForTimetable", () => {
  it("returns the club's mats in order and the stored choice, inside a savepoint of the page's transaction", async () => {
    const findMany = vi.fn(async () => [{ id: "m1", name: "Mat 1", nameKey: "mat 1", sortOrder: 0 }, { id: "m2", name: "Mat 2", nameKey: "mat 2", sortOrder: 1 }]);
    const findFirst = vi.fn(async () => ({ timetableLayout: "time" }));
    const $executeRaw = vi.fn(async () => 0);
    expect(await readMatsForTimetable({ mat: { findMany }, tenant: { findFirst }, $executeRaw } as never, "t1")).toEqual({
      mats: [{ id: "m1", name: "Mat 1" }, { id: "m2", name: "Mat 2" }],
      storedLayout: "time",
      failed: false,
    });
    expect(executed($executeRaw)).toEqual(["SAVEPOINT timetable_mats", "RELEASE SAVEPOINT timetable_mats"]);
    // It opens no transaction of its own (S3: it runs in the page's one transaction).
    expect(tenantTx).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1" } }));
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "t1" }, select: { timetableLayout: true } });
  });

  it("reads a value it does not know as nobody having chosen", async () => {
    const tx = { mat: { findMany: async () => [] }, tenant: { findFirst: async () => ({ timetableLayout: "grid" }) }, $executeRaw: vi.fn(async () => 0) };
    expect((await readMatsForTimetable(tx as never, "t1")).storedLayout).toBeNull();
  });

  it("answers a failed read with no mats, no choice and the flag, and rolls back to its savepoint so the transaction goes on", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const $executeRaw = vi.fn(async () => 0);
    const findMany = vi.fn(async () => {
      throw new Error("relation \"Mat\" does not exist");
    });
    const tx = { mat: { findMany }, tenant: { findFirst: vi.fn() }, $executeRaw };
    expect(await readMatsForTimetable(tx as never, "t1")).toEqual({ mats: [], storedLayout: null, failed: true });
    expect(executed($executeRaw)).toEqual(["SAVEPOINT timetable_mats", "ROLLBACK TO SAVEPOINT timetable_mats"]);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("throws when even the rollback to its savepoint fails: the transaction cannot answer anything else", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const gone = new Error("Connection terminated unexpectedly");
    const $executeRaw = vi.fn(async (s: TemplateStringsArray) => {
      if (s.join("?").startsWith("ROLLBACK")) throw gone;
      return 0;
    });
    const findMany = vi.fn(async () => {
      throw new Error("boom");
    });
    const tx = { mat: { findMany }, tenant: { findFirst: vi.fn() }, $executeRaw };
    await expect(readMatsForTimetable(tx as never, "t1")).rejects.toBe(gone);
    logged.mockRestore();
  });
});

describe("the timetable when the mats could not be loaded", () => {
  const classes = () => [
    cls("Gi", "Mat 1", [[1, "18:40", "19:30"]], { matId: "m1" }),
    cls("No-Gi", "Mat 2", [[1, "18:40", "19:30"]], { matId: "m2" }),
  ];

  it("still shows every class, split by time, with one line that says so", () => {
    const { container } = render(<TimetableManager initialClasses={classes()} matsLoadFailed {...PROPS} />);
    expect(weekChips(weekDay(container, "mon")).map((c) => c.getAttribute("aria-label"))).toEqual([
      "Edit Gi, Monday 18:40 to 19:30, Mat 1",
      "Edit No-Gi, Monday 18:40 to 19:30, Mat 2",
    ]);
    expect(screen.getByTestId("week-grid").getAttribute("data-mats")).toBeNull();
    const line = screen.getByTestId("timetable-mats-load-failed");
    expect(line.getAttribute("role")).toBe("alert");
    expect(line.textContent).toContain("Couldn’t load the mats, so this is split by time.");
  });

  it("offers Try again, which asks the server for the page afresh", () => {
    render(<TimetableManager initialClasses={classes()} matsLoadFailed {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("offers neither the split control nor the Mats button, which could only mislead", () => {
    render(<TimetableManager initialClasses={classes()} matsLoadFailed {...PROPS} />);
    expect(screen.queryByTestId("timetable-split")).toBeNull();
    expect(screen.queryByTestId("timetable-mats")).toBeNull();
    expect(screen.queryByTestId("timetable-mats-phone")).toBeNull();
  });

  it("the class form keeps a class's mat untouched: it shows the typed-place form and names no mat on save", () => {
    render(<TimetableManager initialClasses={classes()} matsLoadFailed {...PROPS} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Gi/ })[0]);
    expect(screen.queryByLabelText("Mat")).toBeNull();
    expect((screen.getByLabelText("Location") as HTMLInputElement).value).toBe("Mat 1");
  });

  it("a refresh whose mats read fails, and the one after that succeeds, announce no change of split", () => {
    const MATS = [{ id: "m1", name: "Mat 1" }, { id: "m2", name: "Mat 2" }];
    const view = render(<TimetableManager initialClasses={classes()} mats={MATS} {...PROPS} />);
    expect(screen.getByTestId("week-grid").getAttribute("data-mats")).toBe("true");
    view.rerender(<TimetableManager initialClasses={classes()} matsLoadFailed {...PROPS} />);
    expect(screen.getByTestId("week-grid").getAttribute("data-mats")).toBeNull();
    view.rerender(<TimetableManager initialClasses={classes()} mats={MATS} {...PROPS} />);
    expect(screen.getByTestId("week-grid").getAttribute("data-mats")).toBe("true");
    expect(toast.mock.calls.filter(([text]) => /now split by/.test(String(text)))).toEqual([]);
  });

  it("says nothing of the kind when the mats loaded", () => {
    render(<TimetableManager initialClasses={classes()} mats={[{ id: "m1", name: "Mat 1" }, { id: "m2", name: "Mat 2" }]} {...PROPS} />);
    expect(screen.queryByTestId("timetable-mats-load-failed")).toBeNull();
  });
});
