import { Client, type QueryResultRow } from "pg";

/**
 * Direct database access for ARRANGING state the UI cannot reach.
 *
 * Most of what these specs assert must be driven through the browser — that is
 * the whole point of the campaign. But several journeys have a precondition no
 * screen can create: a club that is suspended, a staff row deleted mid-session,
 * a member whose payment fell due yesterday, a mixed-case email already stored.
 * Arranging those through the UI would either be impossible or would test the
 * arrangement rather than the thing under test.
 *
 * **The rule this file exists to enforce: ARRANGE here, ACT in the browser,
 * ASSERT in both.** A spec that also asserts through this client alone is
 * asserting that the database does what the database does. The product is the
 * screen; the screen is what has never been verified.
 *
 * Safety: `tests/e2e/global-setup.ts` has already refused to start the run
 * unless DATABASE_URL is the test branch or an ephemeral local Postgres, so by
 * the time any of this executes the target is known-good. This file adds no
 * guard of its own precisely so there is one place to reason about, not two
 * that can disagree.
 *
 * Uses `pg` rather than Prisma deliberately: Playwright workers are separate
 * processes from the app, and standing up a Prisma engine per worker against a
 * shared Neon branch is both slow and a source of connection contention the
 * suite has been bitten by before.
 */

/** Stamp shared by everything one run creates, so cleanup can find it all. */
export const RUN_STAMP = `e2e-${Date.now().toString(36)}`;

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — global-setup should have refused this run.");
  return url;
}

/**
 * Run one query and close. A connection per call rather than a shared pool:
 * Playwright runs workers in parallel and a pool handed across them is a
 * well-known source of "connection already released" flakes that read as
 * product bugs.
 */
export async function sql<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const { rows } = await client.query<T>(text, params);
    return rows;
  } finally {
    await client.end().catch(() => {});
  }
}

/** The seeded club every spec works against. */
export async function seededTenantId(): Promise<string> {
  const rows = await sql<{ id: string }>('SELECT id FROM "Tenant" WHERE slug = $1', ["totalbjj"]);
  if (rows.length === 0) throw new Error('Seeded tenant "totalbjj" is missing — run npm run seed.');
  return rows[0].id;
}

// ── Members ──────────────────────────────────────────────────────────────────

export interface TestMember {
  id: string;
  name: string;
  email: string;
}

/**
 * A member belonging to this run, named so a human reading the database can see
 * where it came from and cleanup can find it.
 */
export async function createMember(over: Partial<{
  name: string;
  email: string;
  status: string;
  paymentStatus: string;
  nextDueAt: Date | null;
}> = {}): Promise<TestMember> {
  const tenantId = await seededTenantId();
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = over.name ?? `Campaign ${suffix}`;
  const email = over.email ?? `${RUN_STAMP}-${suffix}@example.test`;

  const rows = await sql<{ id: string }>(
    `INSERT INTO "Member" ("id", "tenantId", "name", "email", "status", "paymentStatus", "nextDueAt", "joinedAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, now(), now())
     RETURNING id`,
    [
      tenantId,
      name,
      email,
      over.status ?? "active",
      over.paymentStatus ?? "paid",
      over.nextDueAt ?? null,
    ],
  );
  return { id: rows[0].id, name, email };
}

export async function getMember(id: string) {
  const rows = await sql<{
    id: string;
    name: string;
    email: string | null;
    status: string;
    paymentStatus: string;
    nextDueAt: Date | null;
  }>('SELECT id, name, email, status, "paymentStatus", "nextDueAt" FROM "Member" WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** Payments recorded against a member, newest first. */
export async function paymentsFor(memberId: string) {
  return sql<{
    id: string;
    amountPence: number;
    currency: string;
    status: string;
    description: string | null;
    requestId: string | null;
  }>(
    `SELECT id, "amountPence", currency, status, description, "requestId"
     FROM "Payment" WHERE "memberId" = $1 ORDER BY "createdAt" DESC`,
    [memberId],
  );
}

// ── Club state the UI cannot set ─────────────────────────────────────────────

/** Returns a restore function, so a spec cannot leave the shared club suspended. */
export async function setTenantStatus(status: string): Promise<() => Promise<void>> {
  const tenantId = await seededTenantId();
  const before = await sql<{ subscriptionStatus: string | null }>(
    'SELECT "subscriptionStatus" FROM "Tenant" WHERE id = $1',
    [tenantId],
  );
  const previous = before[0]?.subscriptionStatus ?? "trial";
  await sql('UPDATE "Tenant" SET "subscriptionStatus" = $1 WHERE id = $2', [status, tenantId]);
  return async () => {
    await sql('UPDATE "Tenant" SET "subscriptionStatus" = $1 WHERE id = $2', [previous, tenantId]);
  };
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Remove everything this run created.
 *
 * Deliberately resolves children BEFORE deleting parents. The cross-tenant
 * suite once deleted parents by prefix and children by per-run stamp, so any
 * interrupted run left orphans that failed every later run on a foreign-key
 * constraint — for ever. The test branch still carries 23 junk tenants from
 * that era. This heals rather than accretes.
 */
export async function cleanupRun(stamp: string = RUN_STAMP): Promise<void> {
  const members = await sql<{ id: string }>(
    `SELECT id FROM "Member" WHERE email LIKE $1`,
    [`${stamp}-%@example.test`],
  );
  if (members.length === 0) return;
  const ids = members.map((m) => m.id);

  // Children first, in dependency order, so a partial failure cannot orphan.
  await sql('DELETE FROM "ClassPackRedemption" WHERE "memberPackId" IN (SELECT id FROM "MemberClassPack" WHERE "memberId" = ANY($1))', [ids]);
  await sql('DELETE FROM "MemberClassPack" WHERE "memberId" = ANY($1)', [ids]);
  await sql('DELETE FROM "AttendanceRecord" WHERE "memberId" = ANY($1)', [ids]);
  await sql('DELETE FROM "Payment" WHERE "memberId" = ANY($1)', [ids]);
  await sql('DELETE FROM "MemberRank" WHERE "memberId" = ANY($1)', [ids]);
  await sql('DELETE FROM "Member" WHERE id = ANY($1)', [ids]);
}
