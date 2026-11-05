// @vitest-environment jsdom
// DataTable `isRowCurrent`: a deep link lands on a list with ONE record marked
// (the payment a feed row named). The mark is `aria-current="true"` plus the
// primitive's own outline, on the table row and on the phone card alike, so it
// reads the same at every width and to a screen reader.
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import React from "react";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";

type Row = { id: string; name: string };
const columns: DataTableColumn<Row>[] = [{ key: "name", header: "Name", cell: (r) => r.name }];
const rows: Row[] = [
  { id: "1", name: "first" },
  { id: "2", name: "second" },
  { id: "3", name: "third" },
];

describe("DataTable isRowCurrent", () => {
  it("marks exactly one table row and exactly one card", () => {
    const { container } = render(
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} isRowCurrent={(r) => r.id === "2"} />,
    );
    const tableRows = [...container.querySelectorAll('tbody tr[aria-current="true"]')];
    expect(tableRows).toHaveLength(1);
    expect(tableRows[0].textContent).toContain("second");
    expect(tableRows[0].className).toContain("outline");

    const cards = [...container.querySelectorAll('.sm\\:hidden [aria-current="true"]')];
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain("second");
  });

  it("marks nothing when the prop is absent or matches no row", () => {
    const plain = render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(plain.container.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
    const none = render(
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} isRowCurrent={() => false} />,
    );
    expect(none.container.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
  });
});
