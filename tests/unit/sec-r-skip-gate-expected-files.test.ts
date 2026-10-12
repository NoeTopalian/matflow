import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Review of lane F (R, 9 Oct 2026): a run that simply leaves the database files out passed the skip gate with
 * --require-db. With --expect=<glob> every matching file must be present in the results.
 */
function run(json: object, args: string[]): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "skip-gate-"));
  const file = join(dir, "vitest.json");
  writeFileSync(file, JSON.stringify(json));
  try {
    const out = execFileSync("node", ["scripts/readiness/test-skip-gate.mjs", file, ...args], { encoding: "utf8", cwd: process.cwd() });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, out: err.stdout ?? "" };
  }
}
const passing = (name: string) => ({ name: join(process.cwd(), name), status: "passed", assertionResults: [{ status: "passed" }] });

describe("test-skip-gate --expect", () => {
  it("a run that omits an expected database file fails", () => {
    const r = run({ testResults: [passing("tests/unit/production-dependencies.test.ts")] }, ["--require-db", "--expect=tests/integration/sec-f-pool-exhaustion-db.test.ts"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("expected in this run but absent");
  });

  it("a run that includes every expected file passes", () => {
    const r = run({ testResults: [passing("tests/integration/sec-f-pool-exhaustion-db.test.ts")] }, ["--require-db", "--expect=tests/integration/sec-f-pool-exhaustion-db.test.ts"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('"expected":1');
  });

  it("the glob form expands to every database file in the tree", () => {
    const r = run({ testResults: [passing("tests/integration/sec-f-pool-exhaustion-db.test.ts")] }, ["--require-db", "--expect=tests/integration/*-db.test.ts"]);
    expect(r.code).toBe(1);
    const expected = Number(/"expected":(\d+)/.exec(r.out)?.[1] ?? 0);
    expect(expected).toBeGreaterThan(10);
  });
});
