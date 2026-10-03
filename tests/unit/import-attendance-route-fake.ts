/**
 * An in-memory stand-in for the Prisma transaction client the attendance
 * import touches (app/api/admin/import/attendance, lib/attendance-import.ts,
 * lib/import-upload.ts). Used by import-attendance-route.test.ts.
 *
 * Deliberately NOT tenant-aware: it returns whatever the `where` the code sent
 * matches, so a missing `tenantId` filter in the code under test is visible as
 * a cross-tenant read or write — the fake does not hide it the way RLS would.
 *
 * Supports exactly the shapes the code sends: column equality (Dates by
 * value), null, `in`, `notIn`, `not`, `lt`, `lte`, `gt`, `gte`, `OR`, `AND`,
 * `NOT`, one-hop relation filters and selects (`class`, `classInstance`,
 * `member`), `_count` selects, compound-unique keys (`a_b_c: {…}`), orderBy,
 * skip/take, createMany with skipDuplicates, and groupBy with `_count._all`.
 */
import { Prisma } from "@prisma/client";

export type Row = Record<string, unknown> & { id: string };

const MODELS = [
  "tenant", "member", "class", "location", "importSourceMapping", "importUpload", "importUploadChunk",
  "importJob", "importedBooking", "classInstance", "attendanceRecord",
] as const;
export type Model = (typeof MODELS)[number];

/** Relation name → [target model, foreign-key column on this row]. */
const RELATIONS: Partial<Record<Model, Record<string, [Model, string]>>> = {
  classInstance: { class: ["class", "classId"] },
  attendanceRecord: { classInstance: ["classInstance", "classInstanceId"], member: ["member", "memberId"] },
  importedBooking: { member: ["member", "memberId"] },
};

const DEFAULTS: Partial<Record<Model, () => Record<string, unknown>>> = {
  member: () => ({ externalRef: null }),
  class: () => ({ isActive: true, deletedAt: null, sourceImportJobId: null, locationId: null }),
  importSourceMapping: () => ({ targetId: null, decidedAt: new Date() }),
  importJob: () => ({
    createdAt: new Date(), startedAt: null, completedAt: null, rolledBackAt: null, leaseUntil: null, leaseToken: null,
    manifest: null, errorLog: null, mappings: null, dryRunSummary: null, processedRows: 0, importedRows: 0, skippedRows: 0,
    errorRows: 0, totalRows: 0, sourceExportedAt: null, sourceExportedAtProvenance: null, fileHash: null,
  }),
  importedBooking: () => ({ previousState: null, memberId: null }),
  classInstance: () => ({ sourceImportJobId: null, endTime: null }),
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) && !(v instanceof Uint8Array);

const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

const OPS = new Set(["in", "notIn", "not", "lt", "lte", "gt", "gte", "equals"]);

function matchValue(val: unknown, cond: unknown): boolean {
  if (cond === null) return val === null || val === undefined;
  if (cond instanceof Date) return val instanceof Date && val.getTime() === cond.getTime();
  if (isPlainObject(cond) && Object.keys(cond).every((k) => OPS.has(k))) {
    return Object.entries(cond).every(([op, arg]) => {
      switch (op) {
        case "in": return (arg as unknown[]).some((x) => same(val, x));
        case "notIn": return !(arg as unknown[]).some((x) => same(val, x));
        case "not": return !matchValue(val, arg);
        case "equals": return matchValue(val, arg);
        case "lt": return val != null && (val as number) < (arg as number);
        case "lte": return val != null && (val as number) <= (arg as number);
        case "gt": return val != null && (val as number) > (arg as number);
        case "gte": return val != null && (val as number) >= (arg as number);
      }
      return false;
    });
  }
  return same(val, cond);
}

function flattenUnique(where: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(where)) {
    if (k.includes("_") && isPlainObject(v) && !Object.keys(v).some((x) => OPS.has(x))) Object.assign(out, v);
    else out[k] = v;
  }
  return out;
}

const writeValue = (v: unknown) => (v === Prisma.DbNull || v === Prisma.JsonNull ? null : v);

export function makeAttendanceFakeDb() {
  const tables = Object.fromEntries(MODELS.map((m) => [m, [] as Row[]])) as Record<Model, Row[]>;
  let seq = 0;
  const writes: { model: Model; op: string }[] = [];

  function related(model: Model, row: Row, rel: string): Row | null {
    const r = RELATIONS[model]?.[rel];
    if (!r) return null;
    const [target, fk] = r;
    return tables[target].find((x) => x.id === row[fk]) ?? null;
  }

  function matches(model: Model, row: Row, where: Record<string, unknown> | undefined): boolean {
    if (!where) return true;
    return Object.entries(flattenUnique(where)).every(([k, v]) => {
      if (v === undefined) return true;
      if (k === "OR") return (v as Record<string, unknown>[]).some((w) => matches(model, row, w));
      if (k === "AND") return (v as Record<string, unknown>[]).every((w) => matches(model, row, w));
      if (k === "NOT") return Array.isArray(v) ? !v.some((w) => matches(model, row, w)) : !matches(model, row, v as Record<string, unknown>);
      const rel = RELATIONS[model]?.[k];
      if (rel) {
        const target = related(model, row, k);
        return !!target && matches(rel[0], target, v as Record<string, unknown>);
      }
      return matchValue(row[k], v);
    });
  }

  function countOf(model: Model, row: Row, rel: string): number {
    if (model === "classInstance" && rel === "attendances") return tables.attendanceRecord.filter((a) => a.classInstanceId === row.id).length;
    if (model === "classInstance" && rel === "waitlists") return 0;
    if (model === "class" && rel === "instances") return tables.classInstance.filter((c) => c.classId === row.id).length;
    // Not modelled here: no test seeds a schedule, subscription or roster row.
    if (model === "class" && (rel === "schedules" || rel === "subscriptions" || rel === "rosterMembers")) return 0;
    throw new Error(`fake: no _count for ${model}.${rel}`);
  }

  function project(model: Model, row: Row, select: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!select) return structuredCloneRow(row);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(select)) {
      if (!v) continue;
      if (k === "_count") {
        const sel = (v as { select: Record<string, unknown> }).select;
        out._count = Object.fromEntries(Object.keys(sel).map((rel) => [rel, countOf(model, row, rel)]));
        continue;
      }
      const rel = RELATIONS[model]?.[k];
      if (rel && isPlainObject(v)) {
        const target = related(model, row, k);
        out[k] = target ? project(rel[0], target, (v as { select?: Record<string, unknown> }).select) : null;
        continue;
      }
      out[k] = copy(row[k]);
    }
    return out;
  }

  function copy(v: unknown): unknown {
    if (v instanceof Date) return new Date(v.getTime());
    if (v instanceof Uint8Array) return Buffer.from(v);
    if (Array.isArray(v) || isPlainObject(v)) return JSON.parse(JSON.stringify(v));
    return v;
  }
  function structuredCloneRow(row: Row): Row {
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, copy(v)])) as Row;
  }

  function sorted(rows: Row[], orderBy: unknown): Row[] {
    if (!orderBy) return rows;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o as Record<string, "asc" | "desc">));
    return [...rows].sort((a, b) => {
      for (const [k, dir] of keys) {
        const x = a[k] instanceof Date ? (a[k] as Date).getTime() : (a[k] as string | number);
        const y = b[k] instanceof Date ? (b[k] as Date).getTime() : (b[k] as string | number);
        if (x < y) return dir === "asc" ? -1 : 1;
        if (x > y) return dir === "asc" ? 1 : -1;
      }
      return 0;
    });
  }

  function insert(model: Model, data: Record<string, unknown>): Row {
    const row = { ...(DEFAULTS[model]?.() ?? {}), id: `${model}-${++seq}` } as Row;
    for (const [k, v] of Object.entries(data)) row[k] = writeValue(v);
    tables[model].push(row);
    return row;
  }

  function apply(row: Row, data: Record<string, unknown>) {
    for (const [k, v] of Object.entries(data)) row[k] = writeValue(v);
  }

  function delegate(model: Model) {
    type Args = { where?: Record<string, unknown>; select?: Record<string, unknown>; orderBy?: unknown; data?: unknown; take?: number; skip?: number };
    const find = (a: Args = {}) => sorted(tables[model].filter((r) => matches(model, r, a.where)), a.orderBy);
    return {
      findFirst: async (a: Args = {}) => { const r = find(a)[0]; return r ? project(model, r, a.select) : null; },
      findFirstOrThrow: async (a: Args = {}) => { const r = find(a)[0]; if (!r) throw new Error(`fake: ${model} not found`); return project(model, r, a.select); },
      findUnique: async (a: Args = {}) => { const r = find(a)[0]; return r ? project(model, r, a.select) : null; },
      findMany: async (a: Args = {}) => find(a).slice(a.skip ?? 0, (a.skip ?? 0) + (a.take ?? Infinity)).map((r) => project(model, r, a.select)),
      count: async (a: Args = {}) => find(a).length,
      create: async (a: Args) => { writes.push({ model, op: "create" }); return project(model, insert(model, a.data as Record<string, unknown>), a.select); },
      createMany: async (a: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const d of a.data) {
          if (a.skipDuplicates && model === "classInstance" && tables.classInstance.some((c) => c.classId === d.classId && same(c.date, d.date) && c.startTime === d.startTime)) continue;
          insert(model, d);
          count++;
        }
        writes.push({ model, op: "createMany" });
        return { count };
      },
      update: async (a: Args) => {
        const r = find(a)[0];
        if (!r) throw new Error(`fake: ${model} to update not found`);
        apply(r, a.data as Record<string, unknown>);
        writes.push({ model, op: "update" });
        return project(model, r, a.select);
      },
      updateMany: async (a: Args) => {
        const rows = find(a);
        for (const r of rows) apply(r, a.data as Record<string, unknown>);
        if (rows.length) writes.push({ model, op: "updateMany" });
        return { count: rows.length };
      },
      upsert: async (a: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const r = find({ where: a.where })[0];
        writes.push({ model, op: "upsert" });
        if (r) { apply(r, a.update); return r; }
        return insert(model, a.create);
      },
      delete: async (a: Args) => {
        const r = find(a)[0];
        if (!r) throw new Error(`fake: ${model} to delete not found`);
        tables[model].splice(tables[model].indexOf(r), 1);
        writes.push({ model, op: "delete" });
        return r;
      },
      deleteMany: async (a: Args = {}) => {
        const rows = find(a);
        for (const r of rows) tables[model].splice(tables[model].indexOf(r), 1);
        if (rows.length) writes.push({ model, op: "deleteMany" });
        return { count: rows.length };
      },
      groupBy: async (a: { by: string[]; where?: Record<string, unknown> }) => {
        const groups = new Map<string, { key: Record<string, unknown>; n: number }>();
        for (const r of find({ where: a.where })) {
          const key = Object.fromEntries(a.by.map((k) => [k, r[k]]));
          const id = JSON.stringify(key);
          const g = groups.get(id) ?? { key, n: 0 };
          g.n++;
          groups.set(id, g);
        }
        return [...groups.values()].map((g) => ({ ...g.key, _count: { _all: g.n } }));
      },
    };
  }

  const tx = Object.fromEntries(MODELS.map((m) => [m, delegate(m)]));
  return {
    tables,
    writes,
    tx: tx as never,
    seed(model: Model, data: Record<string, unknown>): Row {
      return insert(model, data);
    },
  };
}

export type AttendanceFakeDb = ReturnType<typeof makeAttendanceFakeDb>;
