// @vitest-environment jsdom
// DataTable `visibleFrom`: at lg: and up the table has no local scroller, so a
// table wider than the content box is CLIPPED (owner screenshot 12 Oct 2026:
// Members lost Waiver, Rank, Last Visit and Joined at the right edge). Columns
// can opt out below a breakpoint; header, data and skeleton cells all follow.
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import React from "react";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";

type Row = { id: string; a: string; b: string; c: string };
const columns: DataTableColumn<Row>[] = [
  { key: "a", header: "A", cell: (r) => r.a },
  { key: "b", header: "B", cell: (r) => r.b, visibleFrom: "xl" },
  { key: "c", header: "C", cell: (r) => r.c, visibleFrom: "2xl" },
];
const rows: Row[] = [{ id: "1", a: "a1", b: "b1", c: "c1" }];

function cellsOf(container: HTMLElement, selector: string) {
  return [...container.querySelectorAll(selector)] as HTMLElement[];
}

describe("DataTable visibleFrom", () => {
  it("leaves columns without visibleFrom untouched", () => {
    const { container } = render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const [th] = cellsOf(container, "thead th");
    const [td] = cellsOf(container, "tbody td");
    expect(th.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(td.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it("hides header and data cells below the breakpoint with static classes", () => {
    const { container } = render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const ths = cellsOf(container, "thead th");
    const tds = cellsOf(container, "tbody td");
    expect(ths[1].className).toContain("hidden xl:table-cell");
    expect(tds[1].className).toContain("hidden xl:table-cell");
    expect(ths[2].className).toContain("hidden 2xl:table-cell");
    expect(tds[2].className).toContain("hidden 2xl:table-cell");
  });

  it("applies the same rule to skeleton cells while loading", () => {
    const { container } = render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} loading skeletonRows={1} />);
    const tds = cellsOf(container, "tbody td");
    expect(tds[0].className).not.toContain("hidden");
    expect(tds[1].className).toContain("hidden xl:table-cell");
    expect(tds[2].className).toContain("hidden 2xl:table-cell");
  });
});
