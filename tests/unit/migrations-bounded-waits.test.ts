// Every migration from the plan-limits release onwards bounds its own waits (brief S2.2, 24 Oct 2026).
//
// A migration's ALTER TABLE needs ACCESS EXCLUSIVE. Without a lock_timeout it waits for as long as any open transaction
// holds a lock on the table, and every later request on that table queues behind the waiting ALTER: the app stalls for
// as long as the longest transaction in flight. `SET LOCAL lock_timeout` right after BEGIN makes the deploy fail
// instead (55P03, nothing of the file applied — see migrations-are-atomic.test.ts), and the redeploy is retried.
//
// The values, and why (measured on the clean-baseline rehearsal, docs/readiness/MIGRATION-SAFETY-2026-10-24.md):
// - lock_timeout 5 s is strictly BELOW the app's own lock bound (lib/prisma-tenant.ts TENANT_LOCK_BOUND_MS, 10 s), so
//   an app request queued behind a waiting migration is delayed, never failed by its own bound; and it is long enough
//   to outlast the app's ordinary short transactions.
// - statement_timeout 15 s is ABOVE lock_timeout (a lock wait counts toward statement_timeout, so with the two equal a
//   lock wait would end as 57014 rather than 55P03), and far above the longest statement measured on the rehearsal
//   data; it bounds how long one runaway statement can keep a table exclusively locked.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TENANT_LOCK_BOUND_MS } from "@/lib/prisma-tenant";

const DIR = join(process.cwd(), "prisma", "migrations");
/** The first migration of the plan-limits release (PR #41); everything from here on is bounded. */
const FROM = "20261017020102";
const recent = readdirSync(DIR).filter((d) => /^\d{14}_/.test(d) && d.slice(0, 14) >= FROM).sort();

const ms = (v: string) => {
  const m = v.match(/^'(\d+)(ms|s|min)'$/);
  if (!m) throw new Error(`unparsed duration ${v}`);
  return Number(m[1]) * { ms: 1, s: 1000, min: 60_000 }[m[2] as "ms" | "s" | "min"];
};

function statements(sql: string): string[] {
  return sql.split(/\r?\n/).map((l) => l.replace(/--.*$/, "").trim()).filter(Boolean);
}

describe("migrations bound their lock waits and statements", () => {
  it("covers the release's six migrations (sanity)", () => {
    expect(recent.length).toBeGreaterThanOrEqual(6);
    expect(recent[0]).toBe("20261017020102_class_membership_tier");
  });

  it.each(recent)("%s sets lock_timeout then statement_timeout, transaction-local, straight after BEGIN", (dir) => {
    const lines = statements(readFileSync(join(DIR, dir, "migration.sql"), "utf8"));
    expect(lines[0]).toBe("BEGIN;");
    const lock = lines[1]?.match(/^SET LOCAL lock_timeout = ('[^']+');$/);
    const stmt = lines[2]?.match(/^SET LOCAL statement_timeout = ('[^']+');$/);
    expect(lock, `${dir}: second statement must be SET LOCAL lock_timeout`).toBeTruthy();
    expect(stmt, `${dir}: third statement must be SET LOCAL statement_timeout`).toBeTruthy();
    const lockMs = ms(lock![1]);
    const stmtMs = ms(stmt![1]);
    expect(lockMs).toBeGreaterThan(0);
    expect(lockMs).toBeLessThan(stmtMs);
    expect(lockMs).toBeLessThan(TENANT_LOCK_BOUND_MS);
    // Session-level SET would outlive the file on the migration connection; only SET LOCAL is admitted.
    expect(lines.filter((l) => /^SET (?!LOCAL)/i.test(l))).toEqual([]);
  });
});
