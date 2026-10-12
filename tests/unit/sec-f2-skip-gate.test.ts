import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, expandExpect, MAINTENANCE, BLOCKED } from "../../scripts/readiness/test-skip-gate.mjs";

/**
 * Lane F2 (iteration 2, 9 Oct 2026). A throwing beforeAll is reported by vitest as a FAILED file whose tests are all
 * "skipped" (tenant-restore-purge-race under matflow_app in the 9 Oct final sweep: "1 failed, 5 skipped", recorded
 * next to exit=0). The gate must never call that green, with or without --require-db; a maintenance tool is not a
 * required check; a BLOCKED required check stays visible.
 */
const file = (name: string, status: string, tests: string[], message = "") => ({
  name, status, message, assertionResults: tests.map((s) => ({ status: s })),
});

describe("test-skip-gate evaluate()", () => {
  it("positive control: a clean run passes", () => {
    const r = evaluate({ success: true, testResults: [file("tests/integration/a-db.test.ts", "passed", ["passed", "passed"])] }, { requireDb: true });
    expect(r.summary.verdict).toBe("PASS");
  });

  it("a setup failure (file failed, every test skipped) FAILS even without --require-db, and is named", () => {
    const j = { success: false, testResults: [file("tests/integration/tenant-restore-purge-race.test.ts", "failed", ["skipped", "skipped", "skipped", "skipped", "skipped"], "Can't reach database server")] };
    for (const requireDb of [false, true]) {
      const r = evaluate(j, { requireDb });
      expect(r.summary.verdict).toBe("FAIL");
      expect(r.problems.join("\n")).toMatch(/SETUP FAILURE — file failed and all 5 tests were reported skipped/);
    }
  });

  it("success:false with no failing file still fails (unhandled error)", () => {
    const r = evaluate({ success: false, testResults: [file("tests/unit/x.test.ts", "passed", ["passed"])] });
    expect(r.summary.verdict).toBe("FAIL");
    expect(r.problems[0]).toMatch(/success:false/);
  });

  it("an empty report fails", () => {
    expect(evaluate({ testResults: [] }).summary.verdict).toBe("FAIL");
  });

  it("the fixture sweep is a maintenance tool: excluded from the expected list, its skip allowed", () => {
    const sweep = "tests/integration/sec-b-fixture-sweep-db.test.ts";
    expect(MAINTENANCE[sweep]).toMatch(/maintenance tool/);
    const r = evaluate({ testResults: [file(sweep, "skipped", ["skipped"]), file("tests/integration/a-db.test.ts", "passed", ["passed"])] },
      { requireDb: true, expected: ["tests/integration/a-db.test.ts", sweep] });
    expect(r.summary.verdict).toBe("PASS");
    expect(r.summary.expected).toBe(1);
    const absent = evaluate({ testResults: [file("tests/integration/a-db.test.ts", "passed", ["passed"])] }, { requireDb: true, expected: ["tests/integration/a-db.test.ts", sweep] });
    expect(absent.summary.verdict).toBe("PASS");
  });

  it("a BLOCKED required check fails by default and passes only as PASS-WITH-BLOCKED-COVERAGE", () => {
    const f2 = "tests/integration/sec-f2-auditlog-append-only-db.test.ts";
    expect(BLOCKED[f2]).toMatch(/SF-57/);
    const j = { testResults: [file(f2, "skipped", Array(10).fill("skipped"))] };
    const strict = evaluate(j, { requireDb: true });
    expect(strict.summary.verdict).toBe("FAIL");
    expect(strict.problems[0]).toMatch(/BLOCKED coverage/);
    const allowed = evaluate(j, { requireDb: true, allowBlocked: true });
    expect(allowed.summary.verdict).toBe("PASS-WITH-BLOCKED-COVERAGE");
    expect(allowed.blocked[0]).toMatch(/SF-57/);
  });

  it("lane E3 (review R2): an --expect glob matching zero files FAILS, naming the glob and the cwd", () => {
    const ok = "tests/integration/*-db.test.ts";
    const typo = "tests/integration/*-dbb.test.ts";
    const { expected, unmatched } = expandExpect([ok, typo], process.cwd());
    expect(expected.size).toBeGreaterThan(10);
    expect(unmatched).toEqual([typo]);
    const j = { testResults: [file("tests/integration/a-db.test.ts", "passed", ["passed"])] };
    const r = evaluate(j, { requireDb: true, expected: [], unmatchedGlobs: unmatched, cwd: "C:/repo" });
    expect(r.summary.verdict).toBe("FAIL");
    expect(r.problems.join("\n")).toContain(`--expect glob "${typo}" matched no file under C:/repo`);
    // End to end: before E3 this printed "expected":0 and exited 0.
    const dir = mkdtempSync(join(tmpdir(), "e3-gate-"));
    const report = join(dir, "vitest.json");
    writeFileSync(report, JSON.stringify({ success: true, testResults: [{ name: join(process.cwd(), "tests/unit/x.test.ts"), status: "passed", assertionResults: [{ status: "passed" }] }] }));
    let code = 0, out = "";
    try { out = execFileSync(process.execPath, ["scripts/readiness/test-skip-gate.mjs", report, `--expect=${typo}`], { encoding: "utf8" }); }
    catch (e) { const err = e as { status?: number; stdout?: string }; code = err.status ?? 1; out = err.stdout ?? ""; }
    expect(code).toBe(1);
    expect(out).toContain(`--expect glob "${typo}" matched no file under ${process.cwd()}`);
    expect(out).toContain('"verdict":"FAIL"');
  });

  it("an unlisted skip still fails under --require-db; a named --allow entry passes", () => {
    const j = { testResults: [file("tests/integration/rls-foundation.test.ts", "passed", ["passed", "skipped"])] };
    expect(evaluate(j, { requireDb: true }).summary.verdict).toBe("FAIL");
    expect(evaluate(j, { requireDb: true, allow: ["tests/integration/rls-foundation.test.ts"] }).summary.verdict).toBe("PASS");
  });
});
