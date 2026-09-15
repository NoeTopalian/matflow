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

import { describe, it, expect, afterAll } from "vitest";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const STAMP = `e2e-emailcase-${Date.now().toString(36)}`;

describe.skipIf(!hasDatabase)("email is stored lowercase whatever writes it", () => {
  afterAll(async () => {
    if (!hasDatabase) return;
    const { sql } = await import("../e2e/campaign/helpers/db");
    await sql('DELETE FROM "Member" WHERE email LIKE $1', [`${STAMP}%`]);
    await sql('DELETE FROM "MagicLinkToken" WHERE email LIKE $1', [`${STAMP}%`]);
  });

  it("lowercases a Member written with capitals, bypassing the app entirely", async () => {
    const { sql, seededTenantId } = await import("../e2e/campaign/helpers/db");
    const tenantId = await seededTenantId();
    const mixed = `${STAMP}-MiXeD@Example.COM`;

    const rows = await sql<{ id: string; email: string }>(
      `INSERT INTO "Member" ("id","tenantId","name","email","status","paymentStatus","joinedAt","updatedAt")
       VALUES (gen_random_uuid()::text, $1, 'Mixed Case', $2, 'active', 'paid', now(), now())
       RETURNING id, email`,
      [tenantId, mixed],
    );

    // The row the database actually holds — not what we asked it to hold.
    expect(
      rows[0].email,
      "a mixed-case address survived the write: this member cannot log in and cannot recover",
    ).toBe(mixed.toLowerCase());
  });

  it("also trims, because a trailing space from a spreadsheet is the same defect", async () => {
    const { sql, seededTenantId } = await import("../e2e/campaign/helpers/db");
    const tenantId = await seededTenantId();

    const rows = await sql<{ email: string }>(
      `INSERT INTO "Member" ("id","tenantId","name","email","status","paymentStatus","joinedAt","updatedAt")
       VALUES (gen_random_uuid()::text, $1, 'Padded', $2, 'active', 'paid', now(), now())
       RETURNING email`,
      [tenantId, `  ${STAMP}-Padded@Example.com  `],
    );
    expect(rows[0].email).toBe(`${STAMP}-padded@example.com`);
  });

  it("heals a stale row on its next update", async () => {
    // The trigger fires on UPDATE too, so a row that predates it is corrected
    // the first time anything touches it rather than staying broken for ever.
    const { sql, seededTenantId } = await import("../e2e/campaign/helpers/db");
    const tenantId = await seededTenantId();

    const [created] = await sql<{ id: string }>(
      `INSERT INTO "Member" ("id","tenantId","name","email","status","paymentStatus","joinedAt","updatedAt")
       VALUES (gen_random_uuid()::text, $1, 'Heal Me', $2, 'active', 'paid', now(), now())
       RETURNING id`,
      [tenantId, `${STAMP}-heal@example.com`],
    );

    const [updated] = await sql<{ email: string }>(
      'UPDATE "Member" SET "email" = $1 WHERE id = $2 RETURNING email',
      [`${STAMP}-HEAL@Example.COM`, created.id],
    );
    expect(updated.email).toBe(`${STAMP}-heal@example.com`);
  });

  it("covers the recovery-token tables, so no token is minted that nobody can redeem", async () => {
    const { sql, seededTenantId } = await import("../e2e/campaign/helpers/db");
    const tenantId = await seededTenantId();

    const [row] = await sql<{ email: string }>(
      `INSERT INTO "MagicLinkToken" ("id","tenantId","email","tokenHash","purpose","expiresAt","createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'login', now() + interval '30 minutes', now())
       RETURNING email`,
      [tenantId, `${STAMP}-Token@Example.com`, `hash-${STAMP}`],
    );
    expect(row.email).toBe(`${STAMP}-token@example.com`);
  });
});
