// A small model of how Postgres answers a Prisma `where` on AuditLog, for the
// Activity tests. It keeps SQL's three values — true, false and NULL — because
// the bugs it exists to catch are the NULL ones: `NOT (metadata #> path = 'x')`
// is NULL, not true, when the path is absent, and a row whose predicate is
// NULL is not selected.
//
// Covers exactly the shapes lib/activity-feed.ts builds; anything else throws,
// so a new shape cannot pass unexamined. The real SQL is checked against the
// same fixtures in tests/integration/activity-feed-db.test.ts.
import { Prisma } from "@prisma/client";

export type EvalRow = {
  id?: string;
  tenantId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  userId?: string | null;
  operatorId?: string | null;
  metadata: unknown;
  createdAt?: Date;
};

type Tri = boolean | null;

const not = (v: Tri): Tri => (v === null ? null : !v);
const and = (vs: Tri[]): Tri => (vs.includes(false) ? false : vs.includes(null) ? null : true);
const or = (vs: Tri[]): Tri => (vs.includes(true) ? true : vs.includes(null) ? null : false);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

/** `metadata #> path`: undefined stands for SQL NULL (no metadata, or no such path). A JSON null stays null. */
function at(metadata: unknown, path: string[]): unknown {
  let value: unknown = metadata ?? undefined;
  for (const key of path) {
    if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `inverted` is true when the filter sits under an odd number of NOTs. Prisma renders `array_contains` differently
 * there — "(contains OR is not an array)", so that NOT of it means "an array that does not contain" — and the plain
 * form elsewhere. Read off the generated SQL on 5 Nov 2026 and held to Postgres by the database test.
 */
function json(filter: Record<string, unknown>, metadata: unknown, inverted: boolean): Tri {
  const path = filter.path as string[] | undefined;
  const value = path ? at(metadata, path) : metadata === null ? undefined : metadata;
  if ("equals" in filter) {
    if (filter.equals === Prisma.DbNull) return value === undefined;
    if (filter.equals === Prisma.AnyNull) return value === undefined || value === null;
    if (filter.equals === Prisma.JsonNull) return value === undefined ? null : value === null;
    return value === undefined ? null : same(value, filter.equals);
  }
  if ("array_contains" in filter) {
    if (value === undefined) return null;
    const wanted = list(filter.array_contains);
    if (!Array.isArray(value)) return inverted;
    return wanted.every((w) => value.some((v) => same(v, w)));
  }
  throw new Error(`activity-where-eval: unsupported JSON filter ${JSON.stringify(Object.keys(filter))}`);
}

function column(filter: unknown, value: unknown): Tri {
  if (filter === null) return value == null; // IS NULL
  if (filter instanceof Date) return value instanceof Date ? value.getTime() === filter.getTime() : null;
  if (typeof filter !== "object") return value == null ? null : value === filter;
  const f = filter as Record<string, unknown>;
  if ("in" in f) return value == null ? null : (f.in as unknown[]).includes(value);
  if ("notIn" in f) return value == null ? null : !(f.notIn as unknown[]).includes(value);
  if ("not" in f) return f.not === null ? value != null : value == null ? null : value !== f.not; // IS NOT NULL / <>
  if ("startsWith" in f) return typeof value === "string" ? value.startsWith(f.startsWith as string) : null;
  if ("lt" in f) {
    if (value instanceof Date) return value.getTime() < (f.lt as Date).getTime();
    return typeof value === "string" ? value < (f.lt as string) : null;
  }
  if ("gte" in f) return value instanceof Date ? value.getTime() >= (f.gte as Date).getTime() : null;
  throw new Error(`activity-where-eval: unsupported column filter ${JSON.stringify(Object.keys(f))}`);
}

export function evaluate(where: unknown, row: EvalRow, inverted = false): Tri {
  const w = where as Record<string, unknown>;
  return and(
    Object.entries(w).map(([key, value]): Tri => {
      switch (key) {
        case "AND":
          return and(list(value).map((v) => evaluate(v, row, inverted)));
        case "OR":
          return or(list(value).map((v) => evaluate(v, row, inverted)));
        case "NOT":
          // Prisma reads NOT: [a, b] as "neither", which is not NOT (a AND b). Nothing here builds one; refuse rather than guess.
          if (Array.isArray(value)) throw new Error("activity-where-eval: NOT over a list is not modelled");
          return not(evaluate(value, row, !inverted));
        case "metadata":
          return json(value as Record<string, unknown>, row.metadata, inverted);
        case "id":
        case "tenantId":
        case "action":
        case "entityType":
        case "entityId":
        case "userId":
        case "operatorId":
        case "createdAt":
          return column(value, (row as Record<string, unknown>)[key]);
        default:
          throw new Error(`activity-where-eval: unsupported key "${key}"`);
      }
    }),
  );
}

/** Whether the database would return the row: only a predicate that is TRUE selects it. */
export const selects = (where: unknown, row: EvalRow): boolean => evaluate(where, row) === true;
