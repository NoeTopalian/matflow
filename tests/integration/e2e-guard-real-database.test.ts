// The e2e database guard, run against a REAL database rather than a mock.
//
// tests/unit/e2e-database-guard.test.ts proves the refusal logic, but it mocks
// `pg` — and that mocking is exactly how the guard shipped with the wrong
// seeded-tenant slug ("total-bjj" against a seed that writes "totalbjj"). The
// mock returned a row whatever was asked, so the one value the seed check
// depends on was never compared with a real database.
//
// This closes that loop: it runs the actual globalSetup against the actual test
// branch and asserts it ACCEPTS. If the slug, the table name, the column or the
// query ever drift, this fails — and it cannot be satisfied by a mock, because
// there isn't one.
//
// Skips where no database is configured (tests/setup-test-db.ts strips
// DATABASE_URL unless TEST_DATABASE_URL is set), so CI — which has one — is the
// authority.

import { describe, it, expect } from "vitest";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("the e2e guard against the real test database", () => {
  it("accepts it, and confirms it is seeded", async () => {
    const { default: globalSetup } = await import("../e2e/global-setup");

    // No try/catch: a refusal here is the failure, and its message is the most
    // useful thing that could appear in the output.
    await expect(globalSetup()).resolves.toBeUndefined();
  });

  it("still refuses production even with a live connection available", async () => {
    const { default: globalSetup } = await import("../e2e/global-setup");
    const real = process.env.DATABASE_URL;
    process.env.DATABASE_URL =
      "postgresql://u:p@ep-bold-wave-abt123.eu-west-2.aws.neon.tech/neondb?sslmode=require";
    try {
      await expect(globalSetup()).rejects.toThrow(/PRODUCTION/);
    } finally {
      process.env.DATABASE_URL = real;
    }
  });
});
