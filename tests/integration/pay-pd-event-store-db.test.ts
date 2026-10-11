// Payments lane PD (11 Oct 2026) — the durable Stripe event store against a REAL
// database (Neon TEST branch only, through the guarded runners: owner role via
// att/run-engine.sh and matflow_app with RLS enforced via q78/run-restricted.sh).
//
// Real: lib/stripe/event-store.ts (recordReceived, claimStripeEvent, mark*,
// runStripeEvent), lib/stripe/replay.ts, the audit writer, Payment rows and
// the StripeEvent row lock. Stubbed: email delivery (counted) and the one
// Stripe call replay makes (events.retrieve). The processors here stand in for
// the webhook handler lane PC wires in; they write real Payment and audit rows.
//
// Proofs (brief PD §5): (a) duplicate delivery, sequential and concurrent →
// one processing, one Payment row, one audit row; (b) out-of-order events →
// both recorded with Stripe's created; (c) crash after the Payment insert →
// no Payment row, row failed with the error, retry processes once; (d) replay
// of a failed event after the cause is removed → processed once, replayed,
// operator audit; (e) forced replay of a processed invoice.payment_succeeded →
// no second Payment row, no second audit row, no second email.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const h = vi.hoisted(() => ({ emails: [] as unknown[] }));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async (e: unknown) => {
    h.emails.push(e);
    return { ok: true, logId: "mail-test" };
  }),
}));

import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import {
  claimStripeEvent,
  markProcessed,
  recordReceived,
  runStripeEvent,
  StripeEventRetryableError,
  type ProcessorResult,
  type StripeEventProcessor,
} from "@/lib/stripe/event-store";
import { replayStripeEvent, REPLAY_AUDIT_ACTION, type FreshStripeEvent } from "@/lib/stripe/replay";

const HAS_DB = !!process.env.DATABASE_URL;
const RLS = process.env.RLS_ENFORCED === "1";
const STAMP = `paypd-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TENANT = `${STAMP}-t`;
const OTHER = `${STAMP}-o`;
const ACCT = `acct_${STAMP.replace(/-/g, "")}`;
const MEMBER = `${STAMP}-m`;
const NOW = Math.floor(Date.now() / 1000);
let seq = 0;
const evtId = (tag: string) => `evt_${STAMP.replace(/-/g, "")}_${tag}_${++seq}`;

function invoiceEvent(id: string, invoiceId: string, created = NOW): FreshStripeEvent {
  return {
    id,
    type: "invoice.payment_succeeded",
    account: ACCT,
    livemode: false,
    created,
    data: { object: { id: invoiceId, object: "invoice", amount_paid: 4500, currency: "gbp" } },
  };
}

/** NOT idempotent on purpose: every run inserts a Payment and queues an audit + an email. */
const naiveProcessor: StripeEventProcessor<FreshStripeEvent> = async (event, { tx }) => {
  await tx.payment.create({
    data: { tenantId: TENANT, memberId: MEMBER, amountPence: 4500, currency: "GBP", status: "succeeded", description: event.id },
  });
  return paidEffects(event);
};

/** Idempotent the way the real handler is: upsert on the unique stripeInvoiceId. Effects queued every run. */
const upsertProcessor: StripeEventProcessor<FreshStripeEvent> = async (event, { tx }) => {
  const invoiceId = event.data.object.id as string;
  await tx.payment.upsert({
    where: { stripeInvoiceId: invoiceId },
    create: {
      tenantId: TENANT, memberId: MEMBER, stripeInvoiceId: invoiceId, amountPence: 4500, currency: "GBP",
      status: "succeeded", description: event.id, paidAt: new Date(),
    },
    update: { status: "succeeded" },
  });
  return paidEffects(event);
};

function paidEffects(event: FreshStripeEvent): ProcessorResult {
  return {
    outcome: "processed",
    tenantId: TENANT,
    audits: [{ tenantId: TENANT, userId: null, action: "member.payment.succeeded", entityType: "Member", entityId: MEMBER, metadata: { stripeEventId: event.id } }],
    emails: [{ tenantId: TENANT, templateId: "payment_succeeded", to: `${STAMP}@example.test`, vars: {} } as never],
  };
}

const paymentsFor = (description: string) =>
  withRlsBypass((tx) => tx.payment.count({ where: { tenantId: TENANT, description } }));
const paymentsForInvoice = (stripeInvoiceId: string) =>
  withRlsBypass((tx) => tx.payment.count({ where: { tenantId: TENANT, stripeInvoiceId } }));
const auditsFor = (eventId: string, action = "member.payment.succeeded") =>
  withRlsBypass((tx) =>
    tx.auditLog.count({ where: { tenantId: TENANT, action, metadata: { path: ["stripeEventId"], equals: eventId } } }),
  );
const rowOf = (eventId: string) => withRlsBypass((tx) => tx.stripeEvent.findUnique({ where: { eventId } }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!HAS_DB)("pay-pd: durable Stripe event store", () => {
  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.tenant.create({ data: { id: TENANT, name: `${STAMP} club`, slug: TENANT, stripeAccountId: ACCT, stripeConnected: true } });
      await tx.tenant.create({ data: { id: OTHER, name: `${STAMP} other`, slug: OTHER } });
      await tx.member.create({ data: { id: MEMBER, tenantId: TENANT, email: `${STAMP}-m@example.test`, name: "PD member" } });
    });
  }, 120_000);

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.stripeEvent.deleteMany({ where: { eventId: { startsWith: `evt_${STAMP.replace(/-/g, "")}` } } });
      await tx.auditLog.deleteMany({ where: { tenantId: { in: [TENANT, OTHER] } } });
      await tx.payment.deleteMany({ where: { tenantId: TENANT } });
      await tx.member.deleteMany({ where: { tenantId: TENANT } });
      await tx.tenant.deleteMany({ where: { id: { in: [TENANT, OTHER] } } });
    });
    const left = await withRlsBypass((tx) => tx.tenant.count({ where: { id: { in: [TENANT, OTHER] } } }));
    expect(left).toBe(0);
  }, 120_000);

  it("records the event in its own commit before processing, attributed to the club", async () => {
    const id = evtId("rec");
    const r = await recordReceived(invoiceEvent(id, `in_${STAMP}_rec`));
    expect(r).toMatchObject({ status: "received", attempts: 1, tenantId: TENANT, alreadyProcessed: false });
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "received", attempts: 1, tenantId: TENANT, stripeAccountId: ACCT, objectId: `in_${STAMP}_rec`, livemode: false, created: NOW });
    const again = await recordReceived(invoiceEvent(id, `in_${STAMP}_rec`));
    expect(again.attempts).toBe(2);
  });

  it("(a) duplicate delivery, sequential: one processing, one Payment row, one audit row, one email", async () => {
    const id = evtId("dup");
    h.emails.length = 0;
    const first = await runStripeEvent(invoiceEvent(id, `in_${STAMP}_dup`), naiveProcessor);
    const second = await runStripeEvent(invoiceEvent(id, `in_${STAMP}_dup`), naiveProcessor);
    expect(first).toMatchObject({ kind: "processed", status: "processed", tenantId: TENANT, auditsWritten: 1, emailsSent: 1 });
    expect(second).toEqual({ kind: "already_processed", status: "processed" });
    expect(await paymentsFor(id)).toBe(1);
    expect(await auditsFor(id)).toBe(1);
    expect(h.emails).toHaveLength(1);
    expect(await rowOf(id)).toMatchObject({ status: "processed", lastError: null });
  });

  it("(a) duplicate delivery, concurrent on two connections: exactly one processes", async () => {
    const id = evtId("conc");
    h.emails.length = 0;
    const slow: StripeEventProcessor<FreshStripeEvent> = async (event, ctx) => {
      const out = await naiveProcessor(event, ctx);
      await sleep(1500); // hold the row lock while the second delivery arrives
      return out;
    };
    const [a, b] = await Promise.all([
      runStripeEvent(invoiceEvent(id, `in_${STAMP}_conc`), slow),
      sleep(200).then(() => runStripeEvent(invoiceEvent(id, `in_${STAMP}_conc`), slow)),
    ]);
    // The second waits on the row lock, then finds the row terminal.
    expect([a.kind, b.kind].sort()).toEqual(["already_processed", "processed"]);
    expect(await paymentsFor(id)).toBe(1);
    expect(await auditsFor(id)).toBe(1);
    expect(h.emails).toHaveLength(1);
    // A third delivery after both: terminal, nothing runs.
    expect((await runStripeEvent(invoiceEvent(id, `in_${STAMP}_conc`), slow)).kind).toBe("already_processed");
    expect(await paymentsFor(id)).toBe(1);
  }, 30_000);

  it("the row is the lock: a second claim waits for the holder, then sees its outcome", async () => {
    // Holder commits a terminal status → the waiting claim finds it done.
    const id = evtId("lock");
    await recordReceived(invoiceEvent(id, `in_${STAMP}_lock`));
    const order: string[] = [];
    const holder = withRlsBypass(async (tx) => {
      order.push(`holder:${(await claimStripeEvent(tx, id)).kind}`);
      await sleep(1500);
      await markProcessed(tx, id);
      order.push("holder:committing");
    });
    await sleep(400);
    const second = await withRlsBypass(async (tx) => {
      const c = await claimStripeEvent(tx, id);
      order.push(`second:${c.kind}`);
      return c;
    });
    await holder;
    expect(order).toEqual(["holder:claimed", "holder:committing", "second:done"]);
    expect(second).toEqual({ kind: "done", status: "processed" });

    // Holder rolls back (a crash) → the waiting claim gets the row.
    const id2 = evtId("lock2");
    await recordReceived(invoiceEvent(id2, `in_${STAMP}_lock2`));
    const holder2 = withRlsBypass(async (tx) => {
      await claimStripeEvent(tx, id2);
      await sleep(1500);
      throw new Error("simulated crash while holding the row");
    }).then(() => "committed", () => "rolled back");
    await sleep(400);
    const second2 = await withRlsBypass((tx) => claimStripeEvent(tx, id2));
    expect(await holder2).toBe("rolled back");
    expect(second2).toEqual({ kind: "claimed", status: "received" });
    expect(await withRlsBypass((tx) => claimStripeEvent(tx, `${id}_absent`))).toEqual({ kind: "missing" });
  }, 30_000);

  it("(b) out-of-order events: both recorded with Stripe's own created", async () => {
    const newer = evtId("newer");
    const older = evtId("older");
    const sub = `sub_${STAMP}_ooo`;
    const ev = (id: string, created: number): FreshStripeEvent => ({
      id, type: "customer.subscription.updated", account: ACCT, livemode: false, created,
      data: { object: { id: sub, status: created > NOW ? "active" : "past_due" } },
    });
    const seen: string[] = [];
    const recordOnly: StripeEventProcessor<FreshStripeEvent> = async (e) => {
      seen.push(e.id);
      return { outcome: e.created < NOW + 60 ? "ignored_stale" : "processed", tenantId: TENANT };
    };
    expect((await runStripeEvent(ev(newer, NOW + 120), recordOnly)).kind).toBe("processed");
    expect((await runStripeEvent(ev(older, NOW + 30), recordOnly)).kind).toBe("ignored_stale");
    const rows = await withRlsBypass((tx) =>
      tx.stripeEvent.findMany({ where: { objectId: sub }, orderBy: { created: "asc" }, select: { eventId: true, created: true, status: true } }),
    );
    expect(rows).toEqual([
      { eventId: older, created: NOW + 30, status: "ignored_stale" },
      { eventId: newer, created: NOW + 120, status: "processed" },
    ]);
    expect(seen).toEqual([newer, older]);
  });

  it("(c) crash after the Payment insert, before commit: no Payment, row failed with the error, retry processes once", async () => {
    const id = evtId("crash");
    let crash = true;
    const crashing: StripeEventProcessor<FreshStripeEvent> = async (event, ctx) => {
      const out = await naiveProcessor(event, ctx);
      if (crash) throw new Error("simulated crash after insert (member pd@example.test)");
      return out;
    };
    const first = await runStripeEvent(invoiceEvent(id, `in_${STAMP}_crash`), crashing);
    expect(first).toMatchObject({ kind: "failed", retryable: false });
    expect(await paymentsFor(id)).toBe(0);
    expect(await auditsFor(id)).toBe(0);
    const failed = await rowOf(id);
    expect(failed).toMatchObject({ status: "failed", attempts: 1 });
    expect(failed?.lastError).toContain("simulated crash after insert");
    expect(failed?.lastError).not.toContain("pd@example.test"); // addresses masked
    // Stripe retries after the cause is gone.
    crash = false;
    const retry = await runStripeEvent(invoiceEvent(id, `in_${STAMP}_crash`), crashing);
    expect(retry).toMatchObject({ kind: "processed", status: "processed" });
    expect(await paymentsFor(id)).toBe(1);
    expect(await rowOf(id)).toMatchObject({ status: "processed", attempts: 2, lastError: null });
    // And a further retry changes nothing.
    expect((await runStripeEvent(invoiceEvent(id, `in_${STAMP}_crash`), crashing)).kind).toBe("already_processed");
    expect(await paymentsFor(id)).toBe(1);
  });

  it("a unique violation SWALLOWED inside the processor still aborts the transaction: recorded failed, never processed", async () => {
    // The webhook's class-pack and shop branches catch P2002 inside the
    // transaction and carry on. Postgres aborts the transaction at the error,
    // so the terminal status cannot commit: the store records the event as
    // failed (visible, replayable) instead of claiming it was processed.
    const id = evtId("swallow");
    const invoice = `in_${STAMP}_swallow`;
    await withRlsBypass((tx) =>
      tx.payment.create({ data: { tenantId: TENANT, memberId: MEMBER, stripeInvoiceId: invoice, amountPence: 4500, currency: "GBP", status: "succeeded" } }),
    );
    const swallowing: StripeEventProcessor<FreshStripeEvent> = async (_e, { tx }) => {
      try {
        await tx.payment.create({ data: { tenantId: TENANT, memberId: MEMBER, stripeInvoiceId: invoice, amountPence: 4500, currency: "GBP", status: "succeeded" } });
      } catch (e) {
        if ((e as { code?: string }).code !== "P2002") throw e;
      }
      return { outcome: "processed", tenantId: TENANT };
    };
    const r = await runStripeEvent(invoiceEvent(id, invoice), swallowing);
    expect(r.kind).toBe("failed");
    const row = await rowOf(id);
    expect(row?.status).toBe("failed");
    expect(row?.lastError ?? "").not.toBe("");
    expect(await paymentsForInvoice(invoice)).toBe(1);
  });

  it("a retryable refusal (club not linked yet) is recorded failed and reported retryable", async () => {
    const id = evtId("retry");
    const notYet: StripeEventProcessor<FreshStripeEvent> = async () => {
      throw new StripeEventRetryableError("Connected account not linked to a tenant yet");
    };
    const r = await runStripeEvent(invoiceEvent(id, `in_${STAMP}_retry`), notYet);
    expect(r).toEqual({ kind: "failed", retryable: true, error: "Connected account not linked to a tenant yet" });
    expect(await rowOf(id)).toMatchObject({ status: "failed", lastError: "Connected account not linked to a tenant yet" });
  });

  it("(d) replay of a failed event after the cause is removed: fetched fresh, processed once, replayed, audited", async () => {
    const id = evtId("replay");
    const invoice = `in_${STAMP}_replay`;
    let broken = true;
    const proc: StripeEventProcessor<FreshStripeEvent> = async (event, ctx) => {
      if (broken) throw new Error("price lookup failed");
      return upsertProcessor(event, ctx);
    };
    expect((await runStripeEvent(invoiceEvent(id, invoice), proc)).kind).toBe("failed");
    expect(await paymentsForInvoice(invoice)).toBe(0);
    broken = false;
    const retrieve = vi.fn(async () => invoiceEvent(id, invoice));
    const out = await replayStripeEvent(
      { eventId: id, operatorId: `${STAMP}-operator`, reason: "price table fixed; replaying the failed invoice" },
      { stripe: { events: { retrieve } }, processor: proc, keyMode: "test" },
    );
    expect(out).toMatchObject({ ok: true, tenantId: TENANT, forced: false, previousStatus: "failed", result: { kind: "processed", status: "replayed" } });
    expect(retrieve).toHaveBeenCalledWith(id, {}, { stripeAccount: ACCT });
    expect(await paymentsForInvoice(invoice)).toBe(1);
    expect(await rowOf(id)).toMatchObject({ status: "replayed", lastError: null });
    const audit = await withRlsBypass((tx) =>
      tx.auditLog.findMany({ where: { tenantId: TENANT, action: REPLAY_AUDIT_ACTION, entityId: id }, select: { metadata: true } }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ eventId: id, previousStatus: "failed", forced: false, result: "processed", actingAs: `${STAMP}-operator` });
    // Replaying again without force: refused, nothing runs.
    const again = await replayStripeEvent(
      { eventId: id, operatorId: `${STAMP}-operator`, reason: "second attempt by mistake" },
      { stripe: { events: { retrieve } }, processor: proc, keyMode: "test" },
    );
    expect(again).toMatchObject({ ok: false, refusal: "already_processed" });
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(await paymentsForInvoice(invoice)).toBe(1);
  });

  it("(e) forced replay of a processed invoice.payment_succeeded: no second Payment, audit or email", async () => {
    const id = evtId("forced");
    const invoice = `in_${STAMP}_forced`;
    h.emails.length = 0;
    expect((await runStripeEvent(invoiceEvent(id, invoice), upsertProcessor)).kind).toBe("processed");
    expect(await paymentsForInvoice(invoice)).toBe(1);
    expect(await auditsFor(id)).toBe(1);
    expect(h.emails).toHaveLength(1);
    const retrieve = vi.fn(async () => invoiceEvent(id, invoice));
    const deps = { stripe: { events: { retrieve } }, processor: upsertProcessor, keyMode: "test" as const };
    const refused = await replayStripeEvent({ eventId: id, operatorId: `${STAMP}-operator`, reason: "checking the ledger" }, deps);
    expect(refused).toMatchObject({ ok: false, refusal: "already_processed" });
    const forced = await replayStripeEvent({ eventId: id, operatorId: `${STAMP}-operator`, reason: "forced convergence check", force: true }, deps);
    expect(forced).toMatchObject({ ok: true, forced: true, previousStatus: "processed", result: { kind: "processed", status: "replayed", auditsWritten: 0, emailsSent: 0 } });
    expect(await paymentsForInvoice(invoice)).toBe(1);
    expect(await auditsFor(id)).toBe(1);
    expect(h.emails).toHaveLength(1);
    const replayAudits = await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: TENANT, action: REPLAY_AUDIT_ACTION, entityId: id } }));
    expect(replayAudits).toBe(1);
  });

  it("replay refuses before calling Stripe: unknown id, short reason, wrong mode, mismatched event, withdrawn club, no processor", async () => {
    const id = evtId("refuse");
    const invoice = `in_${STAMP}_refuse`;
    await runStripeEvent(invoiceEvent(id, invoice), async () => { throw new Error("boom"); });
    const retrieve = vi.fn(async () => invoiceEvent(id, invoice));
    const base = { eventId: id, operatorId: `${STAMP}-operator`, reason: "valid reason here" };
    const deps = { stripe: { events: { retrieve } }, processor: upsertProcessor, keyMode: "test" as const };
    expect(await replayStripeEvent({ ...base, eventId: `${id}_nope` }, deps)).toMatchObject({ refusal: "not_found" });
    expect(await replayStripeEvent({ ...base, reason: "x" }, deps)).toMatchObject({ refusal: "reason_required" });
    expect(await replayStripeEvent(base, { ...deps, processor: null })).toMatchObject({ refusal: "not_wired" });
    expect(retrieve).not.toHaveBeenCalled();
    expect(await replayStripeEvent(base, { ...deps, keyMode: "live" })).toMatchObject({ refusal: "livemode_mismatch" });
    const other = vi.fn(async () => ({ ...invoiceEvent(id, invoice), id: `${id}_x` }));
    expect(await replayStripeEvent(base, { ...deps, stripe: { events: { retrieve: other } } })).toMatchObject({ refusal: "mismatch" });
    const foreign = vi.fn(async () => ({ ...invoiceEvent(id, invoice), account: "acct_someoneelse" }));
    expect(await replayStripeEvent(base, { ...deps, stripe: { events: { retrieve: foreign } } })).toMatchObject({ refusal: "mismatch" });
    const down = vi.fn(async () => { throw new Error("connect ECONNRESET"); });
    expect(await replayStripeEvent(base, { ...deps, stripe: { events: { retrieve: down } } })).toMatchObject({ refusal: "stripe_unavailable" });
    await withRlsBypass((tx) => tx.tenant.update({ where: { id: TENANT }, data: { stripeConnected: false } }));
    try {
      const calls = retrieve.mock.calls.length;
      expect(await replayStripeEvent(base, deps)).toMatchObject({ refusal: "club_disconnected" });
      expect(retrieve.mock.calls.length).toBe(calls);
    } finally {
      await withRlsBypass((tx) => tx.tenant.update({ where: { id: TENANT }, data: { stripeConnected: true } }));
    }
    expect(await paymentsForInvoice(invoice)).toBe(0);
    expect(await rowOf(id)).toMatchObject({ status: "failed" });
    expect(await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: TENANT, action: REPLAY_AUDIT_ACTION, entityId: id } }))).toBe(0);
  });

  it("RLS: a club context sees its own store rows only; unattributed rows only under the bypass", async () => {
    const mine = evtId("rls");
    const loose = evtId("loose");
    await recordReceived(invoiceEvent(mine, `in_${STAMP}_rls`));
    await recordReceived({ ...invoiceEvent(loose, `in_${STAMP}_loose`), account: "acct_unlinked_paypd" });
    expect((await rowOf(loose))?.tenantId).toBeNull();
    const ownView = await withTenantContext(TENANT, (tx) => tx.stripeEvent.count({ where: { eventId: { in: [mine, loose] } } }));
    const otherView = await withTenantContext(OTHER, (tx) => tx.stripeEvent.count({ where: { eventId: { in: [mine, loose] } } }));
    if (RLS) {
      expect(ownView).toBe(1);
      expect(otherView).toBe(0);
    } else {
      // Owner role: RLS not in force (recorded, not asserted as isolation).
      expect(ownView).toBe(2);
    }
  });

  it("an operator cannot read reconcile runs outside the bypass under the restricted role", async () => {
    const run = await withRlsBypass((tx) => tx.stripeReconcileRun.create({ data: { windowStart: new Date(), status: "ok", trigger: "manual" } }));
    try {
      const seen = await withTenantContext(TENANT, (tx) => tx.stripeReconcileRun.count({ where: { id: run.id } }));
      expect(seen).toBe(RLS ? 0 : 1);
    } finally {
      await withRlsBypass((tx) => tx.stripeReconcileRun.delete({ where: { id: run.id } }));
    }
  });
});
