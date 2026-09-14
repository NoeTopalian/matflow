// The e2e campaign's arrange-state helper, exercised against a real database.
//
// Ten Playwright lanes are about to be built on top of tests/e2e/campaign/
// helpers/db.ts. If its SQL is wrong — a column that does not exist, a NOT NULL
// with no default, a foreign key in the wrong order — every one of those lanes
// fails in a way that looks like a product bug.
//
// This is here because the FIRST version of the e2e guard shipped with the wrong
// tenant slug and its unit tests passed anyway, because they mocked the query.
// Helpers get verified against the real thing before anything depends on them.
//
// Skips where no database is configured, so CI is the authority.

import { describe, it, expect, afterAll } from "vitest";

const hasDatabase = Boolean(process.env.DATABASE_URL);

const STAMP = `e2e-helpertest-${Date.now().toString(36)}`;

describe.skipIf(!hasDatabase)("campaign db helper", () => {
  afterAll(async () => {
    if (!hasDatabase) return;
    const { cleanupRun } = await import("../e2e/campaign/helpers/db");
    await cleanupRun(STAMP);
  });

  it("finds the seeded club", async () => {
    const { seededTenantId } = await import("../e2e/campaign/helpers/db");
    const id = await seededTenantId();
    expect(id).toBeTruthy();
  });

  it("creates a member that really exists, with the fields it was asked for", async () => {
    const { createMember, getMember } = await import("../e2e/campaign/helpers/db");
    const due = new Date("2026-01-15T00:00:00.000Z");
    const created = await createMember({
      email: `${STAMP}-a@example.test`,
      paymentStatus: "overdue",
      nextDueAt: due,
    });

    const row = await getMember(created.id);
    expect(row, "the member the helper claimed to create does not exist").not.toBeNull();
    expect(row!.email).toBe(`${STAMP}-a@example.test`);
    expect(row!.paymentStatus).toBe("overdue");
    expect(row!.nextDueAt?.toISOString()).toBe(due.toISOString());
  });

  it("reads back payments for a member (empty is a valid answer, an error is not)", async () => {
    const { createMember, paymentsFor } = await import("../e2e/campaign/helpers/db");
    const m = await createMember({ email: `${STAMP}-b@example.test` });
    await expect(paymentsFor(m.id)).resolves.toEqual([]);
  });

  it("restores the club's status after changing it", async () => {
    // A spec that suspends the shared club and dies must not leave it suspended
    // for every later spec — hence the restore function rather than a setter.
    const { setTenantStatus, seededTenantId, sql } = await import("../e2e/campaign/helpers/db");
    const tenantId = await seededTenantId();

    const before = await sql<{ subscriptionStatus: string | null }>(
      'SELECT "subscriptionStatus" FROM "Tenant" WHERE id = $1',
      [tenantId],
    );
    const restore = await setTenantStatus("suspended");

    const during = await sql<{ subscriptionStatus: string | null }>(
      'SELECT "subscriptionStatus" FROM "Tenant" WHERE id = $1',
      [tenantId],
    );
    expect(during[0].subscriptionStatus).toBe("suspended");

    await restore();
    const after = await sql<{ subscriptionStatus: string | null }>(
      'SELECT "subscriptionStatus" FROM "Tenant" WHERE id = $1',
      [tenantId],
    );
    expect(after[0].subscriptionStatus).toBe(before[0].subscriptionStatus);
  });

  it("cleans up everything it created, leaving no orphans", async () => {
    const { createMember, getMember, cleanupRun } = await import("../e2e/campaign/helpers/db");
    const m = await createMember({ email: `${STAMP}-c@example.test` });
    expect(await getMember(m.id)).not.toBeNull();

    await cleanupRun(STAMP);
    expect(
      await getMember(m.id),
      "cleanup left the member behind — this is how the test branch accreted 23 junk tenants",
    ).toBeNull();
  });
});
