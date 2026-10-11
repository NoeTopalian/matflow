import { createHmac } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { attachErrorContext } from "./error-context";

type TxClient = Prisma.TransactionClient;

/**
 * Run database operations inside a tenant-scoped transaction.
 *
 * Sets the Postgres GUC `app.current_tenant_id` so the RLS policies created
 * in `20260503100000_rls_policies_foundation` enforce tenant isolation as a
 * backstop to the application-layer `where: { tenantId }` filters.
 *
 * Use after `requireSession()` / `requireStaff()`:
 *
 *   const ctx = await requireStaff();
 *   const result = await withTenantContext(ctx.tenantId, (tx) =>
 *     tx.member.findMany({ where: { tenantId: ctx.tenantId } }),
 *   );
 *
 * The `set_config(..., true)` form is transaction-local, which is required
 * because production runs Postgres behind pgbouncer in transaction-mode pooling
 * (DATABASE_URL?pgbouncer=true&connection_limit=1) — session-scoped settings
 * would not survive across queries.
 */
// Transaction budgets. Prisma's defaults (maxWait 2s, timeout 5s) P2028 under
// pool contention: fan-out pages (member home, dashboard) open several
// interactive transactions at once, and behind pgbouncer with
// connection_limit=1 they queue — 2s of queueing is routinely exceeded, which
// surfaced as "Unable to start a transaction in the given time" (P2028) and
// "commit cannot be executed on an expired transaction" on /dashboard/reports.
// Heavy read paths (reports) pass a larger explicit budget.
export type TenantTxOptions = { maxWait?: number; timeout?: number };

/**
 * Signed tenant context (SF-62 proposed design P2). The key is 64 random bytes as 128 hex characters; the database
 * holds the same key as precomputed HMAC pads in a table only the system role can read. Unset = feature off.
 */
export const TENANT_CONTEXT_KEY_ENV = "RLS_CONTEXT_SIGNING_KEY";

export function tenantContextKey(raw: string | undefined = process.env[TENANT_CONTEXT_KEY_ENV]): Buffer | null {
  if (!raw) return null;
  if (!/^[0-9a-fA-F]{128}$/.test(raw)) {
    throw new Error(`${TENANT_CONTEXT_KEY_ENV} must be exactly 64 bytes of hex`);
  }
  return Buffer.from(raw, "hex");
}

/** HMAC-SHA256 over `tenant|backendPid|transactionStartMicros`, hex — the message ctx_tenant() recomputes in SQL. */
export function tenantContextMac(key: Buffer, tenantId: string, backendPid: string, xactStartMicros: string): string {
  return createHmac("sha256", key).update(`${tenantId}|${backendPid}|${xactStartMicros}`, "utf8").digest("hex");
}
const TX_DEFAULTS: Required<TenantTxOptions> = { maxWait: 10_000, timeout: 15_000 };

/**
 * THE BOUND ON A TENANT TRANSACTION IS OWNED HERE, NOT BY PRISMA'S TIMERS (SF-135 cycle 2 + SF-136, lane L1,
 * 11 Oct 2026). Same construction as lib/rate-limit.ts (checkDbRateLimit) and lib/auth-lockout.ts (reserveTx).
 *
 * Prisma 7.4.2 enforces `timeout` with a timer whose callback sends ROLLBACK on the transaction's own connection and
 * is never awaited: when it fires under a statement still in flight it can only queue behind it, and if the
 * connection then fails its rejection has no handler (an Unhandled Rejection — plain Node exits; Next.js logs it).
 * The sign-in flow's tenant transactions produced exactly that under a burst (docs/security/evidence/L1). And when
 * `maxWait` expires before the driver has finished starting the transaction, Prisma later "rolls back" the late start
 * through adapter-pg, which only releases the client — the client goes back to the pool inside its BEGIN and the next
 * autocommit write on it is held in a transaction nobody owns (lost on close; SF-136,
 * tests/integration/sec-l1-start-timeout-db).
 *
 * So both Prisma limits are set out of reach, and the transaction is bounded where it is opened:
 *  - the FIRST statement (the one that already sets the tenant context) also sets lock_timeout and
 *    statement_timeout with set_config(…, true) — transaction-local, reset by COMMIT/ROLLBACK, never left on the
 *    pooled connection: TENANT_STATEMENT_BOUND_MS for the default budget, TENANT_STATEMENT_BOUND_EXTENDED_MS when a
 *    caller asked for more than that (imports, reports, purges). A statement or lock wait past it fails as Postgres
 *    57014 / 55P03 (lib/tenant-lifecycle.ts isTenantRowBusyError already reads 55P03 as "busy, try again");
 *  - the caller's `timeout` stays the budget of the whole callback: a callback that finishes past it is rolled back,
 *    never committed, and the caller gets TenantTransactionBudgetError (code P2028 — the code Prisma used for the
 *    same condition, so existing handling keeps working);
 *  - waiting to START is bounded by the pool's own deadline (connectionTimeoutMillis, lib/prisma.ts, 10 s): Prisma
 *    never abandons a start, so no client returns to the pool inside a BEGIN. `maxWait` is accepted for
 *    compatibility; the pool deadline is what applies.
 * What Prisma's timer used to do and this does not: when a callback sat IDLE past its budget (awaiting something
 * other than the database), Prisma's ROLLBACK went out at once and freed the connection. Now the connection is held
 * until the callback returns (and is then rolled back), or until the server's idle_in_transaction_session_timeout.
 */
const PRISMA_TIMER_OUT_OF_REACH_MS = 60 * 60 * 1000;
const PRISMA_TX_OPTIONS = { maxWait: PRISMA_TIMER_OUT_OF_REACH_MS, timeout: PRISMA_TIMER_OUT_OF_REACH_MS } as const;
/** Per-statement and lock-wait bound for the default budget. Literal in the SQL below (pinned by sec-l1-store-tx-bound). */
export const TENANT_STATEMENT_BOUND_MS = 15_000;
/** The same bound for callers whose budget is larger than the default (imports, reports, purges). */
export const TENANT_STATEMENT_BOUND_EXTENDED_MS = 60_000;

/** A tenant transaction whose callback ran past its budget: rolled back, nothing committed. */
export class TenantTransactionBudgetError extends Error {
  readonly code = "P2028";
  constructor(
    readonly budgetMs: number,
    readonly elapsedMs: number,
  ) {
    super(`transaction budget exceeded (${elapsedMs} ms > ${budgetMs} ms); rolled back`);
    this.name = "TenantTransactionBudgetError";
  }
}

/** Runs the callback and refuses to commit it if it overran its budget (Prisma rolls back on the throw). */
async function withinBudget<T>(budgetMs: number, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const out = await run();
  const elapsedMs = Date.now() - started;
  if (elapsedMs > budgetMs) throw new TenantTransactionBudgetError(budgetMs, elapsedMs);
  return out;
}

function budgetOf(options?: TenantTxOptions): number {
  return options?.timeout ?? TX_DEFAULTS.timeout;
}

export async function withTenantContext<T>(
  tenantId: string,
  fn: (tx: TxClient) => Promise<T>,
  options?: TenantTxOptions,
): Promise<T> {
  if (!tenantId || typeof tenantId !== "string") {
    throw new Error("withTenantContext requires a non-empty tenantId");
  }
  // Read before the transaction opens so a malformed key fails closed without holding a pool connection.
  const key = tenantContextKey();
  const budget = budgetOf(options);
  try {
    return await prisma.$transaction(async (tx) => {
      // SF-62 (security campaign iteration 2, lane B): `app.bypass_rls` is switched OFF for this transaction in the
      // same statement. A session-level `app.bypass_rls = 'on'` left on a pooled server connection (a script or a
      // compromised path calling set_config(..., false); the Neon pooler hands that connection to other clients)
      // otherwise turned every tenant-scoped transaction on it into an all-clubs one under the deployed policies.
      // Measured by tests/integration/sec-b2-stale-bypass-db.test.ts.
      // SF-135: the same statement bounds every later statement and lock wait of this transaction (see above).
      if (budget <= TENANT_STATEMENT_BOUND_MS) {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true), set_config('app.bypass_rls', 'off', true), set_config('lock_timeout', '15000ms', true), set_config('statement_timeout', '15000ms', true)`;
      } else {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true), set_config('app.bypass_rls', 'off', true), set_config('lock_timeout', '60000ms', true), set_config('statement_timeout', '60000ms', true)`;
      }
      if (key) {
        // Proposed design P2 (docs/security/evidence/B2): the policies accept the tenant only with a MAC bound to
        // this transaction (backend pid + transaction start), so a forged or replayed tenant setting grants nothing.
        // Inert under the deployed policies; enabled by RLS_CONTEXT_SIGNING_KEY once the migration is applied.
        const [t] = await tx.$queryRaw<Array<{ pid: string; ts: string }>>`
          SELECT pg_backend_pid()::text AS pid, floor(extract(epoch FROM transaction_timestamp()) * 1000000)::bigint::text AS ts`;
        await tx.$executeRaw`SELECT set_config('app.ctx_mac', ${tenantContextMac(key, tenantId, t.pid, t.ts)}, true)`;
      }
      return withinBudget(budget, () => fn(tx));
    }, PRISMA_TX_OPTIONS);
  } catch (e) {
    // Stamp the tenant onto the error on its way out so the shared error path
    // (lib/api-error.ts) can attribute the failure in the log without every
    // route handler threading context by hand. Non-enumerable, so it cannot
    // leak into any serialised response. The error is otherwise untouched and
    // rethrown as-is.
    throw attachErrorContext(e, { tenantId });
  }
}

/**
 * Escape hatch for legitimate cross-tenant operations: Stripe / Resend webhooks,
 * cron jobs, the auth flow resolving a tenant by slug, public form submission
 * processing. Every call site should be auditable as a deliberate decision.
 *
 * Do NOT use in routine API handlers — those should resolve the tenant from
 * the session and use `withTenantContext`.
 *
 * SF-62: this is NOT a database boundary. `app.bypass_rls` is an ordinary custom setting, so any session holding the
 * runtime credential (a leaked DATABASE_URL, an injected statement, a compromised dependency) can set it and read or
 * change every club. The replacement — role-keyed system access, narrow SECURITY DEFINER lookups and a signed tenant
 * context — is specified and measured in docs/security/evidence/B2/; the call sites are classified there.
 */
export async function withRlsBypass<T>(
  fn: (tx: TxClient) => Promise<T>,
  options?: TenantTxOptions,
): Promise<T> {
  const budget = budgetOf(options);
  return prisma.$transaction(async (tx) => {
    // SF-135: bounded like withTenantContext, in the same first statement.
    if (budget <= TENANT_STATEMENT_BOUND_MS) {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true), set_config('lock_timeout', '15000ms', true), set_config('statement_timeout', '15000ms', true)`;
    } else {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true), set_config('lock_timeout', '60000ms', true), set_config('statement_timeout', '60000ms', true)`;
    }
    return withinBudget(budget, () => fn(tx));
  }, PRISMA_TX_OPTIONS);
}
