/**
 * Keep closed clubs (product rule, Noe, 16 Oct 2026): a closed club can be
 * reopened at ANY time. There is no recovery window. The only refusals left are
 * the race rules that protect an explicit, operator-run erasure: a claimed club
 * (`purgeStartedAt` set) is never reopened, and a club whose row is gone with an
 * erasure-evidence row reports "permanently deleted".
 *
 * `restoreSoftDeletedTenant` is exercised against a tiny in-memory Tenant table
 * whose `updateMany` honours the conditional WHERE exactly as Postgres would
 * (the same approach as tests/unit/tenant-lifecycle-constraints.test.ts), so a
 * re-introduced `deletedAt >= cutoff` predicate makes the 400-day case go red.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { restoreRefusal, restoreSoftDeletedTenant } from "@/lib/tenant-lifecycle";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-16T10:00:00.000Z");

type Row = { id: string; deletedAt: Date | null; purgeStartedAt: Date | null };
let rows: Row[] = [];
let evidence: Array<{ action: string; entityType: string; entityId: string }> = [];
const updates: unknown[] = [];

/** A deliberately small evaluator for the where-clauses the lifecycle module writes. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const v = (row as Record<string, unknown>)[key];
    if (cond === null) return v === null;
    if (typeof cond !== "object") return v === cond;
    const c = cond as { not?: unknown; gte?: Date; lt?: Date };
    if ("not" in c && c.not === null && v === null) return false;
    if (c.gte && !(v instanceof Date && v.getTime() >= c.gte.getTime())) return false;
    if (c.lt && !(v instanceof Date && v.getTime() < c.lt.getTime())) return false;
    return true;
  });
}

const tx = {
  tenant: {
    updateMany: async (args: { where: Record<string, unknown>; data: Partial<Row> }) => {
      updates.push(args);
      const hit = rows.filter((r) => matches(r, args.where));
      for (const r of hit) Object.assign(r, args.data);
      return { count: hit.length };
    },
    findUnique: async (args: { where: { id: string } }) => rows.find((r) => r.id === args.where.id) ?? null,
  },
  auditLog: {
    findFirst: async (args: { where: { action: string; entityType: string; entityId: string } }) =>
      evidence.find((e) => e.action === args.where.action && e.entityType === args.where.entityType && e.entityId === args.where.entityId) ?? null,
  },
} as unknown as Parameters<typeof restoreSoftDeletedTenant>[0];

beforeEach(() => {
  rows = [];
  evidence = [];
  updates.length = 0;
});

describe("(b) reopen at any time: no recovery window", () => {
  it("restores a club closed 400 days ago when no erasure has claimed it", async () => {
    rows = [{ id: "t1", deletedAt: new Date(NOW.getTime() - 400 * DAY_MS), purgeStartedAt: null }];
    expect(await restoreSoftDeletedTenant(tx, "t1")).toEqual({ kind: "restored" });
    expect(rows[0].deletedAt).toBeNull();
    // ONE conditional write, keyed only on "closed and unclaimed" — no date predicate.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      where: { id: "t1", deletedAt: { not: null }, purgeStartedAt: null },
      data: { deletedAt: null },
    });
  });

  it("restores a club closed 31 days ago and one closed a minute ago alike", async () => {
    rows = [
      { id: "old", deletedAt: new Date(NOW.getTime() - 31 * DAY_MS), purgeStartedAt: null },
      { id: "new", deletedAt: new Date(NOW.getTime() - 60_000), purgeStartedAt: null },
    ];
    expect(await restoreSoftDeletedTenant(tx, "old")).toEqual({ kind: "restored" });
    expect(await restoreSoftDeletedTenant(tx, "new")).toEqual({ kind: "restored" });
    expect(rows.every((r) => r.deletedAt === null)).toBe(true);
  });

  it("a club that is open is 'not-deleted' (409), and nothing is written", async () => {
    rows = [{ id: "t1", deletedAt: null, purgeStartedAt: null }];
    const out = await restoreSoftDeletedTenant(tx, "t1");
    expect(out).toEqual({ kind: "not-deleted" });
    expect(restoreRefusal(out as Exclude<typeof out, { kind: "restored" }>)).toMatchObject({ status: 409, state: "not-deleted" });
  });
});

describe("(c) the erasure race rules stay", () => {
  it("refuses a claimed club (purgeStartedAt set) however recently it closed, and leaves it closed", async () => {
    const claimedAt = new Date(NOW.getTime() - 60_000);
    rows = [{ id: "t1", deletedAt: new Date(NOW.getTime() - DAY_MS), purgeStartedAt: claimedAt }];
    const out = await restoreSoftDeletedTenant(tx, "t1");
    expect(out).toEqual({ kind: "purge-in-progress", purgeStartedAt: claimedAt });
    expect(restoreRefusal(out as Exclude<typeof out, { kind: "restored" }>)).toMatchObject({ status: 409, state: "deletion-in-progress" });
    expect(rows[0].deletedAt).not.toBeNull();
  });

  it("reports 'permanently-deleted' when the row is gone and an erasure-evidence row exists", async () => {
    rows = [];
    evidence = [{ action: "admin.tenant.hard_deleted", entityType: "Tenant", entityId: "t1" }];
    const out = await restoreSoftDeletedTenant(tx, "t1");
    expect(out).toEqual({ kind: "permanently-deleted" });
    expect(restoreRefusal(out as Exclude<typeof out, { kind: "restored" }>)).toMatchObject({ status: 409, state: "permanently-deleted" });
  });

  it("reports 'not-found' when the row is gone and there is no erasure evidence (an id that never existed)", async () => {
    rows = [];
    expect(await restoreSoftDeletedTenant(tx, "nope")).toEqual({ kind: "not-found" });
  });
});
