/**
 * Lane L-A — shared machinery for the admission-and-identity spec files.
 *
 * NOT a `.spec.ts`: Playwright must not collect it. Everything here is either
 * a fixture the two L-A files both need or a helper that would otherwise be
 * copied twice and drift.
 *
 * Nothing here touches product code. Lane L-A asserts product files; it does
 * not import them — `tests/e2e` has no `@/` path alias (grep confirms no e2e
 * spec imports one today), and re-deriving the token HMAC locally keeps the
 * spec independent of whether `lib/token-hash.ts` happens to compile under the
 * Playwright transpiler.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseEnvFile } from "dotenv";
import bcrypt from "bcryptjs";
import { expect, type APIRequestContext } from "@playwright/test";
import { RUN_STAMP, sql } from "../helpers/db";

export const TENANT_A_SLUG = "totalbjj";
export const TENANT_A_OWNER = "owner@totalbjj.com";
export const TENANT_A_COACH = "coach@totalbjj.com";
export const TENANT_A_PASSWORD =
  process.env.E2E_BYPASS_TOKEN ?? process.env.TEST_PASSWORD ?? "password123";

/** The password every throwaway account this lane mints is given. */
export const THROWAWAY_PASSWORD = "Ashgrove!2026aA";

/**
 * The signing secret, resolved EXACTLY as `lib/auth-secret.ts:4` resolves it.
 *
 * ROUND 2: this used to be `process.env.NEXTAUTH_SECRET ?? AUTH_SECRET ?? ""`,
 * and the `?? ""` was the whole of six round-2 failures.
 * `playwright.config.ts:25` loads ONLY `.env.test`, which carries twelve keys
 * and no auth secret; the dev server on :3847 is `next dev`, which loads `.env`,
 * where `AUTH_SECRET` does live. So this process HMAC'd with the empty string
 * while the server HMAC'd with the real key, every token this lane minted was
 * unverifiable, and `/api/magic-link/verify` answered `invalid_link` exactly as
 * it should have. The product was right and the harness was wrong.
 *
 * The fix is the pattern `tests/e2e/campaign/identity.spec.ts:78-93` already
 * uses: environment first, then PARSE `.env` into a local object for that one
 * key. Parse, never load — `.env` also holds the production DATABASE_URL and
 * this suite writes. Nothing from that file reaches this process's environment,
 * and the value is never printed.
 */
let cachedSecret: string | null = null;
function authSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
  if (fromEnv) return (cachedSecret = fromEnv);

  const parsed = parseEnvFile(readFileSync(resolve(process.cwd(), ".env")));
  const fromFile = parsed.NEXTAUTH_SECRET ?? parsed.AUTH_SECRET;
  if (!fromFile) {
    throw new Error(
      "No NEXTAUTH_SECRET / AUTH_SECRET in the environment or in .env — this lane " +
        "cannot mint a token the server will accept, and every token assertion " +
        "would fail as though the product had refused it.",
    );
  }
  return (cachedSecret = fromFile);
}

/** Mirrors `lib/token-hash.ts`. Reimplemented, not imported: importing it would
 * pull in `@/lib/auth-secret`, which resolves the same empty secret inside this
 * process and reintroduces the defect above. */
export function hashToken(raw: string): string {
  return createHmac("sha256", authSecret()).update(raw).digest("hex");
}

export async function seededTenantId(): Promise<string> {
  const rows = await sql<{ id: string }>('SELECT id FROM "Tenant" WHERE slug = $1', [TENANT_A_SLUG]);
  if (rows.length === 0) throw new Error('Seeded tenant "totalbjj" is missing — run npm run seed.');
  return rows[0].id;
}

// ── Throwaway subjects ───────────────────────────────────────────────────────

export interface ThrowawayUser {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string;
}

/**
 * A staff row belonging to this run, in the seeded club.
 *
 * NEVER a seeded user. Rule 6 of COMMON: this lane locks accounts out, burns
 * their password history and bumps their sessionVersion, and doing any of that
 * to `owner@totalbjj.com` would fail every other lane with a symptom nowhere
 * near the cause — which is exactly the X-7 Task 2 finding the brief inherits.
 *
 * Default role `coach`, not `owner`: the dashboard layout redirects an owner to
 * /onboarding when the tenant has not completed setup, which would turn a
 * refusal result into a routing result.
 */
export async function createThrowawayUser(
  role: "owner" | "manager" | "coach" | "admin" = "coach",
  over: Partial<{ email: string; password: string; tenantId: string }> = {},
): Promise<ThrowawayUser> {
  const tenantId = over.tenantId ?? (await seededTenantId());
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = over.email ?? `${RUN_STAMP}-${role}-${suffix}@example.test`;
  const name = `Campaign ${role} ${suffix}`;
  const rows = await sql<{ id: string }>(
    `INSERT INTO "User" ("id", "tenantId", "email", "name", "passwordHash", "role", "sessionVersion", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 0, now(), now())
     RETURNING id`,
    [tenantId, email, name, bcrypt.hashSync(over.password ?? THROWAWAY_PASSWORD, 10), role],
  );
  return { id: rows[0].id, email, name, role, tenantId };
}

/** A member of the seeded club with a real password, so it can use the password door. */
export async function createThrowawayMember(
  over: Partial<{ email: string; password: string; tenantId: string; name: string }> = {},
): Promise<{ id: string; email: string; name: string; tenantId: string }> {
  const tenantId = over.tenantId ?? (await seededTenantId());
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = over.email ?? `${RUN_STAMP}-${suffix}@example.test`;
  const name = over.name ?? `Campaign Member ${suffix}`;
  const rows = await sql<{ id: string }>(
    `INSERT INTO "Member" ("id", "tenantId", "name", "email", "status", "paymentStatus",
                           "passwordHash", "sessionVersion", "joinedAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'active', 'paid', $4, 0, now(), now())
     RETURNING id`,
    [tenantId, name, email, bcrypt.hashSync(over.password ?? THROWAWAY_PASSWORD, 10)],
  );
  return { id: rows[0].id, email, name, tenantId };
}

// ── Throwaway tenant (J10) ───────────────────────────────────────────────────

export interface ThrowawayTenant {
  id: string;
  slug: string;
  ownerEmail: string;
  ownerUserId: string;
  memberId: string;
  memberEmail: string;
}

/**
 * A whole second club this lane owns outright, so J10 can suspend, cancel and
 * soft-delete something without ever touching `totalbjj`. Column-named INSERT:
 * the schema gains columns and a positional INSERT would start assigning them
 * to the wrong things silently.
 */
export async function createThrowawayTenant(): Promise<ThrowawayTenant> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const slug = `${RUN_STAMP}-${suffix}`.toLowerCase();
  const rows = await sql<{ id: string }>(
    // ROUND 2: `"updatedAt"` was in this list and `Tenant` has no such column
    // (prisma/schema.prisma:11-56). Every J10 block arranged its club here, so
    // one wrong column name in one INSERT took out four tests directly and left
    // nine more "did not run" behind a failed beforeAll.
    `INSERT INTO "Tenant" ("id", "slug", "name", "subscriptionStatus", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, 'trial', now())
     RETURNING id`,
    [slug, `${RUN_STAMP} Ashgrove Academy`],
  );
  const id = rows[0].id;
  const ownerEmail = `${RUN_STAMP}-tenb-owner-${suffix}@example.test`;
  const owner = await createThrowawayUser("owner", { email: ownerEmail, tenantId: id });
  const memberEmail = `${RUN_STAMP}-tenb-member-${suffix}@example.test`;
  const member = await createThrowawayMember({ email: memberEmail, tenantId: id });
  return { id, slug, ownerEmail, ownerUserId: owner.id, memberId: member.id, memberEmail };
}

/** Dependency order: every child reached through its parent, then the tenant. */
export async function teardownThrowawayTenant(tenantId: string): Promise<void> {
  await sql('DELETE FROM "MagicLinkToken" WHERE "tenantId" = $1', [tenantId]);
  await sql(
    'DELETE FROM "PasswordResetToken" WHERE "tenantId" = $1',
    [tenantId],
  ).catch(() => {});
  await sql(
    'DELETE FROM "PasswordHistory" WHERE "userId" IN (SELECT id FROM "User" WHERE "tenantId" = $1)',
    [tenantId],
  ).catch(() => {});
  await sql('DELETE FROM "EmailLog" WHERE "tenantId" = $1', [tenantId]).catch(() => {});
  await sql('DELETE FROM "LoginEvent" WHERE "tenantId" = $1', [tenantId]).catch(() => {});
  await sql('UPDATE "AuditLog" SET "userId" = NULL WHERE "tenantId" = $1', [tenantId]).catch(() => {});
  await sql('DELETE FROM "AuditLog" WHERE "tenantId" = $1', [tenantId]).catch(() => {});
  await sql('DELETE FROM "Member" WHERE "tenantId" = $1 AND "parentMemberId" IS NOT NULL', [tenantId]);
  await sql('DELETE FROM "Member" WHERE "tenantId" = $1', [tenantId]);
  await sql('DELETE FROM "User" WHERE "tenantId" = $1', [tenantId]);
  await sql('DELETE FROM "Tenant" WHERE id = $1', [tenantId]);
}

// ── Time, and why it needs a helper at all ───────────────────────────────────

/**
 * **A JS `Date` bound into a raw query does NOT mean what the product means.**
 *
 * Every datetime column in `prisma/schema.prisma` is `timestamp without time
 * zone`, and Prisma stores **UTC** wall-clock in it. `pg` does not: it
 * serialises a `Date` parameter with the *local* offset, and Postgres — casting
 * to a naive `timestamp` — keeps the wall-clock digits and throws the offset
 * away. On this runner (BST, UTC+1) that stores 22:49 where the product would
 * store 21:49. Reading is the mirror image: `pg` parses a naive timestamp as
 * *local*, so a row the PRODUCT wrote comes back an hour early.
 *
 * Both directions were live in the round-3 log, as two "product defects" that
 * were nothing of the sort:
 *
 *   la-1:543 / la-2:592 — a token minted "an hour ago" was stored an hour in
 *     the FUTURE, so `/api/magic-link/verify` correctly admitted a token this
 *     lane had told it was still valid. Recorded as "an expired token signs
 *     you in", which would have been an EXPLOIT had it been true.
 *   la-2:220 — `lockedUntil`, written by the product, read back an hour early:
 *     "the lock is roughly an hour out" received a time 30 seconds in the past.
 *
 * A write/read round-trip inside this file is self-cancelling and therefore
 * silent, which is why it survived two rounds. It only shows up when the
 * product is on the other end — which is every assertion that matters.
 *
 * So: bind `utcParam(d)` instead of `d`, and read epoch milliseconds out of
 * the database with `AT TIME ZONE 'UTC'` (see `epochMs`) rather than trusting
 * a parsed `Date`.
 */
export function utcParam(d: Date): string {
  // "YYYY-MM-DD HH:MM:SS.mmm" in UTC — exactly the wall-clock Prisma writes.
  return d.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Epoch milliseconds for a naive timestamp column, read as the UTC the product
 * actually stored. `null` when the column is null.
 */
export async function epochMs(
  table: string,
  column: string,
  id: string,
): Promise<number | null> {
  const rows = await sql<{ ms: string | null }>(
    `SELECT (EXTRACT(EPOCH FROM "${column}" AT TIME ZONE 'UTC') * 1000)::text AS ms
       FROM "${table}" WHERE id = $1`,
    [id],
  );
  const raw = rows[0]?.ms ?? null;
  return raw === null ? null : Number(raw);
}

// ── Tokens ───────────────────────────────────────────────────────────────────

/**
 * Mint a MagicLinkToken of an exact purpose and expiry.
 *
 * Arranged by SQL, not by a screen, deliberately: no screen can mint an EXPIRED
 * token, and no screen at all mints `waiver_open` for an arbitrary email. The
 * ACT is still the real HTTP consume.
 */
export async function mintMagicToken(opts: {
  tenantId: string;
  email: string;
  purpose: "login" | "first_time_signup" | "waiver_open";
  expiresInMs?: number;
  used?: boolean;
}): Promise<{ raw: string; id: string }> {
  const raw = `${RUN_STAMP}${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const rows = await sql<{ id: string }>(
    `INSERT INTO "MagicLinkToken" ("id", "tenantId", "email", "tokenHash", "purpose", "expiresAt", "used", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, now())
     RETURNING id`,
    [
      opts.tenantId,
      opts.email.toLowerCase().trim(),
      hashToken(raw),
      opts.purpose,
      // utcParam, NOT a bare Date — see the note above. A bare Date put an
      // "expired" token an hour into the future and made the product look
      // broken for admitting it.
      utcParam(new Date(Date.now() + (opts.expiresInMs ?? 30 * 60 * 1000))),
      opts.used ?? false,
    ],
  );
  return { raw, id: rows[0].id };
}

export async function magicTokenRow(id: string) {
  const rows = await sql<{ id: string; used: boolean; purpose: string; tenantId: string; email: string }>(
    'SELECT id, used, purpose, "tenantId", email FROM "MagicLinkToken" WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

// ── Counting and refusal ─────────────────────────────────────────────────────

export async function countOf(table: string, where = "TRUE", params: unknown[] = []): Promise<number> {
  const rows = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}" WHERE ${where}`, params);
  return Number(rows[0].n);
}

export async function assertUnchanged(
  table: string,
  before: number,
  where = "TRUE",
  params: unknown[] = [],
): Promise<void> {
  const after = await countOf(table, where, params);
  expect(after, `${table} count(*) across a refused request`).toBe(before);
}

/**
 * Refusal bodies are `{ ok: false, error }` everywhere except /api/staff and
 * /api/staff/[id], which answer `{ error }`. Returns the observed pair so the
 * caller can put the real body in the report rather than a guess at it.
 */
export async function apiRefused(
  rc: APIRequestContext,
  method: "get" | "post" | "patch" | "delete",
  url: string,
  origin: string,
  expectedStatus: number | number[],
  data?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await rc.fetch(url, {
    method: method.toUpperCase(),
    headers: { Origin: origin },
    ...(data === undefined ? {} : { data }),
  });
  const list = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  expect(list, `${method.toUpperCase()} ${url} status`).toContain(res.status());
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status(), body };
}

// ── Rate limits ──────────────────────────────────────────────────────────────

/**
 * Buckets are shared rows keyed partly on an IP every lane on this machine
 * shares (`lib/rate-limit.ts:116-128`). Anything this lane exhausts, this lane
 * clears — otherwise another lane's login fails as a 429 that reads as a bug.
 */
export async function clearBucket(prefix: string): Promise<void> {
  await sql('DELETE FROM "RateLimitHit" WHERE bucket LIKE $1', [`${prefix}%`]);
}

export async function bucketHits(prefix: string): Promise<number> {
  return countOf("RateLimitHit", "bucket LIKE $1", [`${prefix}%`]);
}

/** Poll for a fire-and-forget audit row (`lib/audit-log.ts:56`) — never assert it once. */
export async function pollAudit(action: string, entityId: string, timeoutMs = 5000) {
  await expect
    .poll(
      async () =>
        (
          await sql<{ id: string }>(
            'SELECT id FROM "AuditLog" WHERE action = $1 AND "entityId" = $2',
            [action, entityId],
          )
        ).length,
      { timeout: timeoutMs, message: `audit row ${action} for ${entityId}` },
    )
    .toBeGreaterThan(0);
}
