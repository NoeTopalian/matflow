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

/**
 * Stamp shared by everything one run creates, so cleanup can find it all.
 *
 * Read from the environment first: Playwright starts a FRESH worker process
 * after every failed test, and a per-process stamp meant one failure changed
 * the stamp for every test after it — every identity the run had created
 * vanished, and the follow-on sign-ins failed as unknown addresses (round 2,
 * lane A0: ten of its twenty-three failures were this one fault). global-setup
 * pins PLAYWRIGHT_RUN_STAMP once per invocation, so worker restarts keep the
 * stamp; the bare-Date fallback only fires for code importing this module
 * outside a Playwright run (e.g. a node probe), where there are no workers.
 */
export const RUN_STAMP = process.env.PLAYWRIGHT_RUN_STAMP ?? `e2e-${Date.now().toString(36)}`;

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
    // Dates cross the wire as explicit UTC. node-postgres serialises a JS Date
    // as LOCAL time with an offset suffix; a TIMESTAMP(3)-without-zone column
    // discards the suffix and keeps the local wall clock, while Prisma reads
    // the column back as UTC — so on a BST host every Date this harness wrote
    // landed an hour in the future (round 3, lane L-C: a token "expired one
    // second ago" had 59m59s left). toISOString() stores the UTC wall clock,
    // which matches Prisma's convention for both timestamp and timestamptz.
    const wire = params.map((p) => (p instanceof Date ? p.toISOString() : p));
    const { rows } = await client.query<T>(text, wire);
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

/**
 * A Payment row in a given state, for webhook lanes that must find one.
 *
 * `stripePaymentIntentId` is globally unique, so it is stamped with the run
 * stamp rather than a bare counter — two workers minting `pi_test_1` would
 * collide and the failure would read as a product defect.
 */
export async function createPayment(over: Partial<{
  memberId: string | null;
  amountPence: number;
  status: string;
  stripePaymentIntentId: string | null;
  stripeChargeId: string | null;
  description: string;
}> = {}): Promise<{ id: string; stripePaymentIntentId: string | null }> {
  const tenantId = await seededTenantId();
  const rows = await sql<{ id: string; stripePaymentIntentId: string | null }>(
    `INSERT INTO "Payment" ("id", "tenantId", "memberId", "amountPence", "currency", "status",
                            "stripePaymentIntentId", "stripeChargeId", "description")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'GBP', $4, $5, $6, $7)
     RETURNING id, "stripePaymentIntentId"`,
    [
      tenantId,
      over.memberId ?? null,
      over.amountPence ?? 1000,
      over.status ?? "pending",
      over.stripePaymentIntentId ?? null,
      over.stripeChargeId ?? null,
      over.description ?? `${RUN_STAMP} campaign payment`,
    ],
  );
  return rows[0];
}

export async function getPayment(id: string) {
  const rows = await sql<{ id: string; status: string; amountPence: number; failureReason: string | null }>(
    'SELECT id, status, "amountPence", "failureReason" FROM "Payment" WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/** A pending shop order, as `member/checkout` leaves one before Stripe is reached. */
export async function createOrder(over: Partial<{
  memberId: string | null;
  status: string;
  paymentMethod: string;
  totalPence: number;
}> = {}): Promise<{ id: string; orderRef: string }> {
  const tenantId = await seededTenantId();
  const orderRef = `${RUN_STAMP.toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const rows = await sql<{ id: string; orderRef: string }>(
    `INSERT INTO "Order" ("id", "tenantId", "memberId", "orderRef", "items", "totalPence",
                          "currency", "status", "paymentMethod", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4::jsonb, $5, 'GBP', $6, $7, now())
     RETURNING id, "orderRef"`,
    [
      tenantId,
      over.memberId ?? null,
      orderRef,
      JSON.stringify([{ id: "p1", name: "Rash guard", price: 2500, quantity: 1 }]),
      over.totalPence ?? 2500,
      over.status ?? "pending",
      over.paymentMethod ?? "stripe",
    ],
  );
  return rows[0];
}

export async function getOrder(id: string) {
  const rows = await sql<{ id: string; status: string; orderRef: string }>(
    'SELECT id, status, "orderRef" FROM "Order" WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/** Whether the webhook claimed this Stripe event id. Absence is a real signal. */
export async function stripeEventClaimed(eventId: string): Promise<boolean> {
  const rows = await sql<{ id: string }>('SELECT id FROM "StripeEvent" WHERE "eventId" = $1', [eventId]);
  return rows.length > 0;
}

export async function auditEntriesFor(action: string, entityId: string) {
  return sql<{ id: string; action: string; metadata: unknown }>(
    'SELECT id, action, metadata FROM "AuditLog" WHERE action = $1 AND "entityId" = $2 ORDER BY "createdAt" DESC',
    [action, entityId],
  );
}

/**
 * Snapshot the club's Stripe connection and hand back a restore function.
 *
 * The deauthorized lane deliberately breaks the shared club's connection, and a
 * spec that left it broken would fail every later money spec with a symptom
 * nowhere near the cause.
 */
export async function saveStripeConnection(): Promise<() => Promise<void>> {
  const tenantId = await seededTenantId();
  const before = await sql<{
    stripeAccountId: string | null;
    stripeConnected: boolean;
    stripeAccountStatus: unknown;
  }>('SELECT "stripeAccountId", "stripeConnected", "stripeAccountStatus" FROM "Tenant" WHERE id = $1', [
    tenantId,
  ]);
  const prev = before[0];
  return async () => {
    await sql(
      'UPDATE "Tenant" SET "stripeAccountId" = $1, "stripeConnected" = $2, "stripeAccountStatus" = $3::jsonb WHERE id = $4',
      [
        prev.stripeAccountId,
        prev.stripeConnected,
        prev.stripeAccountStatus === null ? null : JSON.stringify(prev.stripeAccountStatus),
        tenantId,
      ],
    );
  };
}

export async function getTenantStripe() {
  const tenantId = await seededTenantId();
  const rows = await sql<{
    stripeAccountId: string | null;
    stripeConnected: boolean;
    stripeAccountStatus: { disabledReason?: string; chargesEnabled?: boolean } | null;
  }>('SELECT "stripeAccountId", "stripeConnected", "stripeAccountStatus" FROM "Tenant" WHERE id = $1', [
    tenantId,
  ]);
  return rows[0];
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
  // Rows this run created that are NOT reachable from a member. The webhook lane
  // writes payments with a null memberId (a one-off charge need not belong to
  // anyone) and orders and event claims that belong to no member at all — all
  // of which the member-led sweep below would walk straight past, leaving the
  // shared branch to accrete exactly as it did before this helper existed.
  await sql('DELETE FROM "Payment" WHERE description LIKE $1', [`${stamp}%`]);
  await sql('DELETE FROM "Order" WHERE "orderRef" LIKE $1', [`${stamp.toUpperCase()}-%`]);
  await sql('DELETE FROM "StripeEvent" WHERE "eventId" LIKE $1', [`evt_${stamp}%`]);

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
