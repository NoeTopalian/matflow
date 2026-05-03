import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

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
export async function withTenantContext<T>(
  tenantId: string,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  if (!tenantId || typeof tenantId !== "string") {
    throw new Error("withTenantContext requires a non-empty tenantId");
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
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
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return fn(tx);
  });
}
