import { withTenantContext, withRlsBypass } from "@/lib/prisma-tenant";
import { getClientIp } from "@/lib/rate-limit";

type LogArgs = {
  /**
   * Audit iter-1-operator-admin A6I1-V-4: nullable to support platform-level
   * events that don't belong to a tenant yet (e.g. rejecting a gym
   * application before tenant creation). When null, the row is written via
   * `withRlsBypass` and is invisible to tenant-scoped queries — only
   * operator-admin surfaces (which also use `withRlsBypass`) can read it.
   */
  tenantId: string | null;
  userId?: string | null;
  /**
   * Super-admin impersonation context. When set, the audit row records that
   * `userId` was the *apparent* actor while `actAsUserId` was the *real*
   * actor (the admin acting as the target). Both are persisted so the gym
   * owner can see "Member updated by admin (acting as Owner)" in their log.
   */
  actAsUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown> | null;
  req?: Request;
};

export async function logAudit(args: LogArgs): Promise<void> {
  // Bake actAsUserId into metadata.actingAs so the existing schema stays
  // unchanged. Existing readers that care about admin attribution can
  // inspect metadata.actingAs without a migration.
  const metadata = args.actAsUserId
    ? { ...(args.metadata ?? {}), actingAs: args.actAsUserId }
    : args.metadata ?? null;

  const data = {
    tenantId: args.tenantId,
    userId: args.userId ?? null,
    action: args.action,
    entityType: args.entityType,
    entityId: args.entityId,
    metadata: metadata ? (metadata as object) : undefined,
    ipAddress: args.req ? getClientIp(args.req) : null,
    userAgent: args.req?.headers.get("user-agent")?.slice(0, 500) ?? null,
  };

  // Fire-and-forget: the function returns immediately so the API route can
  // respond to the user without waiting for the audit write (~100-200ms on
  // Neon). Errors are swallowed — audit loss is preferable to user-facing
  // failure on a best-effort log.
  const op =
    args.tenantId === null
      ? withRlsBypass((tx) => tx.auditLog.create({ data }))
      : withTenantContext(args.tenantId, (tx) => tx.auditLog.create({ data }));

  void op.catch(() => {
    // Swallow.
  });
}
