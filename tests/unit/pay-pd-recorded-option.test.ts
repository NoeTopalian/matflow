// Payments lane PD (11 Oct 2026, review RP-5) — runStripeEvent's `recorded`
// option. The webhook records the event BEFORE its pre-transaction lookups
// (prepareStripeEvent) so that a lookup failure still leaves the row
// `received` with the attempt counted; it then passes that record to
// runStripeEvent, which must not count the same delivery twice.
//
// The database is an in-memory fake of exactly the StripeEvent operations the
// store issues (createMany skipDuplicates, conditional updateMany, findUnique,
// update), so the attempt arithmetic is checked without a network. The same
// behaviour on Postgres: tests/integration/pay-pd-event-store-db.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = { eventId: string; status: string; attempts: number; tenantId: string | null; lastError: string | null };
const db = vi.hoisted(() => ({ rows: new Map<string, Row>() }));

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    const actual = (row as unknown as Record<string, unknown>)[k];
    if (v && typeof v === "object" && "in" in (v as object)) {
      if (!(v as { in: unknown[] }).in.includes(actual)) return false;
    } else if (actual !== v) return false;
  }
  return true;
}

vi.mock("@/lib/prisma-tenant", () => {
  const stripeEvent = {
    createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
      let count = 0;
      for (const d of data) {
        if (db.rows.has(d.eventId as string)) continue;
        db.rows.set(d.eventId as string, {
          eventId: d.eventId as string,
          status: d.status as string,
          attempts: d.attempts as number,
          tenantId: (d.tenantId as string | null) ?? null,
          lastError: null,
        });
        count++;
      }
      return { count };
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of db.rows.values()) {
        if (!matches(row, where)) continue;
        count++;
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in (v as object)) {
            (row as unknown as Record<string, number>)[k] += (v as { increment: number }).increment;
          } else if (!(v instanceof Date)) {
            (row as unknown as Record<string, unknown>)[k] = v;
          }
        }
      }
      return { count };
    },
    findUnique: async ({ where }: { where: { eventId: string } }) => {
      const r = db.rows.get(where.eventId);
      return r ? { ...r } : null;
    },
    update: async ({ where, data }: { where: { eventId: string }; data: Record<string, unknown> }) => {
      const r = db.rows.get(where.eventId)!;
      for (const [k, v] of Object.entries(data)) if (!(v instanceof Date)) (r as unknown as Record<string, unknown>)[k] = v;
      return r;
    },
  };
  const tx = { stripeEvent, tenant: { findFirst: async () => ({ id: "t1" }) } };
  return { withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx) };
});
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { recordReceived, runStripeEvent, StripeEventRetryableError, type StripeEventProcessor } from "@/lib/stripe/event-store";

const ev = (id: string) => ({ id, type: "invoice.payment_succeeded", account: "acct_1", livemode: false, created: 1760000000, data: { object: { id: "in_1" } } });
const processed: StripeEventProcessor = async () => ({ outcome: "processed", tenantId: "t1" });

beforeEach(() => db.rows.clear());

describe("pay-pd: runStripeEvent with a recorded delivery", () => {
  it("route-style call (recordReceived, then runStripeEvent with recorded) counts exactly one attempt", async () => {
    const recorded = await recordReceived(ev("evt_route"));
    expect(db.rows.get("evt_route")).toMatchObject({ status: "received", attempts: 1 });
    const r = await runStripeEvent(ev("evt_route"), processed, { recorded });
    expect(r.kind).toBe("processed");
    expect(db.rows.get("evt_route")).toMatchObject({ status: "processed", attempts: 1 });
  });

  it("the old two-argument call shape still counts one attempt", async () => {
    const r = await runStripeEvent(ev("evt_old"), processed);
    expect(r.kind).toBe("processed");
    expect(db.rows.get("evt_old")).toMatchObject({ status: "processed", attempts: 1 });
  });

  it("recorded, then the lookups fail before processing: the row stays received with the attempt counted; the next delivery is attempt 2 and processes once", async () => {
    await recordReceived(ev("evt_lookup"));
    // prepareStripeEvent threw (a Stripe lookup failed): runStripeEvent never ran.
    expect(db.rows.get("evt_lookup")).toMatchObject({ status: "received", attempts: 1 });
    const second = await recordReceived(ev("evt_lookup"));
    const r = await runStripeEvent(ev("evt_lookup"), processed, { recorded: second });
    expect(r.kind).toBe("processed");
    expect(db.rows.get("evt_lookup")).toMatchObject({ status: "processed", attempts: 2 });
  });

  it("a recorded delivery whose handler fails is recorded failed with the message masked, attempts unchanged by the run", async () => {
    const recorded = await recordReceived(ev("evt_fail"));
    const failing: StripeEventProcessor = async () => {
      throw new StripeEventRetryableError("lookup refused: Invalid API Key provided: sk_test_51Abc****wxyz for owner@example.test");
    };
    const r = await runStripeEvent(ev("evt_fail"), failing, { recorded });
    expect(r).toMatchObject({ kind: "failed", retryable: true });
    const row = db.rows.get("evt_fail")!;
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
    expect(row.lastError).toContain("sk_test_[masked]");
    expect(row.lastError).toContain("[email]");
    expect(row.lastError).not.toMatch(/51Abc|owner@example/);
  });

  it("a record for a DIFFERENT event is ignored: the store records this one itself", async () => {
    const other = await recordReceived(ev("evt_other"));
    await runStripeEvent(ev("evt_mine"), processed, { recorded: other });
    expect(db.rows.get("evt_mine")).toMatchObject({ status: "processed", attempts: 1 });
    expect(db.rows.get("evt_other")).toMatchObject({ status: "received", attempts: 1 });
  });

  it("an already-processed record short-circuits without running the processor", async () => {
    await runStripeEvent(ev("evt_done"), processed);
    const recorded = await recordReceived(ev("evt_done"));
    const spy = vi.fn(processed);
    const r = await runStripeEvent(ev("evt_done"), spy, { recorded });
    expect(r).toEqual({ kind: "already_processed", status: "processed" });
    expect(spy).not.toHaveBeenCalled();
    expect(db.rows.get("evt_done")).toMatchObject({ attempts: 1 });
  });
});
