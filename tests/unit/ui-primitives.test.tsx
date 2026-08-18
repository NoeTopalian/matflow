// @vitest-environment jsdom
//
// Behaviour tests for the D2 UI primitives (docs/UI-RULES.md §4a.3, §5, §8).
// The accessibility contract is the point of these primitives, so it is what
// gets asserted: role/aria wiring, Escape, scrim click, focus trapping, the
// loading gate on a destructive confirm, and the DataTable's sort / empty /
// loading branches.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import React, { useState } from "react";

import { Dialog } from "@/components/ui/dialog";
import { Sheet } from "@/components/ui/sheet";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import {
  DataTable,
  compareValues,
  sortRows,
  nextSortState,
  type DataTableColumn,
} from "@/components/ui/data-table";
import { nextFocusTarget, getFocusable } from "@/components/ui/overlay";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

// ── Dialog ───────────────────────────────────────────────────────────────────

describe("Dialog", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
  });

  it("renders nothing when closed", () => {
    render(
      <Dialog open={false} onClose={() => {}} title="Remove member">
        body
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a modal dialog labelled by its title", () => {
    render(
      <Dialog open onClose={() => {}} title="Remove member" description="Cannot be undone.">
        body
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toBe("Remove member");

    const describedId = dialog.getAttribute("aria-describedby");
    expect(describedId).toBeTruthy();
    expect(document.getElementById(describedId!)?.textContent).toBe("Cannot be undone.");
  });

  it("omits aria-describedby when there is no description", () => {
    render(
      <Dialog open onClose={() => {}} title="Remove member">
        body
      </Dialog>,
    );
    expect(screen.getByRole("dialog").getAttribute("aria-describedby")).toBeNull();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Remove member">
        body
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a scrim click", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Remove member">
        body
      </Dialog>,
    );
    const scrim = document.querySelector('[data-slot="dialog-scrim"]');
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the panel itself is clicked", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Remove member">
        <p>body</p>
      </Dialog>,
    );
    fireEvent.click(screen.getByText("body"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("locks background scroll while open and releases it on close", () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onClose={() => setOpen(false)} title="Remove member">
          body
        </Dialog>
      );
    }
    render(<Harness />);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.body.style.overflow).toBe("");
  });

  it("moves focus into the panel on open", () => {
    render(
      <Dialog open onClose={() => {}} title="Remove member">
        body
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("traps Tab inside the panel", () => {
    render(
      <Dialog open onClose={() => {}} title="Remove member" footer={<button>Confirm</button>}>
        <button>Inner</button>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    const focusable = getFocusable(dialog);
    const last = focusable[focusable.length - 1];

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("renders a close button that calls onClose, and hides it when asked", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open onClose={onClose} title="Remove member">
        body
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <Dialog open onClose={onClose} title="Remove member" hideClose>
        body
      </Dialog>,
    );
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });
});

// ── Sheet ────────────────────────────────────────────────────────────────────

describe("Sheet", () => {
  it("shares the Dialog accessibility contract", () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="To-do list">
        items
      </Sheet>,
    );
    const sheet = screen.getByRole("dialog");
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(
      document.getElementById(sheet.getAttribute("aria-labelledby")!)?.textContent,
    ).toBe("To-do list");

    fireEvent.click(document.querySelector('[data-slot="sheet-scrim"]')!);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("clears the member bottom nav when asked", () => {
    render(
      <Sheet open onClose={() => {}} title="To-do list" navClearance="member-nav">
        items
      </Sheet>,
    );
    expect(screen.getByRole("dialog").className).toContain(
      "pb-[var(--member-nav-clearance)]",
    );
  });
});

// ── ConfirmDialog ────────────────────────────────────────────────────────────

describe("ConfirmDialog", () => {
  it("renders the caller's action label and the British default cancel", () => {
    render(
      <ConfirmDialog
        open
        onClose={() => {}}
        onConfirm={() => {}}
        title="Remove member"
        description="This cannot be undone."
        confirmLabel="Remove member"
        destructive
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove member" })).toBeTruthy();
    expect(screen.getByText("This cannot be undone.")).toBeTruthy();
  });

  it("disables the confirm button while loading", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        loading
        onClose={() => {}}
        onConfirm={onConfirm}
        title="Remove member"
        confirmLabel="Remove member"
      />,
    );
    const confirm = screen.getByRole("button", { name: "Remove member" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute("aria-busy")).toBe("true");

    // Cancel is disabled too — no bailing out mid-flight.
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("calls onConfirm on click and onClose on cancel", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        open
        onClose={onClose}
        onConfirm={onConfirm}
        title="Remove member"
        confirmLabel="Remove member"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove member" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows in-flight state for the duration of an async onConfirm", async () => {
    let resolveConfirm: () => void = () => {};
    const onConfirm = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    render(
      <ConfirmDialog
        open
        onClose={() => {}}
        onConfirm={onConfirm}
        title="Remove member"
        confirmLabel="Remove member"
      />,
    );
    const confirm = screen.getByRole("button", { name: "Remove member" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);

    fireEvent.click(confirm);
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute("aria-busy")).toBe("true");

    // A second click while in flight must not double-submit (UI-RULES §6).
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveConfirm();
    });
    expect(confirm.disabled).toBe(false);
  });

  it("gates the action behind typed confirmation", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onClose={() => {}}
        onConfirm={onConfirm}
        title="Delete gym"
        confirmLabel="Delete gym"
        destructive
        confirmPhrase="Total BJJ"
      />,
    );
    const confirm = screen.getByRole("button", { name: "Delete gym" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    const input = screen.getByLabelText("Type Total BJJ to confirm") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "wrong" } });
    expect(confirm.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "Total BJJ" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

// ── useConfirmDialog (the imperative half) ───────────────────────────────────
//
// The second, hand-rolled confirm primitive that used to own this hook was
// deleted on 2026-08-18 — it bypassed overlay.tsx's ref-counted scroll lock and
// Escape stack (see overlay-close-guards.test.tsx for the nesting proof). These
// assert the hook's contract survived the move onto Dialog: an awaiting caller
// always gets an answer, and never hangs.

describe("useConfirmDialog", () => {
  function Harness({ onAnswer }: { onAnswer: (value: boolean) => void }) {
    const { ask, dialogProps } = useConfirmDialog();
    return (
      <>
        <button
          onClick={() => {
            void ask({
              title: "Remove this photo?",
              body: "It will be deleted for you and for the gym. This cannot be undone.",
              confirmLabel: "Remove photo",
              destructive: true,
            }).then(onAnswer);
          }}
        >
          Delete
        </button>
        <ConfirmDialog {...dialogProps} />
      </>
    );
  }

  function askThen(onAnswer: (value: boolean) => void = vi.fn()) {
    render(<Harness onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  }

  it("renders nothing until ask() is called, then shows the question and its body copy", () => {
    render(<Harness onAnswer={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    // `body` is the hook's name for the prose; it lands on `description`.
    expect(
      screen.getByText(
        "It will be deleted for you and for the gym. This cannot be undone.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove photo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("resolves true on confirm and dismisses the dialog", async () => {
    const onAnswer = vi.fn();
    askThen(onAnswer);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    });
    expect(onAnswer).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resolves false on cancel", async () => {
    const onAnswer = vi.fn();
    askThen(onAnswer);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(onAnswer).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resolves false on Escape", async () => {
    const onAnswer = vi.fn();
    askThen(onAnswer);
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(onAnswer).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resolves false when the asking component unmounts, so the caller never hangs", async () => {
    const onAnswer = vi.fn();
    const { unmount } = render(<Harness onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    unmount();
    await act(async () => {});
    expect(onAnswer).toHaveBeenCalledWith(false);
  });

  it("gives a superseded question a clean no", async () => {
    const answers: boolean[] = [];
    render(<Harness onAnswer={(v) => answers.push(v)} />);
    const trigger = screen.getByRole("button", { name: "Delete" });

    fireEvent.click(trigger);
    await act(async () => {
      fireEvent.click(trigger); // second ask() supersedes the first
    });
    expect(answers).toEqual([false]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    });
    expect(answers).toEqual([false, true]);
  });

  it("defaults the action label to Confirm when the caller supplies none", () => {
    function Bare() {
      const { ask, dialogProps } = useConfirmDialog();
      return (
        <>
          <button onClick={() => void ask({ title: "Import 12 members?" })}>Ask</button>
          <ConfirmDialog {...dialogProps} />
        </>
      );
    }
    render(<Bare />);
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  });

  it("clears the member bottom nav when the caller asks from a member surface", () => {
    function MemberSurface() {
      const { ask, dialogProps } = useConfirmDialog();
      return (
        <>
          <button
            onClick={() =>
              void ask({
                title: "Remove this photo?",
                confirmLabel: "Remove photo",
                navClearance: "member-nav",
              })
            }
          >
            Delete
          </button>
          <ConfirmDialog {...dialogProps} />
        </>
      );
    }
    render(<MemberSurface />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog").className).toContain(
      "pb-[var(--member-nav-clearance)]",
    );
  });
});

// ── DataTable ────────────────────────────────────────────────────────────────

type Row = { id: string; name: string; owed: number };

const ROWS: Row[] = [
  { id: "b", name: "Beatriz", owed: 30 },
  { id: "a", name: "Ana", owed: 120 },
  { id: "c", name: "Caio", owed: 75 },
];

const COLUMNS: DataTableColumn<Row>[] = [
  { key: "name", header: "Name", cell: (r) => r.name, sortValue: (r) => r.name },
  {
    key: "owed",
    header: "Owed",
    align: "right",
    cell: (r) => `£${r.owed}`,
    sortValue: (r) => r.owed,
  },
  { key: "id", header: "Ref", cell: (r) => r.id },
];

function names(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1) // drop the header row
    .map((row) => row.querySelectorAll("td")[0]?.textContent ?? "");
}

describe("DataTable", () => {
  it("renders rows in source order until a column is sorted", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    expect(names()).toEqual(["Beatriz", "Ana", "Caio"]);
  });

  it("toggles sort direction on repeated header clicks", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    const header = screen.getByRole("button", { name: /Name/ });

    fireEvent.click(header);
    expect(names()).toEqual(["Ana", "Beatriz", "Caio"]);
    expect(screen.getByRole("columnheader", { name: /Name/ }).getAttribute("aria-sort")).toBe(
      "ascending",
    );

    fireEvent.click(header);
    expect(names()).toEqual(["Caio", "Beatriz", "Ana"]);
    expect(screen.getByRole("columnheader", { name: /Name/ }).getAttribute("aria-sort")).toBe(
      "descending",
    );
  });

  it("starts a newly-picked column ascending", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    fireEvent.click(screen.getByRole("button", { name: /Owed/ }));
    expect(names()).toEqual(["Beatriz", "Caio", "Ana"]);
  });

  it("leaves non-sortable columns without a sort control", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    expect(screen.queryByRole("button", { name: /Ref/ })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Ref" }).getAttribute("aria-sort")).toBeNull();
  });

  it("renders the EmptyState primitive when there are no rows", () => {
    render(<DataTable columns={COLUMNS} rows={[]} rowKey={(r) => r.id} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("Nothing to show yet")).toBeTruthy();
  });

  it("accepts a custom empty slot", () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        rowKey={(r) => r.id}
        empty={<p>No payments in this period.</p>}
      />,
    );
    expect(screen.getByText("No payments in this period.")).toBeTruthy();
  });

  it("renders busy skeleton rows while loading, not the empty state", () => {
    render(
      <DataTable columns={COLUMNS} rows={[]} rowKey={(r) => r.id} loading skeletonRows={3} />,
    );
    expect(screen.queryByText("Nothing to show yet")).toBeNull();
    const table = screen.getByRole("table");
    expect(table.getAttribute("aria-busy")).toBe("true");
    expect(table.querySelectorAll("tbody tr").length).toBe(3);
  });

  it("makes rows keyboard-activatable when onRowClick is supplied", () => {
    const onRowClick = vi.fn();
    render(
      <DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} onRowClick={onRowClick} />,
    );
    const firstRow = screen.getAllByRole("row")[1];
    expect(firstRow.getAttribute("tabindex")).toBe("0");

    fireEvent.click(firstRow);
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);

    fireEvent.keyDown(firstRow, { key: "Enter" });
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });

  it("does not make rows focusable without onRowClick", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    expect(screen.getAllByRole("row")[1].getAttribute("tabindex")).toBeNull();
  });
});

describe("DataTable sorting helpers", () => {
  it("sorts empties last in both directions", () => {
    const rows = [{ v: "b" }, { v: null }, { v: "a" }];
    const column: DataTableColumn<{ v: string | null }> = {
      key: "v",
      header: "V",
      cell: (r) => r.v,
      sortValue: (r) => r.v,
    };
    expect(sortRows(rows, column, "asc").map((r) => r.v)).toEqual(["a", "b", null]);
    expect(sortRows(rows, column, "desc").map((r) => r.v)).toEqual(["b", "a", null]);
  });

  it("does not mutate the caller's array", () => {
    const rows = [{ v: "b" }, { v: "a" }];
    const column: DataTableColumn<{ v: string }> = {
      key: "v",
      header: "V",
      cell: (r) => r.v,
      sortValue: (r) => r.v,
    };
    sortRows(rows, column, "asc");
    expect(rows.map((r) => r.v)).toEqual(["b", "a"]);
  });

  it("returns rows untouched for a column with no sortValue", () => {
    const rows = [{ v: "b" }, { v: "a" }];
    expect(sortRows(rows, undefined, "asc")).toBe(rows);
  });

  it("compares numbers numerically and dates chronologically", () => {
    expect(compareValues(9, 10)).toBeLessThan(0);
    expect(compareValues(new Date("2026-02-01"), new Date("2026-01-01"))).toBeGreaterThan(0);
    expect(compareValues("apple", "Banana")).toBeLessThan(0);
  });

  it("flips direction on the same key and resets to asc on a new key", () => {
    expect(nextSortState(null, "name")).toEqual({ key: "name", direction: "asc" });
    expect(nextSortState({ key: "name", direction: "asc" }, "name")).toEqual({
      key: "name",
      direction: "desc",
    });
    expect(nextSortState({ key: "name", direction: "desc" }, "owed")).toEqual({
      key: "owed",
      direction: "asc",
    });
  });
});

// ── Focus-trap helper ────────────────────────────────────────────────────────

describe("nextFocusTarget", () => {
  function buttons(count: number): HTMLElement[] {
    return Array.from({ length: count }, () => document.createElement("button"));
  }

  it("wraps forwards from the last element to the first", () => {
    const els = buttons(3);
    expect(nextFocusTarget(els, els[2], false)).toBe(els[0]);
  });

  it("wraps backwards from the first element to the last", () => {
    const els = buttons(3);
    expect(nextFocusTarget(els, els[0], true)).toBe(els[2]);
  });

  it("lets the browser handle Tab in the middle of the ring", () => {
    const els = buttons(3);
    expect(nextFocusTarget(els, els[1], false)).toBeNull();
    expect(nextFocusTarget(els, els[1], true)).toBeNull();
  });

  it("pulls focus back when it has escaped the overlay", () => {
    const els = buttons(3);
    expect(nextFocusTarget(els, document.createElement("a"), false)).toBe(els[0]);
    expect(nextFocusTarget(els, null, true)).toBe(els[2]);
  });

  it("does nothing when there is nothing to focus", () => {
    expect(nextFocusTarget([], null, false)).toBeNull();
  });
});

// ── PageHeader + Card ────────────────────────────────────────────────────────

describe("PageHeader", () => {
  it("renders an h1 with the title, plus description and action slots", () => {
    render(
      <PageHeader
        title="Members"
        description="Everyone on the mats."
        action={<button>Add member</button>}
      />,
    );
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.tagName).toBe("H1");
    expect(heading.textContent).toBe("Members");
    expect(screen.getByText("Everyone on the mats.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add member" })).toBeTruthy();
  });

  it("omits the description and action when not supplied", () => {
    const { container } = render(<PageHeader title="Members" />);
    expect(container.querySelectorAll("p").length).toBe(0);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Card", () => {
  it("uses the --pad-card padding token by default and drops it on padding=none", () => {
    const { container, rerender } = render(<Card>content</Card>);
    const card = container.querySelector('[data-slot="card"]')!;
    expect(card.className).toContain("p-[var(--pad-card)]");
    expect(card.className).toContain("bg-sf-1");
    expect(card.className).toContain("border-bd-default");
    expect(card.className).toContain("rounded-[var(--r-md)]");

    rerender(<Card padding="none">content</Card>);
    expect(
      container.querySelector('[data-slot="card"]')!.className,
    ).not.toContain("p-[var(--pad-card)]");
  });
});
