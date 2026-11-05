// @vitest-environment jsdom
// The three shared pieces the Activity timeline needs from components/ui:
// section headers in DataTable (the day headings), the Checkbox's third state
// (a group that is partly ticked), and the Input field. Each is additive — the
// last block proves existing tables and checkboxes render as before.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import React, { createRef } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

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
