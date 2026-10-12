import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withTenantContext, withRlsBypass } from "@/lib/prisma-tenant";
import { getClientIp } from "@/lib/rate-limit";
import { readImpersonationCookie } from "@/lib/impersonation";

/**
 * The shared-secret operator sentinel (lib/operator-context.ts
 * SENTINEL_OPERATOR_ID). Repeated rather than imported: operator-context pulls
 * the operator-auth graph into every route that logs.
 */
const SHARED_SECRET_ACTOR = "__matflow_super_admin__";

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
  /**
   * Durable mode, inside the CALLER'S transaction (operator audit 5 Oct 2026,
   * Q9). The row is written with this client, awaited, and any failure is
   * thrown — so the row commits or rolls back together with the change it
   * records. Use it for every high-impact change that is one DB transaction.
   */
  tx?: Prisma.TransactionClient;
  /**
   * Durable mode, in the row's OWN transaction: awaited, and any failure is
   * thrown. For a change that is not one DB transaction (a Stripe call, a
   * cookie, a file handed to the browser): write this first and refuse the
   * action if it throws. Ignored when `tx` is given.
   */
  durable?: boolean;
  /** What happened, for durable rows: "requested", "succeeded", "authorised", … */
  outcome?: string;
  /**
   * The Operator.id behind the row (column AuditLog.operatorId, 9 Oct 2026).
   * Defaults to the real actor (`actAsUserId` — passed only by operator
   * routes — or the support-session cookie's operator); the shared-secret
   * sentinel is never written. Checked against the Operator table before the
   * insert: an id with no Operator row is written as null (metadata.actingAs
   * keeps it) rather than aborting the caller's transaction.
   */
  operatorId?: string | null;
  /**
   * Correlation id (column AuditLog.requestId). Step-up routes pass the spent
   * grant's request id (lib/operator-step-up.ts) — the idempotent-replay key.
   * Otherwise durable rows get the platform request id or a UUID.
   */
  requestId?: string | null;
};

/**
 * Keys that must never reach an audit row whatever a caller passes: temporary
 * passwords, TOTP secrets, recovery codes, step-up grants, session tokens.
 * Top-level only — callers build metadata as flat objects. Nothing in the tree
 * passes these today; this is the backstop that keeps it so.
 */
const FORBIDDEN_METADATA_KEYS = new Set([
  "password",
  "tempPassword",
  "temporaryPassword",
  "passwordHash",
  "secret",
  "totpSecret",
  "recoveryCodes",
  "totpRecoveryCodes",
  "token",
  "stepUpToken",
  "grant",
  "cookie",
]);

function scrub(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (!FORBIDDEN_METADATA_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/** Correlates the audit row with the platform's request log. */
function requestIdOf(req: Request | undefined): string {
  const fromPlatform = req?.headers.get("x-vercel-id")?.trim();
  return fromPlatform ? fromPlatform.slice(0, 200) : randomUUID();
}

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

type Row = {
  tenantId: string | null;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: object | undefined;
  ipAddress: string | null;
  userAgent: string | null;
  operatorId: string | null;
  requestId: string | null;
};

async function buildRow(args: LogArgs, durable: boolean): Promise<Row> {
  // Bake the attribution into metadata.actingAs so the existing schema stays
  // unchanged. Existing readers that care about admin attribution can
  // inspect metadata.actingAs without a migration.
  const actingAs = await resolveActingAs(args.actAsUserId);

  // Round 1, defect 2 (header) and operator audit Q1 (cookie). The shared
  // secret has no individual identity behind it. Since 6 Oct 2026 it grants
  // nothing in production (lib/admin-auth.ts), but where it still works
  // (development, test) a row written through it must say so, because
  // `actingAs` alone reads as though a person were behind it.
  const viaSharedSecretHeader = args.req?.headers.get("x-admin-secret") ? true : false;
  const via = viaSharedSecretHeader
    ? "shared-secret-header"
    : actingAs === SHARED_SECRET_ACTOR
      ? "shared-secret"
      : null;

  const requestId = args.requestId ? args.requestId.slice(0, 200) : durable ? requestIdOf(args.req) : null;
  const operatorCandidate = args.operatorId ?? actingAs;
  const operatorId = operatorCandidate && operatorCandidate !== SHARED_SECRET_ACTOR ? operatorCandidate : null;

  const extra: Record<string, unknown> = {};
  if (actingAs) extra.actingAs = actingAs;
  if (via) extra.via = via;
  if (durable) {
    // Who did it, as whom, to what, and how it ended — on every high-impact
    // row (operator audit Q9 field list). The tenant and target are the row's
    // own tenantId / entityType / entityId columns.
    extra.actor = actingAs ?? args.userId ?? null;
    extra.actorType = actingAs
      ? actingAs === SHARED_SECRET_ACTOR
        ? "shared-secret"
        : "operator"
      : args.userId
        ? "user"
        : "system";
    if (actingAs && args.userId) extra.effectiveUserId = args.userId;
    extra.requestId = requestId;
    extra.outcome = args.outcome ?? "succeeded";
  }

  const base = args.metadata ? scrub(args.metadata) : null;
  const metadata = Object.keys(extra).length > 0 ? { ...(base ?? {}), ...extra } : base;

  return {
    tenantId: args.tenantId,
    userId: args.userId ?? null,
    action: args.action,
    entityType: args.entityType,
    entityId: args.entityId,
    metadata: metadata ? (metadata as object) : undefined,
    ipAddress: args.req ? getClientIp(args.req) : null,
    userAgent: args.req?.headers.get("user-agent")?.slice(0, 500) ?? null,
    operatorId,
    requestId,
  };
}

// `userId` references a staff User. Member-side routes pass the member's own
// id there. Decide before the insert whether it is a staff User of this
// tenant; if not, write no userId and put the actor in metadata.actorId.
// Inserting first and retrying on the foreign-key error saved the row but
// logged one `prisma:error` per member action (functional review round 3,
// F10). Inside a caller's transaction the check is the ONLY protection — a
// failed insert aborts the whole transaction — so it runs in every mode.
const asActor = (d: Row, actorId: string): Row => ({
  ...d,
  userId: null,
  metadata: { ...((d.metadata as Record<string, unknown> | undefined) ?? {}), actorId },
});

async function insert(tx: Prisma.TransactionClient, d: Row) {
  let row = d;
  if (d.userId) {
    const staff = await tx.user.findFirst({
      where: d.tenantId === null ? { id: d.userId } : { id: d.userId, tenantId: d.tenantId },
      select: { id: true },
    });
    if (!staff) row = asActor(d, d.userId);
  }
  // Same reasoning for the operator column (9 Oct 2026): a foreign-key failure
  // inside a caller's transaction would abort the change it records, so an id
  // that is not (or no longer) an Operator row is written as null. The id is
  // still in metadata.actingAs, so the attribution is not lost.
  if (row.operatorId) {
    const op = await tx.operator.findUnique({ where: { id: row.operatorId }, select: { id: true } });
    if (!op) row = { ...row, operatorId: null };
  }
  return tx.auditLog.create({ data: row as Prisma.AuditLogUncheckedCreateInput });
}

const writeOwnTx = (d: Row) =>
  d.tenantId === null
    ? withRlsBypass((tx) => insert(tx, d))
    : withTenantContext(d.tenantId, (tx) => insert(tx, d));

/**
 * Write an audit row.
 *
 *  - `tx` given: inside the caller's transaction, awaited, throws on failure.
 *  - `durable: true`: its own transaction, awaited, throws on failure.
 *  - neither: best-effort (below) — for the many low-impact call sites.
 */
export async function logAudit(args: LogArgs): Promise<void> {
  const durable = !!args.tx || args.durable === true;
  const data = await buildRow(args, durable);

  if (args.tx) {
    await insert(args.tx, data);
    return;
  }
  if (args.durable) {
    await writeOwnTx(data);
    return;
  }

  // Best-effort: the function returns immediately so the API route can
  // respond to the user without waiting for the audit write (~100-200ms on
  // Neon). Errors are swallowed — audit loss is preferable to user-facing
  // failure on a best-effort log. NOT for high-impact changes: those pass
  // `tx` or `durable` (operator audit 5 Oct 2026, Q9).
  void writeOwnTx(data)
    .catch((e: unknown) => {
      // Backstop only: the staff check above should already have routed a
      // non-staff actor to metadata.actorId. If the foreign key still fails
      // (e.g. the user was deleted between the check and the insert), keep the
      // row rather than lose it.
      if ((e as { code?: string }).code === "P2003" && (data.userId || data.operatorId)) {
        const retry = data.userId ? asActor(data, data.userId) : data;
        return writeOwnTx({ ...retry, operatorId: null });
      }
      throw e;
    })
    .catch((e: unknown) => {
      // Still best-effort — never a user-facing failure — but no longer silent.
      console.warn("[audit-log] write failed", args.action, e);
    });
}

/** `logAudit` inside the caller's transaction: awaited, throws on failure. */
export function logAuditStrict(tx: Prisma.TransactionClient, args: Omit<LogArgs, "tx" | "durable">): Promise<void> {
  return logAudit({ ...args, tx });
}

// ─── Retention ───────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ordinary audit rows: the published 12 months (app/legal/privacy/page.tsx §6). */
export const AUDIT_LOG_RETENTION_MS = 365 * DAY_MS;
/**
 * Platform evidence: six years, the UK limitation period for a claim. Operator
 * actions, support sessions, erasure records and club hard-deletes are what an
 * incident review or a restore (docs/runbooks/db-restore.md) needs long after
 * the year is up (operator audit 5 Oct 2026, Q9).
 */
export const AUDIT_EVIDENCE_RETENTION_MS = 6 * 365 * DAY_MS;

/**
 * Action prefixes kept for AUDIT_EVIDENCE_RETENTION_MS. `admin.` covers every
 * operator action (Danger Zone, impersonation start/end, operator sign-in,
 * TOTP enrolment, step-up, hard-delete evidence); `member.dsar_erase` covers
 * the erasure record and its request row.
 */
export const AUDIT_EVIDENCE_ACTION_PREFIXES = ["admin.", "member.dsar_erase"] as const;

/**
 * The retention cron's delete predicate for AuditLog. Rows written during a
 * support session (metadata.actingAs set) are evidence too, whatever their
 * action. `action` is NOT NULL, so the NOT below cannot be defeated by a NULL;
 * the actingAs test is phrased positively (key absent) for the same reason.
 */
export function auditLogRetentionWhere(now: Date): Prisma.AuditLogWhereInput {
  const ordinaryCutoff = new Date(now.getTime() - AUDIT_LOG_RETENTION_MS);
  const evidenceCutoff = new Date(now.getTime() - AUDIT_EVIDENCE_RETENTION_MS);
  return {
    OR: [
      {
        createdAt: { lt: ordinaryCutoff },
        NOT: { OR: AUDIT_EVIDENCE_ACTION_PREFIXES.map((p) => ({ action: { startsWith: p } })) },
        OR: [{ metadata: { equals: Prisma.DbNull } }, { metadata: { path: ["actingAs"], equals: Prisma.AnyNull } }],
      },
      { createdAt: { lt: evidenceCutoff } },
    ],
  };
}
