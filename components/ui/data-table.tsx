"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card } from "./card";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";

/**
 * DataTable primitive — the dense data-screen table (docs/UI-RULES.md §1.5,
 * §4a.4, §5.5). Members, Payments, Timetable and Attendance all render
 * through this so the density, the sticky header, the zebra and the mobile
 * strategy are decided once.
 *
 * Density: `--row-h-dense` (36px) rows, `py-2` cells, `text-[13px]`. Controls
 * dropped into cells rely on the §4a.4 fine-pointer relaxation for their
 * height — do not re-inflate them with a `min-h-*` of your own.
 *
 * Desktop: the `<thead>` sticks. Horizontal overflow is scoped to a local
 * scroller below `lg:`; at `lg:` and up the scroller is released so the
 * sticky header resolves against the dashboard's own scroll container
 * (an `overflow-x` ancestor would silently make `position: sticky` inert).
 *
 * Mobile: below `sm:` the table collapses to cards. Pass `renderCard` for a
 * designed card; the fallback stacks the first three columns as label/value
 * rows, which is honest but rarely what you want on a real screen.
 */

export type SortDirection = "asc" | "desc";
export type SortState = { key: string; direction: SortDirection };

export interface DataTableColumn<T> {
  /** Stable identity, also the sort key. */
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: "left" | "center" | "right";
  /** Any CSS width, e.g. "8rem" or "20%". */
  width?: string;
  /** Supply this to make the column client-sortable. */
  sortValue?: (row: T) => string | number | Date | null | undefined;
  /** Plain-text header, used by the mobile card fallback when `header` is a node. */
  headerLabel?: string;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Renders skeleton rows instead of data. */
  loading?: boolean;
  /** Shown when there is genuinely no data. Never use it for a failed request (§7). */
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  /** Below `sm:`, render each row through this instead of the table. */
  renderCard?: (row: T) => ReactNode;
  /** Accessible name for the table. */
  label?: string;
  skeletonRows?: number;
  /**
   * How far down the sticky `<thead>` parks, as any CSS length — pass the
   * height of whatever else is already sticky above the table (§4a.7). A table
   * under a `sticky top-0` tab rail needs the rail's height here, or its
   * header slides underneath the rail on scroll. Defaults to `0px`.
   */
  stickyOffset?: string;
  className?: string;
}

// ── Sorting (pure, so it is testable without a DOM) ──────────────────────────

/** A blank cell for sorting purposes: null, undefined or an empty string. */
export function isEmptySortValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/** Empties sort last; numbers and dates compare numerically, everything else en-GB. */
export function compareValues(a: unknown, b: unknown): number {
  const aEmpty = isEmptySortValue(a);
  const bEmpty = isEmptySortValue(b);
  if (aEmpty || bEmpty) return aEmpty && bEmpty ? 0 : aEmpty ? 1 : -1;

  const aVal = a instanceof Date ? a.getTime() : a;
  const bVal = b instanceof Date ? b.getTime() : b;

  if (typeof aVal === "number" && typeof bVal === "number") return aVal - bVal;
  return String(aVal).localeCompare(String(bVal), "en-GB", { sensitivity: "base" });
}

export function sortRows<T>(
  rows: T[],
  column: DataTableColumn<T> | undefined,
  direction: SortDirection,
): T[] {
  const sortValue = column?.sortValue;
  if (!sortValue) return rows;
  const sign = direction === "asc" ? 1 : -1;
  // Copy first: the caller's array is not ours to reorder.
  return [...rows].sort((a, b) => {
    const aVal = sortValue(a);
    const bVal = sortValue(b);
    // Blanks stay at the bottom in BOTH directions — flipping them to the top
    // on a descending sort buries the rows the user actually asked to see.
    const aEmpty = isEmptySortValue(aVal);
    const bEmpty = isEmptySortValue(bVal);
    if (aEmpty || bEmpty) return aEmpty && bEmpty ? 0 : aEmpty ? 1 : -1;
    return compareValues(aVal, bVal) * sign;
  });
}

/** Clicking a header: same column flips direction, a new column starts ascending. */
export function nextSortState(current: SortState | null, key: string): SortState {
  if (current?.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: "asc" };
}

// ── Component ────────────────────────────────────────────────────────────────

const ALIGN: Record<NonNullable<DataTableColumn<unknown>["align"]>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  empty,
  onRowClick,
  renderCard,
  label,
  skeletonRows = 5,
  stickyOffset,
  className,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState | null>(null);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    return sortRows(rows, columns.find((column) => column.key === sort.key), sort.direction);
  }, [rows, columns, sort]);

  if (!loading && rows.length === 0) {
    return (
      <div className={className}>
        {empty ?? <EmptyState title="Nothing to show yet" />}
      </div>
    );
  }

  const skeletonKeys = Array.from({ length: skeletonRows }, (_, index) => index);

  return (
    <div className={cn("w-full", className)}>
      {/* ── Desktop / tablet table ── */}
      <div className="hidden overflow-x-auto sm:block lg:overflow-x-visible">
        <table
          className="w-full border-collapse text-[13px]"
          aria-busy={loading || undefined}
        >
          {label ? <caption className="sr-only">{label}</caption> : null}
          {/*
            The offset rides down to the sticky `<th>`s as a custom property so
            the Tailwind class stays a literal the compiler can see — an
            interpolated `top-[${…}]` would never be generated.
          */}
          <thead
            style={
              stickyOffset
                ? ({ "--dt-sticky-top": stickyOffset } as React.CSSProperties)
                : undefined
            }
          >
            <tr>
              {columns.map((column) => {
                const sortable = Boolean(column.sortValue);
                const isSorted = sort?.key === column.key;
                const SortIcon = !isSorted
                  ? ChevronsUpDown
                  : sort.direction === "asc"
                    ? ArrowUp
                    : ArrowDown;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    style={column.width ? { width: column.width } : undefined}
                    aria-sort={
                      isSorted
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : sortable
                          ? "none"
                          : undefined
                    }
                    className={cn(
                      "sticky top-[var(--dt-sticky-top,0px)] z-10 whitespace-nowrap border-b border-bd-default bg-sf-1 px-3 py-2 font-medium text-tx-3",
                      ALIGN[column.align ?? "left"],
                    )}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => setSort((current) => nextSortState(current, column.key))}
                        className="inline-flex items-center gap-1 text-inherit transition-colors hover:text-tx-1"
                      >
                        {column.header}
                        <SortIcon className="size-3" aria-hidden="true" />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading
              ? skeletonKeys.map((index) => (
                  <tr
                    key={`skeleton-${index}`}
                    className="h-[var(--row-h-dense)] border-b border-bd-default"
                  >
                    {columns.map((column) => (
                      <td key={column.key} className="px-3 py-2">
                        <Skeleton className="h-3 w-full" />
                      </td>
                    ))}
                  </tr>
                ))
              : sortedRows.map((row, index) => {
                  const zebra = index % 2 === 1;
                  return (
                    <tr
                      key={rowKey(row)}
                      className={cn(
                        "h-[var(--row-h-dense)] border-b border-bd-default transition-colors",
                        zebra && "bg-sf-2",
                        // The hover step has to be visible on BOTH stripes —
                        // hovering an --sf-2 row with --sf-2 paints nothing.
                        zebra ? "hover:bg-sf-0" : "hover:bg-sf-2",
                        onRowClick && "cursor-pointer focus-visible:outline-offset-[-2px]",
                      )}
                      {...(onRowClick
                        ? {
                            tabIndex: 0,
                            onClick: () => onRowClick(row),
                            onKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>) => {
                              if (event.key !== "Enter" && event.key !== " ") return;
                              if (event.target !== event.currentTarget) return;
                              event.preventDefault();
                              onRowClick(row);
                            },
                          }
                        : {})}
                    >
                      {columns.map((column) => (
                        <td
                          key={column.key}
                          className={cn(
                            "px-3 py-2 align-middle text-tx-1",
                            ALIGN[column.align ?? "left"],
                          )}
                        >
                          {column.cell(row)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>

      {/* ── Mobile cards (UI-RULES §9: the staff dashboard must work at 375px) ── */}
      <div className="space-y-2 sm:hidden" aria-busy={loading || undefined}>
        {loading
          ? skeletonKeys.map((index) => (
              <Card key={`skeleton-card-${index}`} padding="tight">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="mt-2 h-3 w-1/2" />
              </Card>
            ))
          : sortedRows.map((row) => {
              const content = renderCard ? (
                renderCard(row)
              ) : (
                <Card padding="tight" className="text-[13px]">
                  {columns.slice(0, 3).map((column) => (
                    <div
                      key={column.key}
                      className="flex items-baseline justify-between gap-3 py-0.5"
                    >
                      <span className="shrink-0 text-tx-3">
                        {column.headerLabel ?? column.header}
                      </span>
                      <span className="min-w-0 text-right text-tx-1">
                        {column.cell(row)}
                      </span>
                    </div>
                  ))}
                </Card>
              );
              return onRowClick ? (
                <button
                  key={rowKey(row)}
                  type="button"
                  onClick={() => onRowClick(row)}
                  className="block w-full text-left"
                >
                  {content}
                </button>
              ) : (
                <div key={rowKey(row)}>{content}</div>
              );
            })}
      </div>
    </div>
  );
}

export default DataTable;
