"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
 *     push the page sideways. That scroller is the header's nearest scroll
 *     container in the 640–1023px band, and a sticky box inside a scrollport
 *     that never scrolls is NOT inert: the sticky constraint still applies, so
 *     the box is pushed down by its full `top` and stays there. With a 45px
 *     rail offset that meant the header sat 45px below the top of the card at
 *     rest and painted over the first row (measured 25 Sep 2026 at every width
 *     from 640 to 1023; the owner photographed the hidden payment row). So the
 *     `stickyOffset` is applied at `lg:` and up ONLY, where the scrollport it
 *     was measured against (`<main>`) is the real one; below `lg:` the header
 *     keeps `top: 0`, which is harmless in a local scroller. Regression:
 *     tests/e2e/ui-audit-overlap.spec.ts ("member profile Payments tab").
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
 * Mobile: below `sm:` the table collapses to cards (`cardsBelow="lg"` moves
 * that to below `lg:`). Pass `renderCard` for a
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
  /**
   * Hide this column below a breakpoint. At `lg:` and up the table has no
   * local scroller (header comment), so a table wider than the content box is
   * CLIPPED, not scrolled: on a 1280px laptop a wide table loses its right-hand
   * columns outright. Give the lowest-priority columns a breakpoint instead.
   */
  visibleFrom?: "xl" | "2xl";
  /**
   * `"top"` pins this column's cells to the top of the row. Only for a table
   * whose rows are deliberately several lines tall (the Activity page), so a
   * time or a button sits beside the first line, not halfway down.
   */
  valign?: "top";
}

/** Static class map (UI-RULES 11: no dynamic class fragments). */
const VISIBLE_FROM: Record<NonNullable<DataTableColumn<unknown>["visibleFrom"]>, string> = {
  xl: "hidden xl:table-cell",
  "2xl": "hidden 2xl:table-cell",
};

/** Static class maps for `cardsBelow` (UI-RULES 11: no dynamic class fragments). */
const TABLE_FROM = {
  sm: "hidden overflow-x-auto sm:block lg:overflow-x-visible",
  lg: "hidden lg:block lg:overflow-x-visible",
} as const;
const CARDS_BELOW = {
  sm: "space-y-2 sm:hidden",
  lg: "space-y-2 lg:hidden",
} as const;

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Renders skeleton rows instead of data. */
  loading?: boolean;
  /** Shown when there is genuinely no data. Never use it for a failed request (§7). */
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  /**
   * The one row a deep link pointed at. It gets `aria-current="true"` and an
   * outline in `--tx-2`, on the table row and on the card — darker than the
   * `--bd-active` focus outline, which is too faint to say "this one" on a
   * long table and would be indistinguishable from keyboard focus.
   */
  isRowCurrent?: (row: T) => boolean;
  /**
   * Group consecutive rows under a heading: whenever the key differs from the
   * previous row's, a full-width header row (and, on a phone, a heading before
   * the card) carries the label — the Activity timeline's "Today", "Yesterday",
   * "Tuesday 4 November 2026". The rows must already arrive in section order;
   * nothing is regrouped. Ignored while the table is client-sorted, since a
   * sort would scatter the sections.
   */
  sectionOf?: (row: T) => { key: string; label: string };
  /** Below the card breakpoint (`cardsBelow`), render each row through this instead of the table. */
  renderCard?: (row: T) => ReactNode;
  /**
   * Where the table gives way to cards. Default `"sm"`: cards on a phone, the
   * table from 640px. `"lg"`: cards up to 1023px, for a table whose rows carry
   * long text that a tablet-width column would squeeze into ragged lines.
   */
  cardsBelow?: "sm" | "lg";
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

/**
 * Dev-only: the fault the owner photographed. If the primitive's own wrapper
 * is a scroll container AND the header carries a non-zero sticky `top`, the
 * header is displaced by that offset and covers the first row. The `lg:`-only
 * offset class makes this unreachable by construction; the check exists so a
 * future edit that widens the offset back below `lg:` shouts in dev.
 */
function warnOnDisplacedHeader(wrapper: HTMLElement | null) {
  if (!wrapper || typeof window === "undefined") return;
  const th = wrapper.querySelector("thead th");
  if (!th) return;
  const { overflowX, overflowY } = window.getComputedStyle(wrapper);
  const scrolls = (value: string) => value === "auto" || value === "scroll";
  if (!scrolls(overflowX) && !scrolls(overflowY)) return;
  const top = parseFloat(window.getComputedStyle(th).top);
  if (!Number.isFinite(top) || top === 0) return;
  console.warn(
    `[DataTable] The sticky <thead> is displaced by ${top}px: the table's own wrapper is a scroll ` +
      "container, so the offset resolves against it and the header covers the first row. " +
      "The stickyOffset must apply only where <main> is the scrollport (lg: and up). " +
      "See components/ui/data-table.tsx.",
    th,
  );
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  empty,
  onRowClick,
  isRowCurrent,
  sectionOf,
  renderCard,
  cardsBelow = "sm",
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

  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    warnOnClippingAncestor(rootRef.current);
    warnOnDisplacedHeader(wrapperRef.current);
  }, []);

  if (!loading && rows.length === 0) {
    return (
      <div className={className}>
        {empty ?? <EmptyState title="Nothing to show yet" />}
      </div>
    );
  }

  const skeletonKeys = Array.from({ length: skeletonRows }, (_, index) => index);

  /** The section a row opens, or null when it continues the previous row's (or there are no sections). */
  const sectionAt = (index: number): { key: string; label: string } | null => {
    if (!sectionOf || sort) return null;
    const section = sectionOf(sortedRows[index]);
    return index === 0 || sectionOf(sortedRows[index - 1]).key !== section.key ? section : null;
  };

  /**
   * The table's row groups: one per run of rows in the same section, or a
   * single group when there are no sections. A group is keyed by its section
   * (and, should the same section come round again, by which time it is) —
   * never by a row's position, so rows arriving above a group do not remount
   * it and drop the focus inside it.
   */
  const rowGroups: { key: string; section: { key: string; label: string } | null; indexes: number[] }[] = [];
  const timesSeen = new Map<string, number>();
  sortedRows.forEach((_, index) => {
    const section = sectionAt(index);
    if (section || rowGroups.length === 0) {
      const nth = section ? (timesSeen.get(section.key) ?? 0) : 0;
      if (section) timesSeen.set(section.key, nth + 1);
      rowGroups.push({ key: section ? (nth ? `${section.key}#${nth}` : section.key) : "rows", section, indexes: [index] });
    } else rowGroups[rowGroups.length - 1].indexes.push(index);
  });

  return (
    <div ref={rootRef} className={cn("w-full", className)}>
      {/* ── Desktop / tablet table ── */}
      <div ref={wrapperRef} className={TABLE_FROM[cardsBelow]}>
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
                      // `top-0` below `lg:`, the rail offset only at `lg:` and
                      // up — the offset was measured against <main>, and only
                      // there is <main> the scrollport (header comment).
                      "sticky top-0 lg:top-[var(--dt-sticky-top,0px)] z-10 whitespace-nowrap border-b border-bd-default bg-sf-1 px-3 py-2 font-medium text-tx-3",
                      // The card wrapper no longer clips, so the opaque header
                      // rounds its own outer corners or it paints a square
                      // nub over the card's 12px radius.
                      "first:rounded-tl-[var(--r-md)] last:rounded-tr-[var(--r-md)]",
                      ALIGN[column.align ?? "left"],
                      column.visibleFrom && VISIBLE_FROM[column.visibleFrom],
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
          {loading ? (
            <tbody>
              {skeletonKeys.map((index) => (
                <tr key={`skeleton-${index}`} className="h-[var(--row-h-dense)]">
                  {columns.map((column) => (
                    <td key={column.key} className={cn("border-b border-bd-default px-3 py-1", column.visibleFrom && VISIBLE_FROM[column.visibleFrom])}>
                      <Skeleton className="h-3 w-full" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ) : (
            // One row group per section (one for the whole table when there are
            // none), so a section's header cell is the header OF its rows
            // (`scope="rowgroup"`) and a screen reader announces the day with
            // each row under it.
            rowGroups.map((group) => (
              <tbody key={group.key}>
                {group.section ? (
                  <tr data-section={group.section.key}>
                    <th
                      scope="rowgroup"
                      colSpan={columns.length}
                      // White, under the rule the row above draws: the zebra rows are grey, so a grey header read as one more row.
                      className="border-b border-bd-default bg-sf-1 px-3 pb-1.5 pt-3 text-left text-xs font-semibold text-tx-1"
                    >
                      {group.section.label}
                    </th>
                  </tr>
                ) : null}
                {group.indexes.map((index) => {
                  const row = sortedRows[index];
                  const zebra = index % 2 === 1;
                  const isLastRow = index === sortedRows.length - 1;
                  const current = isRowCurrent?.(row) === true;
                  return (
                    <tr
                      key={rowKey(row)}
                      aria-current={current ? "true" : undefined}
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
                        current && "outline outline-2 -outline-offset-2 outline-[var(--tx-2)]",
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
                            "border-b border-bd-default px-3 py-1 text-tx-1 transition-colors",
                            column.valign === "top" ? "align-top" : "align-middle",
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
                            column.visibleFrom && VISIBLE_FROM[column.visibleFrom],
                          )}
                        >
                          {column.cell(row)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            ))
          )}
        </table>
      </div>

      {/* ── Mobile cards (UI-RULES §9: the staff dashboard must work at 375px) ── */}
      <div className={CARDS_BELOW[cardsBelow]} aria-busy={loading || undefined}>
        {loading
          ? skeletonKeys.map((index) => (
              <Card key={`skeleton-card-${index}`} padding="tight">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="mt-2 h-3 w-1/2" />
              </Card>
            ))
          : sortedRows.map((row, index) => {
              const section = sectionAt(index);
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
              const current = isRowCurrent?.(row) === true;
              const currentClass = current
                ? "rounded-[var(--r-md)] outline outline-2 outline-offset-2 outline-[var(--tx-2)]"
                : undefined;
              const card = onRowClick ? (
                <button
                  type="button"
                  onClick={() => onRowClick(row)}
                  aria-current={current ? "true" : undefined}
                  className={cn("block w-full text-left", currentClass)}
                >
                  {content}
                </button>
              ) : (
                <div aria-current={current ? "true" : undefined} className={currentClass}>
                  {content}
                </div>
              );
              return (
                <Fragment key={rowKey(row)}>
                  {section ? (
                    // The page's title is its h1; a day is the next level down.
                    <h2 data-section={section.key} className="px-1 pt-2 text-xs font-semibold text-tx-2">
                      {section.label}
                    </h2>
                  ) : null}
                  {card}
                </Fragment>
              );
            })}
      </div>
    </div>
  );
}

export default DataTable;
