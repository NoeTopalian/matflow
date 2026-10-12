/**
 * Security campaign iteration 2, lane E3 (9 Oct 2026) — review R2 coordinator residual on tests/setup-test-db.ts:
 *  - patch 0003 made scripts/readiness/db-target.mjs refuse PGOPTIONS / PGHOST / PGHOSTADDR (node-postgres applies
 *    PGOPTIONS — e.g. endpoint=<production id> — to a TEST URL); the Vitest setup file did not mirror it;
 *  - the setup file lower-cases before comparing with the production endpoint id, but no test pinned that.
 * The setup module is re-imported with a controlled environment; nothing connects.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const PROD_ID = "ep-bold-wave-abt39t7x";
const TEST_URL = "postgresql://u:p@ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";
const PROD_URL = `postgresql://u:p@${PROD_ID}-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require`;
const KEYS = ["TEST_DATABASE_URL", "DATABASE_URL", "PGOPTIONS", "PGHOST", "PGHOSTADDR"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

async function loadSetup(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  return import("../setup-test-db");
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("tests/setup-test-db.ts", () => {
  it("positive control: a TEST URL is mirrored into DATABASE_URL", async () => {
    await loadSetup({ TEST_DATABASE_URL: TEST_URL, DATABASE_URL: PROD_URL });
    expect(process.env.DATABASE_URL).toBe(TEST_URL);
  });

  it.each([
    ["PGOPTIONS", `endpoint=${PROD_ID}`],
    ["PGHOST", `${PROD_ID}-pooler.eu-west-2.aws.neon.tech`],
    ["PGHOSTADDR", "10.0.0.1"],
  ])("refuses %s in the environment (node-postgres would apply it to the TEST URL)", async (k, v) => {
    await expect(loadSetup({ TEST_DATABASE_URL: TEST_URL, [k]: v })).rejects.toThrow(new RegExp(k));
  });

  it("refuses an UPPER-CASE production endpoint in TEST_DATABASE_URL (lower-casing is load-bearing)", async () => {
    await expect(loadSetup({ TEST_DATABASE_URL: PROD_URL.replace(PROD_ID, PROD_ID.toUpperCase()) })).rejects.toThrow(/production Neon project/);
  });

  it("strips an UPPER-CASE production DATABASE_URL when no TEST_DATABASE_URL is set", async () => {
    await loadSetup({ DATABASE_URL: PROD_URL.replace(PROD_ID, PROD_ID.toUpperCase()) });
    expect(process.env.DATABASE_URL).toBeUndefined();
  });
});
