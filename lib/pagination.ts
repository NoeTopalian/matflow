// Shared cursor-pagination helper. Hard-caps `take` at 100 across the API
// surface so a single request can't exfiltrate or DoS-read an entire table.
//
// Usage:
//   const { take, cursor, skip } = parsePagination(req);
//   const items = await prisma.x.findMany({ where, take, skip, cursor: cursor ? { id: cursor } : undefined, orderBy: ... });
//   return NextResponse.json({ items, nextCursor: nextCursorFor(items, take) });

export const PAGINATION_HARD_CAP = 100;

export type Pagination = {
  take: number;
  cursor: string | undefined;
  skip: 0 | 1;
};

export type PaginationOptions = {
  defaultTake?: number;
  maxTake?: number;
};

export function parsePagination(
  source: Request | URL | URLSearchParams,
  options: PaginationOptions = {},
): Pagination {
  const defaultTake = options.defaultTake ?? 50;
  const maxTake = Math.min(options.maxTake ?? PAGINATION_HARD_CAP, PAGINATION_HARD_CAP);

  const params =
    source instanceof URLSearchParams
      ? source
      : source instanceof URL
        ? source.searchParams
        : new URL(source.url).searchParams;

  const cursor = params.get("cursor") ?? undefined;
  const rawTake = parseInt(params.get("take") ?? String(defaultTake), 10);
  const safeTake = Number.isFinite(rawTake) && rawTake > 0 ? rawTake : defaultTake;
  const take = Math.min(safeTake, maxTake);

  return { take, cursor, skip: cursor ? 1 : 0 };
}

export function nextCursorFor<T extends { id: string }>(
  items: T[],
  take: number,
): string | null {
  return items.length === take ? items[items.length - 1].id : null;
}
