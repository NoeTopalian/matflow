import { withTenantContext, withRlsBypass } from "@/lib/prisma-tenant";
import { getClientIp } from "@/lib/rate-limit";
import { readImpersonationCookie } from "@/lib/impersonation";

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

/**
 * The real actor behind this write, when it is not the apparent one.
 *
 * Round 1, defect 1. `actAsUserId` was the ONLY source of attribution, and only
 * the `app/api/admin/**` call sites pass it — 14 of the 120 `logAudit` sites in
 * this tree. So a member edited, a payment refunded or a class cancelled during
 * an impersonated session was written into the gym's own log as the owner's own
 * work, with nothing to distinguish it.
 *
 * The claim is read from the same signed cookie the `auth.ts` jwt() callback
 * reads (`lib/impersonation.ts`), so the two cannot drift: if the cookie is
 * good enough to swap the session identity, it is good enough to name the real
 * actor. `auth.ts` is deliberately not imported — it belongs to another lane
 * this round, and importing it here would also pull the whole NextAuth graph
 * into every route that logs.
 *
 * Failure is never allowed to matter. `cookies()` throws outside a request
 * scope (crons, scripts, background jobs), and a lost attribution must degrade
 * to an unattributed row, never to a lost audit row and never to a failed
 * user-facing action.
 */
async function resolveActingAs(explicit: string | null | undefined): Promise<string | null> {
  // An explicit argument always wins: the nine operator mutations already
  // resolve a real Operator.id (or the sentinel) and that is more precise than
  // anything the cookie carries.
  if (explicit) return explicit;
  try {
    const claim = await readImpersonationCookie();
    return claim?.adminUserId ?? null;
  } catch {
    return null;
  }
}

export async function logAudit(args: LogArgs): Promise<void> {
  // Bake the attribution into metadata.actingAs so the existing schema stays
  // unchanged. Existing readers that care about admin attribution can
  // inspect metadata.actingAs without a migration.
  const actingAs = await resolveActingAs(args.actAsUserId);

  // Round 1, defect 2. The `x-admin-secret` header is a second entrance to the
  // operator plane with no individual identity behind it (lib/admin-auth.ts).
  // It stays open — scripts rely on it — but a row written through it must say
  // so, because `actingAs` alone reads as though a person were behind it when
  // the credential is a shared constant. Presence of the header is the signal:
  // a row is only written once the route has already authorised the request.
  const viaSharedSecretHeader = args.req?.headers.get("x-admin-secret") ? true : false;

  const extra: Record<string, unknown> = {};
  if (actingAs) extra.actingAs = actingAs;
  if (viaSharedSecretHeader) extra.via = "shared-secret-header";

  const metadata =
    Object.keys(extra).length > 0 ? { ...(args.metadata ?? {}), ...extra } : args.metadata ?? null;

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
