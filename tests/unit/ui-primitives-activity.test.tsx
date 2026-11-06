// @vitest-environment jsdom
// The shared pieces the Activity timeline needs from components/ui: section
// headers in DataTable (the day headings), where its cards give way to the
// table, the Checkbox's third state (a group that is partly ticked), the Input
// field and the tab bar. Each is additive — existing tables, checkboxes and the
// member profile's tabs render as before.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import React, { createRef } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tab, TabList } from "@/components/ui/tabs";

type Row = { id: string; name: string; day: string };
const columns: DataTableColumn<Row>[] = [
  { key: "name", header: "Name", cell: (r) => r.name },
  { key: "id", header: "Id", cell: (r) => r.id },
];
const rows: Row[] = [
  { id: "1", name: "first", day: "2026-11-05" },
  { id: "2", name: "second", day: "2026-11-05" },
  { id: "3", name: "third", day: "2026-11-04" },
  { id: "4", name: "fourth", day: "2026-11-03" },
];
const LABEL: Record<string, string> = { "2026-11-05": "Today", "2026-11-04": "Yesterday", "2026-11-03": "Tuesday 3 November 2026" };
const sectionOf = (r: Row) => ({ key: r.day, label: LABEL[r.day] });

describe("DataTable sectionOf", () => {
  it("puts one full-width header row before the first row of each section", () => {
    const { container } = render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} sectionOf={sectionOf} />);
    const headers = [...container.querySelectorAll("tbody tr[data-section] th")];
    expect(headers.map((h) => h.textContent)).toEqual(["Today", "Yesterday", "Tuesday 3 November 2026"]);
    for (const h of headers) {
      expect(h.getAttribute("colspan")).toBe("2");
      // A header for the rows under it: each section is its own row group.
      expect(h.getAttribute("scope")).toBe("rowgroup");
      expect(h.closest("tbody")!.querySelectorAll("tr[data-section]")).toHaveLength(1);
    }
    expect([...container.querySelectorAll("tbody")].map((tb) => tb.querySelectorAll("tr:not([data-section])").length)).toEqual([2, 1, 1]);
    // In document order: header, its rows, next header…
    const order = [...container.querySelectorAll("tbody tr")].map((tr) => tr.getAttribute("data-section") ?? tr.querySelector("td")?.textContent);
    expect(order).toEqual(["2026-11-05", "first", "second", "2026-11-04", "third", "2026-11-03", "fourth"]);
  });

  it("a row arriving at the top does not remount the sections below it (focus inside them is kept)", () => {
    const { container, rerender } = render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} sectionOf={sectionOf} />);
    const yesterday = container.querySelectorAll("tbody")[1];
    rerender(<DataTable columns={columns} rows={[{ id: "0", name: "newest", day: "2026-11-05" }, ...rows]} rowKey={(r) => r.id} sectionOf={sectionOf} />);
    expect(container.querySelectorAll("tbody")[1]).toBe(yesterday);
    expect(container.querySelectorAll("tbody")[0].querySelectorAll("tr:not([data-section])")).toHaveLength(3);
  });

  it("gives the phone cards the same headings", () => {
    const { container } = render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} sectionOf={sectionOf} renderCard={(r) => <p>{r.name}</p>} />);
    const cards = container.querySelector(".sm\\:hidden")!;
    expect([...cards.querySelectorAll("h2[data-section]")].map((h) => h.textContent)).toEqual(["Today", "Yesterday", "Tuesday 3 November 2026"]);
    expect([...cards.children].map((el) => el.textContent)).toEqual(["Today", "first", "second", "Yesterday", "third", "Tuesday 3 November 2026", "fourth"]);
  });

  it("drops the headings while the table is sorted by a column, and brings none back for rows in one section", () => {
    const sortable: DataTableColumn<Row>[] = [{ key: "name", header: "Name", cell: (r) => r.name, sortValue: (r) => r.name }];
    const { container } = render(<DataTable columns={sortable} rows={rows} rowKey={(r) => r.id} sectionOf={sectionOf} />);
    expect(container.querySelectorAll("[data-section]").length).toBeGreaterThan(0);
    fireEvent.click(container.querySelector("thead button")!);
    expect(container.querySelectorAll("[data-section]")).toHaveLength(0);

    const oneDay = render(<DataTable columns={columns} rows={rows.slice(0, 2)} rowKey={(r) => r.id} sectionOf={sectionOf} />);
    expect(oneDay.container.querySelectorAll("tbody tr[data-section]")).toHaveLength(1);
  });

  it("a table without sectionOf renders exactly the rows it always did", () => {
    const { container } = render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(container.querySelectorAll("[data-section]")).toHaveLength(0);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(4);
    expect(container.querySelector(".sm\\:hidden")!.children).toHaveLength(4);
  });
});

describe("Checkbox mixed state", () => {
  it("says mixed, shows a dash, and ticks the whole group when activated", () => {
    const onChange = vi.fn();
    const { container } = render(<Checkbox checked="mixed" onCheckedChange={onChange} aria-label="Attendance" />);
    const box = container.querySelector('[role="checkbox"]')!;
    expect(box.getAttribute("aria-checked")).toBe("mixed");
    expect(box.querySelector("svg")?.getAttribute("class")).toContain("lucide-minus");
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("still toggles between ticked and empty as before", () => {
    const onChange = vi.fn();
    const on = render(<Checkbox checked onCheckedChange={onChange} aria-label="x" />);
    expect(on.container.querySelector('[role="checkbox"]')!.getAttribute("aria-checked")).toBe("true");
    expect(on.container.querySelector("svg")?.getAttribute("class")).toContain("lucide-check");
    fireEvent.click(on.container.querySelector('[role="checkbox"]')!);
    expect(onChange).toHaveBeenLastCalledWith(false);

    const off = render(<Checkbox checked={false} onCheckedChange={onChange} aria-label="y" />);
    expect(off.container.querySelector('[role="checkbox"]')!.getAttribute("aria-checked")).toBe("false");
    expect(off.container.querySelector("svg")).toBeNull();
    fireEvent.click(off.container.querySelector('[role="checkbox"]')!);
    expect(onChange).toHaveBeenLastCalledWith(true);
  });
});

describe("Input", () => {
  it("is a named, fixed-height field that passes everything else through", () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    const { container } = render(<Input ref={ref} aria-label="Jump to date" type="date" min="2025-11-05" max="2026-11-05" value="2026-11-04" onChange={onChange} className="w-[10rem]" />);
    const field = container.querySelector("input")!;
    expect(ref.current).toBe(field);
    expect(field.getAttribute("aria-label")).toBe("Jump to date");
    expect(field.getAttribute("type")).toBe("date");
    expect(field.getAttribute("min")).toBe("2025-11-05");
    expect(field.className).toContain("ui-fixed-size");
    expect(field.className).toContain("h-9");
    expect(field.className).toContain("w-[10rem]");
    // The keyboard focus ring comes from the base layer: the field must not remove it.
    expect(field.className).not.toContain("outline-none");
    fireEvent.change(field, { target: { value: "2026-11-03" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("is a text field unless told otherwise", () => {
    const { container } = render(<Input aria-label="Name or email" placeholder="Name or email" />);
    expect(container.querySelector("input")!.getAttribute("type")).toBe("text");
  });
});

describe("a field and a field-like button share a height on a touch screen", () => {
  it("the coarse-pointer rule covers the select, the Input primitive and .ui-field, and UI-RULES says so", () => {
    const css = readFileSync(join("app", "globals.css"), "utf8").replace(/\s+/g, " ");
    expect(css).toMatch(/@media \(pointer: coarse\) \{ select\.ui-fixed-size, input\[data-slot="input"\]\.ui-fixed-size, \.ui-field\.ui-fixed-size \{ min-height: 44px; \} \}/);
    // Only the primitive's field: a bare input carries ui-fixed-size to opt OUT of the 44px floor (the member profile's
    // rows are their own hit area), and must not be grown by this rule.
    expect(css).not.toMatch(/[,{] input\.ui-fixed-size[ ,{]/);
    const { container } = render(<Input aria-label="Name" />);
    expect(container.querySelector("input")!.getAttribute("data-slot")).toBe("input");
    expect(readFileSync(join("docs", "UI-RULES.md"), "utf8")).toContain("`ui-field`");
  });
});

describe("DataTable cardsBelow", () => {
  it("defaults to cards below sm: — every other table is unchanged", () => {
    const { container } = render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(container.querySelector("table")!.parentElement!.className).toBe("hidden overflow-x-auto sm:block lg:overflow-x-visible");
    expect(container.querySelector(".sm\\:hidden")!.className).toBe("space-y-2 sm:hidden");
  });

  it('"lg" keeps the cards up to 1023px and shows the table from lg: up', () => {
    const { container } = render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} cardsBelow="lg" />);
    expect(container.querySelector("table")!.parentElement!.className).toBe("hidden lg:block lg:overflow-x-visible");
    expect(container.querySelector(".lg\\:hidden")!.children).toHaveLength(4);
    expect(container.querySelector(".sm\\:hidden")).toBeNull();
  });

  it('valign "top" pins only that column\'s cells to the top', () => {
    const cols: DataTableColumn<Row>[] = [{ ...columns[0], valign: "top" }, columns[1]];
    const { container } = render(<DataTable columns={cols} rows={rows.slice(0, 1)} rowKey={(r) => r.id} />);
    const [a, b] = [...container.querySelectorAll("tbody td")];
    expect(a.className).toContain("align-top");
    expect(b.className).toContain("align-middle");
  });
});

describe("Tab bar (extracted from the member profile)", () => {
  // The classes the member profile's own Tab and rail had before the extraction (origin/main 9c3b938c).
  const RAIL = "sticky top-0 z-20 mb-5 flex overflow-x-auto border-b border-bd-default bg-[var(--sf-bg)] scrollbar-hide lg:overflow-x-visible";
  const ACTIVE = "shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors text-tx-1";
  const IDLE = "shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-transparent text-tx-3 hover:border-bd-hover hover:text-tx-2";
  const words = (c: string) => c.split(/\s+/).filter(Boolean).sort();

  it("draws the member profile's rail and tabs with exactly the classes they had", () => {
    const { container } = render(
      <TabList label="Member sections" className="sticky top-0 z-20 mb-5 bg-[var(--sf-bg)]">
        <Tab label="Overview" active onClick={() => {}} />
        <Tab label="Attendance" active={false} onClick={() => {}} count={12} />
      </TabList>,
    );
    const rail = container.querySelector('[role="tablist"]')!;
    expect(rail.getAttribute("aria-label")).toBe("Member sections");
    expect(words(rail.className)).toEqual(words(RAIL));
    const [overview, attendance] = [...rail.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
    expect(words(overview.className)).toEqual(words(ACTIVE));
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect(overview.style.borderColor).toBe("var(--color-primary)");
    expect(words(attendance.className)).toEqual(words(IDLE));
    expect(attendance.getAttribute("aria-selected")).toBe("false");
    expect(attendance.textContent).toBe("Attendance (12)");
    // No tabIndex given: every tab stays in the Tab order, as before.
    expect(overview.hasAttribute("tabindex")).toBe(false);
  });

  it("the member profile uses the shared bar, with its six tabs, and no Tab of its own", () => {
    const source = readFileSync(join("components", "dashboard", "MemberProfile.tsx"), "utf8");
    expect(source).toContain('import { Tab, TabList } from "@/components/ui/tabs";');
    expect(source).not.toMatch(/function Tab\(/);
    expect(source).toContain('<TabList label="Member sections" className="sticky top-0 z-20 mb-5 bg-[var(--sf-bg)]">');
    expect([...source.matchAll(/<Tab label="([^"]+)"/g)].map((m) => m[1])).toEqual(["Overview", "Attendance", "Payments", "Ranks", "Internal Notes", "Photos"]);
  });

  it("brings a newly selected tab into view on a narrow rail, and leaves the rail alone on a re-render with the same tab", () => {
    const bar = (selected: string, count?: number) => (
      <TabList label="Views">
        {["One", "Two", "Three"].map((name) => (
          <Tab key={name} label={name} active={name === selected} onClick={() => {}} count={name === "One" ? count : undefined} />
        ))}
      </TabList>
    );
    const { container, rerender } = render(bar("One"));
    const rail = container.querySelector<HTMLElement>('[role="tablist"]')!;
    const tabs = [...rail.querySelectorAll<HTMLElement>('[role="tab"]')];
    // jsdom has no layout: a 100px rail holding 500px of tabs, the third tab at 300–350px.
    let scrollLeft = 0;
    Object.defineProperty(rail, "scrollLeft", { get: () => scrollLeft, set: (v: number) => (scrollLeft = v) });
    Object.defineProperty(rail, "scrollWidth", { value: 500 });
    Object.defineProperty(rail, "clientWidth", { value: 100 });
    rail.getBoundingClientRect = () => ({ left: 0 }) as DOMRect;
    tabs.forEach((tab, i) => {
      Object.defineProperty(tab, "offsetWidth", { value: 50 });
      tab.getBoundingClientRect = () => ({ left: i * 150 - scrollLeft }) as DOMRect;
    });
    rerender(bar("Three"));
    expect(scrollLeft).toBe(250);
    // The person scrolls the rail back; the page re-renders with the same tab selected: the rail stays put.
    scrollLeft = 0;
    rerender(bar("Three", 4));
    rerender(bar("Three", 5));
    expect(scrollLeft).toBe(0);
    // A different selection is brought into view again.
    rerender(bar("Two"));
    expect(scrollLeft).toBe(100);
  });

  it("arrow keys, Home and End move to a tab and choose it", () => {
    const chosen: string[] = [];
    const { getAllByRole } = render(
      <TabList label="Views">
        {["One", "Two", "Three"].map((name) => (
          <Tab key={name} label={name} active={name === "One"} onClick={() => chosen.push(name)} />
        ))}
      </TabList>,
    );
    const tabs = getAllByRole("tab");
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2], { key: "Home" });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    // Other keys are left alone.
    fireEvent.keyDown(tabs[1], { key: "a" });
    expect(document.activeElement).toBe(tabs[1]);
    expect(chosen).toEqual(["Three", "One", "Two"]);
  });
});
