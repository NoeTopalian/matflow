// Email addresses are lowercase in the database, whatever route wrote them.
//
// This is the invariant that stops a member being locked out of their own
// account, and it exists because the fix for one bug created a worse one:
//
//   * BEFORE 13 Sep, auth.ts looked the address up with the RAW submitted
//     string. A member stored as "Noe@example.com" could sign in with that
//     exact spelling. They could never RECOVER the account — magic link, forgot
//     password and reset all search lowercased and silently found nothing — but
//     they could get in.
//
//   * AFTER 13 Sep, auth.ts parses through emailField(), which lowercases.
//     Member.email is plain TEXT and Postgres `=` on TEXT is case-sensitive, so
//     a mixed-case row now matches NOTHING. Not the mixed spelling, not the
//     lower one. Locked out completely.
//
// The 13 Sep migration was a one-off UPDATE: it healed the rows that existed and
// left nothing to keep the invariant true. Any route bypassing emailField()
// recreates the condition — CSV import, accept-invite, the children route,
// admin create-tenant — and the account it creates can neither log in nor be
// recovered, silently.
//
// So the guarantee is enforced where no route can bypass it. These tests write
// DIRECTLY to the database, deliberately bypassing every application layer,
// because that is exactly what the trigger has to survive.
//
// Both database roles (SF-26, lane F, 9 Oct 2026). Under the restricted role
// (matflow_app, RLS forced) a bare connection sees no Tenant row and may write
// no Member row, so the old version — one autocommit query per statement with
// no tenant context — failed all four cells under that role for a reason that
// had nothing to do with the trigger, and its cleanup silently deleted nothing.
// Every statement now runs in a transaction carrying the same transaction-local
// tenant context the application sets (lib/prisma-tenant.ts), the seeded club
// is resolved the way the application resolves a club by slug (transaction-
// local bypass, read only), and cleanup is by id and count-checked.

import { describe, it, expect, afterAll } from "vitest";
import { Client, type QueryResultRow } from "pg";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const STAMP = `e2e-emailcase-${Date.now().toString(36)}`;

type Q = <T extends QueryResultRow>(text: string, params?: unknown[]) => Promise<T[]>;

/** One transaction with the application's transaction-local RLS context. */
async function inTx<T>(ctx: { tenantId: string } | "bypass", fn: (q: Q) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    if (ctx === "bypass") await client.query("SELECT set_config('app.bypass_rls', 'on', true)");
    else await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [ctx.tenantId]);
    const q: Q = async (text, params = []) => (await client.query(text, params)).rows;
    const out = await fn(q);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end().catch(() => {});
  }
}

let tenantIdCache: string | null = null;
async function seededTenantId(): Promise<string> {
  if (tenantIdCache) return tenantIdCache;
  const rows = await inTx("bypass", (q) =>
    q<{ id: string }>('SELECT id FROM "Tenant" WHERE slug = $1', ["totalbjj"]),
  );
  if (rows.length !== 1) throw new Error('Seeded tenant "totalbjj" is missing on the test branch');
  tenantIdCache = rows[0].id;
  return tenantIdCache;
}

const createdMembers: string[] = [];
const createdTokens: string[] = [];

describe.skipIf(!hasDatabase)("email is stored lowercase whatever writes it", () => {
  afterAll(async () => {
    if (!hasDatabase || !tenantIdCache) return;
    const tenantId = tenantIdCache;
    const counts = await inTx({ tenantId }, async (q) => {
      const t = await q<{ id: string }>('DELETE FROM "MagicLinkToken" WHERE id = ANY($1::text[]) RETURNING id', [createdTokens]);
      const m = await q<{ id: string }>('DELETE FROM "Member" WHERE id = ANY($1::text[]) RETURNING id', [createdMembers]);
      return { tokens: t.length, members: m.length };
    });
    // Count-checked teardown: a cleanup that silently deletes nothing is how
    // the restricted-role run used to leak rows.
    expect(counts).toEqual({ tokens: createdTokens.length, members: createdMembers.length });
  });

  it("lowercases a Member written with capitals, bypassing the app entirely", async () => {
    const tenantId = await seededTenantId();
    const mixed = `${STAMP}-MiXeD@Example.COM`;

    const rows = await inTx({ tenantId }, (q) =>
      q<{ id: string; email: string }>(
        `INSERT INTO "Member" ("id","tenantId","name","email","status","paymentStatus","joinedAt","updatedAt")
         VALUES (gen_random_uuid()::text, $1, 'Mixed Case', $2, 'active', 'paid', now(), now())
         RETURNING id, email`,
        [tenantId, mixed],
      ),
    );
    createdMembers.push(rows[0].id);

    // The row the database actually holds — not what we asked it to hold.
    expect(
      rows[0].email,
      "a mixed-case address survived the write: this member cannot log in and cannot recover",
    ).toBe(mixed.toLowerCase());
  });

  it("also trims, because a trailing space from a spreadsheet is the same defect", async () => {
    const tenantId = await seededTenantId();

    const rows = await inTx({ tenantId }, (q) =>
      q<{ id: string; email: string }>(
        `INSERT INTO "Member" ("id","tenantId","name","email","status","paymentStatus","joinedAt","updatedAt")
         VALUES (gen_random_uuid()::text, $1, 'Padded', $2, 'active', 'paid', now(), now())
         RETURNING id, email`,
        [tenantId, `  ${STAMP}-Padded@Example.com  `],
      ),
    );
    createdMembers.push(rows[0].id);
    expect(rows[0].email).toBe(`${STAMP}-padded@example.com`);
  });

  it("heals a stale row on its next update", async () => {
    // The trigger fires on UPDATE too, so a row that predates it is corrected
    // the first time anything touches it rather than staying broken for ever.
    const tenantId = await seededTenantId();

    const [created] = await inTx({ tenantId }, (q) =>
      q<{ id: string }>(
        `INSERT INTO "Member" ("id","tenantId","name","email","status","paymentStatus","joinedAt","updatedAt")
         VALUES (gen_random_uuid()::text, $1, 'Heal Me', $2, 'active', 'paid', now(), now())
         RETURNING id`,
        [tenantId, `${STAMP}-heal@example.com`],
      ),
    );
    createdMembers.push(created.id);

    const updated = await inTx({ tenantId }, (q) =>
      q<{ email: string }>('UPDATE "Member" SET "email" = $1 WHERE id = $2 RETURNING email', [
        `${STAMP}-HEAL@Example.COM`,
        created.id,
      ]),
    );
    // Exactly one row: an RLS-filtered UPDATE that touches nothing must not
    // read as a pass.
    expect(updated).toHaveLength(1);
    expect(updated[0].email).toBe(`${STAMP}-heal@example.com`);
  });

  it("covers the recovery-token tables, so no token is minted that nobody can redeem", async () => {
    const tenantId = await seededTenantId();

    const [row] = await inTx({ tenantId }, (q) =>
      q<{ id: string; email: string }>(
        `INSERT INTO "MagicLinkToken" ("id","tenantId","email","tokenHash","purpose","expiresAt","createdAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, 'login', now() + interval '30 minutes', now())
         RETURNING id, email`,
        [tenantId, `${STAMP}-Token@Example.com`, `hash-${STAMP}`],
      ),
    );
    createdTokens.push(row.id);
    expect(row.email).toBe(`${STAMP}-token@example.com`);
  });
});
