"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
 * Density: `--row-h-dense` (36px) rows, `py-1` cells, `text-[13px]`. Cells are
 * `whitespace-nowrap` by DEFAULT and every cell must render on ONE line — a
 * stacked two-line cell silently defeats `--row-h-dense` no matter what the
 * token says, which is how five tables ended up at five different pitches
 * (41–57px) against a 36px spec. Put the second value inline behind a `·`
 * separator, or drop it. A column that genuinely needs a shrinkable,
 * clipped cell (a long free-text body) opts out with `wrap: true`.
 *
 * The 4px cell padding is what makes the token govern: 4 + a 20px line + 4 =
 * 28px, so the row's 36px minimum wins for text rows, a 28px avatar lands
 * exactly on 36px, and an `h-8` compact control tops out at 40px. Controls
 * dropped into cells rely on the §4a.4 fine-pointer relaxation for their
 * height — do not re-inflate them with a `min-h-*` of your own.
 *
 * Desktop: the `<thead>` sticks — but ONLY at `lg:` and up, and only if no
 * call site adds a clipping ancestor. This is load-bearing, so spelled out:
 *
 *   - `position: sticky` offsets a box against its NEAREST SCROLL CONTAINER.
 *     `overflow: hidden`, `auto` and `scroll` all make a box a scroll
 *     container; `overflow-x: auto` forces the other axis to `auto` too.
 *   - Below `lg:` this primitive owns a local horizontal scroller (the
 *     `overflow-x-auto` div wrapping the `<table>`) so a wide table does not
 *     push the page sideways. That scroller is auto
 *     height, so it never scrolls vertically and the header cannot stick.
 *     Accepted: sticky is a DESKTOP affordance and 640–1023px is the tablet
 *     band where side-scrolling matters more.
 *   - At `lg:` and up the scroller is released (`lg:overflow-x-visible`), so
 *     the nearest scroll container becomes `<main class="overflow-y-auto">`
 *     in `app/dashboard/layout.tsx` — which genuinely scrolls. Sticky works.
 *   - Therefore CALL SITES MUST NOT WRAP THIS IN AN `overflow-*` ANCESTOR.
 *     All eight of them used to (`sm:overflow-hidden`, to clip the card's
 *     rounded corners) and sticky was inert on every desktop surface. The
 *     card chrome now rounds the corner CELLS instead (`border-separate` plus
 *     `first:rounded-tl` / `last:rounded-tr` on `<th>` and the same on the
 *     final row's `<td>`s), so no clipping is needed. A dev-only effect below
 *     warns if a clipping ancestor reappears.
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
  /**
   * Opt this column's cells OUT of the default `whitespace-nowrap`. Only for a
   * long free-text column that has to be able to shrink (pair it with
   * `line-clamp-1`/`truncate` so it still occupies one line) — never as a way
   * to fit a second line of content into a row.
   */
  wrap?: boolean;
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

/**
 * Dev-only: shout if a call site has re-introduced the clipping ancestor that
 * makes the sticky `<thead>` inert. Walks up from the table looking for the
 * nearest scroll container. `auto`/`scroll` is a real scrollport and fine —
 * that is `<main>`. `hidden` on the way up is the bug: it makes the wrapper a
 * scroll container that never scrolls, so the header is pinned to a scrollport
 * whose scrollTop is permanently 0 and it just travels with the rows.
 */
function warnOnClippingAncestor(root: HTMLElement | null) {
  if (!root || typeof window === "undefined") return;
  for (let node = root.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowX, overflowY } = window.getComputedStyle(node);
    const scrolls = (value: string) => value === "auto" || value === "scroll";
    if (scrolls(overflowX) || scrolls(overflowY)) return; // a genuine scrollport
    if (overflowX !== "hidden" && overflowY !== "hidden") continue;
    console.warn(
      "[DataTable] The sticky <thead> is inert: an ancestor has `overflow: hidden`, " +
        "which makes it the nearest scroll container and it never scrolls. Remove the " +
        "clipping wrapper — DataTable rounds its own corner cells, so the card chrome " +
        "does not need to clip. See components/ui/data-table.tsx.",
      node,
    );
    return;
  }
}

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
  const rootRef = useRef<HTMLDivElement>(null);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    return sortRows(rows, columns.find((column) => column.key === sort.key), sort.direction);
  }, [rows, columns, sort]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    warnOnClippingAncestor(rootRef.current);
  }, []);

  if (!loading && rows.length === 0) {
    return (
      <div className={className}>
        {empty ?? <EmptyState title="Nothing to show yet" />}
      </div>
    );
  }

  const skeletonKeys = Array.from({ length: skeletonRows }, (_, index) => index);

  return (
    <div ref={rootRef} className={cn("w-full", className)}>
      {/* ── Desktop / tablet table ── */}
      <div className="hidden overflow-x-auto sm:block lg:overflow-x-visible">
        {/*
          `border-separate border-spacing-0` rather than `border-collapse`:
          `border-radius` is ignored on cells in the collapsed model, and the
          corner cells have to be able to round themselves now that the card
          chrome no longer clips (see the header comment). Row separators move
          from the `<tr>` to the `<td>`s with it — the separated model ignores
          borders on rows.
        */}
        <table
          className="w-full border-separate border-spacing-0 text-[13px]"
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
                      // The card wrapper no longer clips, so the opaque header
                      // rounds its own outer corners or it paints a square
                      // nub over the card's 12px radius.
                      "first:rounded-tl-[var(--r-md)] last:rounded-tr-[var(--r-md)]",
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
                  <tr key={`skeleton-${index}`} className="h-[var(--row-h-dense)]">
                    {columns.map((column) => (
                      <td key={column.key} className="border-b border-bd-default px-3 py-1">
                        <Skeleton className="h-3 w-full" />
                      </td>
                    ))}
                  </tr>
                ))
              : sortedRows.map((row, index) => {
                  const zebra = index % 2 === 1;
                  const isLastRow = index === sortedRows.length - 1;
                  return (
                    <tr
                      key={rowKey(row)}
                      // `group`, because the zebra and hover fills live on the
                      // CELLS now: only a cell background can be clipped by a
                      // `border-radius`, and the last row has to round itself
                      // into the card's bottom corners.
                      className={cn(
                        "group h-[var(--row-h-dense)]",
                        // The offset was set without an outline to offset, so
                        // a keyboard-focused row showed nothing at all.
                        onRowClick &&
                          "cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--bd-active)]",
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
                            "border-b border-bd-default px-3 py-1 align-middle text-tx-1 transition-colors",
                            zebra && "bg-sf-2",
                            // The hover step has to be visible on BOTH stripes —
                            // hovering an --sf-2 row with --sf-2 paints nothing.
                            zebra ? "group-hover:bg-sf-0" : "group-hover:bg-sf-2",
                            isLastRow &&
                              "first:rounded-bl-[var(--r-md)] last:rounded-br-[var(--r-md)]",
                            // Nowrap is the DEFAULT so the row can never be
                            // grown by a cell that wrapped — that, not the
                            // padding, is what kept the tables off spec.
                            column.wrap ? "whitespace-normal" : "whitespace-nowrap",
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
