import { withTenantContext } from "@/lib/prisma-tenant";
import { getClientIp } from "@/lib/rate-limit";

type LogArgs = {
  tenantId: string;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown> | null;
  req?: Request;
};

export async function logAudit(args: LogArgs): Promise<void> {
  try {
    await withTenantContext(args.tenantId, (tx) =>
      tx.auditLog.create({
        data: {
          tenantId: args.tenantId,
          userId: args.userId ?? null,
          action: args.action,
          entityType: args.entityType,
          entityId: args.entityId,
          metadata: args.metadata ? (args.metadata as object) : undefined,
          ipAddress: args.req ? getClientIp(args.req) : null,
          userAgent: args.req?.headers.get("user-agent")?.slice(0, 500) ?? null,
        },
      }),
    );
  } catch {
    // Best-effort — never break the user-facing operation on audit failure.
  }
}
