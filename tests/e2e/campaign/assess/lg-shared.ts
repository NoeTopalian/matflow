/**
 * Lane L-G — shared machinery for the operator-plane and machine spec files.
 *
 * NOT a `.spec.ts`: Playwright must not collect it.
 *
 * Everything that already exists is imported from `lb-shared.ts` / `la-shared.ts`
 * rather than copied. What is here is what only this lane needs: the two
 * machine credentials, and the three ways to present an operator identity.
 *
 * SECRETS. `MATFLOW_ADMIN_SECRET` and `CRON_SECRET` are read from
 * `process.env` (loaded from `.env.test` by playwright.config.ts) and never
 * printed, never written to `tests/e2e/.auth/`, never captured by
 * `storageState()`. The `matflow_admin` cookie VALUE IS the secret
 * (lib/admin-auth.ts:8-10), so a storage-state dump of an operator context
 * would put the platform's master credential in the repo. Every helper below
 * that carries the secret returns a live context and nothing serialisable.
 */
import { expect, type Browser, type BrowserContext } from "@playwright/test";
import { sql, RUN_STAMP } from "../helpers/db";

export const OPERATOR_SECRET = process.env.MATFLOW_ADMIN_SECRET ?? "";
export const CRON_SECRET = process.env.CRON_SECRET ?? "";

export const ADMIN_COOKIE = "matflow_admin";
export const OP_SESSION_COOKIE = "matflow_op_session";
export const IMPERSONATION_COOKIE = "matflow_impersonation";
export const SENTINEL_OPERATOR_ID = "__matflow_super_admin__";

/** Safe to print: proves which credential was presented without disclosing it. */
export function secretFingerprint(s: string): string {
  return s.length === 0 ? "<absent>" : `len=${s.length} …${s.slice(-4)}`;
}

// ── Operator identities ──────────────────────────────────────────────────────

/**
 * The v1 COOKIE door. A browser context carrying `matflow_admin` = the secret.
 *
 * `addCookies` rather than a real POST /api/admin/auth/login on purpose for the
 * bulk of the cases: the login route is rate-limited to 5 per 15 minutes per IP
 * (app/api/admin/auth/login/route.ts:17) and every lane on this machine shares
 * that bucket. The login route itself is driven once, deliberately, in
 * lg-1's own describe block, which clears the bucket after itself.
 */
export async function operatorCookieContext(
  browser: Browser,
  baseURL: string,
): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL, storageState: undefined });
  await context.clearCookies();
  const host = new URL(baseURL).hostname;
  await context.addCookies([
    { name: ADMIN_COOKIE, value: OPERATOR_SECRET, domain: host, path: "/", httpOnly: true, sameSite: "Strict" },
  ]);
  return context;
}

/** A context carrying a cookie that is NOT the secret — the forgery case. */
export async function forgedOperatorContext(
  browser: Browser,
  baseURL: string,
  value = `${RUN_STAMP}-forged-admin-cookie`,
): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL, storageState: undefined });
  await context.clearCookies();
  const host = new URL(baseURL).hostname;
  await context.addCookies([
    { name: ADMIN_COOKIE, value, domain: host, path: "/", httpOnly: true, sameSite: "Strict" },
  ]);
  return context;
}

/**
 * The v1 HEADER door: `x-admin-secret` with NO session and NO cookie.
 *
 * `isAdminAuthed` tries the header FIRST (lib/admin-auth.ts:78-83), so this is
 * a complete second entrance to every `/api/admin/**` mutation, and the
 * identity it resolves to is the sentinel, not a person
 * (lib/operator-context.ts:46-52).
 */
export function adminHeader(): Record<string, string> {
  return { "x-admin-secret": OPERATOR_SECRET };
}

export function cronHeader(secret = CRON_SECRET): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

// ── Evidence ─────────────────────────────────────────────────────────────────

/**
 * Poll for a fire-and-forget audit row (lib/audit-log.ts:56) and hand back its
 * attribution. `metadata->>'actingAs'` is the only place operator identity is
 * recorded — the column does not exist (lib/audit-log.ts:29-34).
 */
export async function pollAuditRow(
  action: string,
  entityId: string,
  timeoutMs = 5000,
): Promise<{ id: string; userId: string | null; tenantId: string | null; actingAs: string | null }> {
  let found: { id: string; userId: string | null; tenantId: string | null; actingAs: string | null } | null = null;
  await expect
    .poll(
      async () => {
        const rows = await sql<{ id: string; userId: string | null; tenantId: string | null; actingAs: string | null }>(
          `SELECT id, "userId", "tenantId", metadata->>'actingAs' AS "actingAs"
             FROM "AuditLog" WHERE action = $1 AND "entityId" = $2
            ORDER BY "createdAt" DESC LIMIT 1`,
          [action, entityId],
        );
        found = rows[0] ?? null;
        return rows.length;
      },
      { timeout: timeoutMs, message: `audit row ${action} for ${entityId}` },
    )
    .toBeGreaterThan(0);
  return found!;
}

/** How many audit rows in a tenant carry an operator attribution. */
export async function actingAsCount(tenantId: string): Promise<number> {
  const rows = await sql<{ n: string }>(
    `SELECT count(*)::text AS n FROM "AuditLog"
      WHERE "tenantId" = $1 AND metadata->>'actingAs' IS NOT NULL`,
    [tenantId],
  );
  return Number(rows[0].n);
}

export async function auditCount(tenantId: string): Promise<number> {
  const rows = await sql<{ n: string }>(
    `SELECT count(*)::text AS n FROM "AuditLog" WHERE "tenantId" = $1`,
    [tenantId],
  );
  return Number(rows[0].n);
}

/**
 * Compare a database timestamp in SQL, never in JavaScript. A `timestamp`
 * column comes back without a zone and `Date.now()` is local; the comparison
 * belongs where the server clock is (`now() AT TIME ZONE 'UTC'`).
 */
export async function rowIsRecent(
  table: string,
  column: string,
  where: string,
  params: unknown[],
  seconds = 120,
): Promise<boolean> {
  const rows = await sql<{ recent: boolean }>(
    `SELECT ("${column}" > (now() AT TIME ZONE 'UTC') - interval '${seconds} seconds') AS recent
       FROM "${table}" WHERE ${where} LIMIT 1`,
    params,
  );
  return rows[0]?.recent === true;
}

/** Every key a response actually carried — asserted against an allow-list. */
export function keysOf(body: unknown): string[] {
  if (body === null || typeof body !== "object") return [];
  return Object.keys(body as Record<string, unknown>).sort();
}

/**
 * Deep key census of an unauthenticated payload, so a nested PII leak cannot
 * hide under a key set that looks clean at the top level.
 */
export function deepKeys(body: unknown, prefix = "", out: Set<string> = new Set()): string[] {
  if (Array.isArray(body)) {
    for (const item of body.slice(0, 5)) deepKeys(item, `${prefix}[]`, out);
  } else if (body !== null && typeof body === "object") {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.add(path);
      if (v !== null && typeof v === "object") deepKeys(v, path, out);
    }
  }
  return [...out].sort();
}

/** Keys that must never appear in a response nobody authenticated for. */
export const PII_KEYS = [
  "email",
  "phone",
  "passwordHash",
  "totpSecret",
  "totpRecoveryCodes",
  "dateOfBirth",
  "emergencyContactPhone",
  "medicalNotes",
  "address",
  "stripeCustomerId",
  "stripeAccountId",
];

export { sql, RUN_STAMP };
