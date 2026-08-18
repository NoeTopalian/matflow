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
const TX_DEFAULTS: Required<TenantTxOptions> = { maxWait: 10_000, timeout: 15_000 };

export async function withTenantContext<T>(
  tenantId: string,
  fn: (tx: TxClient) => Promise<T>,
  options?: TenantTxOptions,
): Promise<T> {
  if (!tenantId || typeof tenantId !== "string") {
    throw new Error("withTenantContext requires a non-empty tenantId");
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      return fn(tx);
    }, { ...TX_DEFAULTS, ...options });
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
 */
export async function withRlsBypass<T>(
  fn: (tx: TxClient) => Promise<T>,
  options?: TenantTxOptions,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return fn(tx);
  }, { ...TX_DEFAULTS, ...options });
}
