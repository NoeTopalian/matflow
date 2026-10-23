/**
 * A small in-memory evaluator for the Prisma `where` shapes MatFlow's member
 * counts use, with SQL's THREE-VALUED logic (true / false / unknown).
 *
 * Why three-valued: Postgres evaluates `"nextDueAt" < $1` on a NULL due date
 * as UNKNOWN, and `NOT (unknown)` is still UNKNOWN, so a row silently drops out
 * of a count that wraps a nullable comparison in NOT. A two-valued evaluator
 * would pass such a where and hide the bug; this one fails it. Only rows that
 * evaluate to TRUE match, exactly as in a WHERE clause.
 *
 * Supported: AND / OR / NOT (object or array), field literals (equality,
 * `null` = IS NULL), and the operators equals, not, in, notIn, lt, lte, gt,
 * gte; to-many relation filters some / none / every over an array field.
 * Anything else throws, so a where this cannot read never passes by accident.
 */
type Tri = boolean | null;
type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const and = (a: Tri, b: Tri): Tri => (a === false || b === false ? false : a === null || b === null ? null : true);
const or = (a: Tri, b: Tri): Tri => (a === true || b === true ? true : a === null || b === null ? null : false);
const not = (a: Tri): Tri => (a === null ? null : !a);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !(v instanceof Date) && !Array.isArray(v);

function norm(v: unknown): unknown {
  return v instanceof Date ? v.getTime() : v;
}

function cmp(rowValue: unknown, value: unknown, test: (a: number | string, b: number | string) => boolean): Tri {
  if (rowValue === null || rowValue === undefined) return null;
  return test(norm(rowValue) as number | string, norm(value) as number | string);
}

function evalField(rowValue: unknown, cond: unknown): Tri {
  if (!isPlainObject(cond)) {
    if (cond === null) return rowValue === null || rowValue === undefined;
    return cmp(rowValue, cond, (a, b) => a === b);
  }
  let result: Tri = true;
  for (const [op, value] of Object.entries(cond)) {
    let r: Tri;
    switch (op) {
      case "equals":
        r = evalField(rowValue, value);
        break;
      case "not":
        r = isPlainObject(value) ? not(evalField(rowValue, value)) : value === null ? !(rowValue === null || rowValue === undefined) : cmp(rowValue, value, (a, b) => a !== b);
        break;
      case "in":
        r = rowValue == null ? null : (value as unknown[]).map(norm).includes(norm(rowValue));
        break;
      case "notIn":
        r = rowValue == null ? null : !(value as unknown[]).map(norm).includes(norm(rowValue));
        break;
      case "lt":
        r = cmp(rowValue, value, (a, b) => a < b);
        break;
      case "lte":
        r = cmp(rowValue, value, (a, b) => a <= b);
        break;
      case "gt":
        r = cmp(rowValue, value, (a, b) => a > b);
        break;
      case "gte":
        r = cmp(rowValue, value, (a, b) => a >= b);
        break;
      default:
        throw new Error(`prisma-where-eval: unsupported operator "${op}"`);
    }
    result = and(result, r);
  }
  return result;
}

export function evalWhere(row: Row, where: Where | undefined): Tri {
  if (!where) return true;
  let result: Tri = true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    let r: Tri;
    if (key === "AND") {
      r = (Array.isArray(cond) ? cond : [cond]).reduce<Tri>((acc, w) => and(acc, evalWhere(row, w as Where)), true);
    } else if (key === "OR") {
      r = (cond as Where[]).reduce<Tri>((acc, w) => or(acc, evalWhere(row, w)), false);
    } else if (key === "NOT") {
      r = (Array.isArray(cond) ? cond : [cond]).reduce<Tri>((acc, w) => and(acc, not(evalWhere(row, w as Where))), true);
    } else if (Array.isArray(row[key]) && isPlainObject(cond) && ("some" in cond || "none" in cond || "every" in cond)) {
      // EXISTS is two-valued: an element matches only when its where is TRUE.
      const items = row[key] as Row[];
      const matches = (w: unknown) => items.filter((it) => evalWhere(it, w as Where) === true).length;
      if ("some" in cond) r = matches(cond.some) > 0;
      else if ("none" in cond) r = matches(cond.none) === 0;
      else r = matches(cond.every) === items.length;
    } else {
      r = evalField(row[key], cond);
    }
    result = and(result, r);
  }
  return result;
}

export function matchRows<T extends Row>(rows: T[], where: Where | undefined): T[] {
  return rows.filter((r) => evalWhere(r, where) === true);
}

/**
 * A fake transaction client whose member reads evaluate their real `where`
 * against fixture rows, and whose other reads return empty results. Enough for
 * getReportsData and the Members page counts to run end to end in memory.
 */
export function fakeTx(members: Row[], opts: { timezone?: string | null } = {}) {
  const memberCount = async (args?: { where?: Where }) => matchRows(members, args?.where).length;
  return {
    tenant: { findUnique: async () => ({ timezone: opts.timezone ?? "Europe/London" }) },
    class: { findMany: async () => [], count: async () => 0 },
    classInstance: { findMany: async () => [] },
    attendanceRecord: { findMany: async () => [], groupBy: async () => [], count: async () => 0 },
    payment: { count: async () => 0, findMany: async () => [] },
    member: {
      count: memberCount,
      findMany: async (args?: { where?: Where; select?: Record<string, unknown>; take?: number }) => {
        const found = matchRows(members, args?.where).slice(0, args?.take ?? Infinity);
        if (!args?.select) return found;
        return found.map((r) => Object.fromEntries(Object.keys(args.select!).map((k) => [k, r[k]])));
      },
      groupBy: async (args: { by: string[]; where?: Where }) => {
        const groups = new Map<string, number>();
        for (const r of matchRows(members, args.where)) {
          const k = String(r[args.by[0]]);
          groups.set(k, (groups.get(k) ?? 0) + 1);
        }
        return Array.from(groups, ([k, n]) => ({ [args.by[0]]: k, _count: n }));
      },
    },
  };
}
