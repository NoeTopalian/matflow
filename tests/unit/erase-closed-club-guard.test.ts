/**
 * scripts/erase-closed-club.mjs — the guarded, by-hand runner for erasing ONE closed club on its written request.
 * Its argument and context checks are pure and are pinned here; it is never run by a test against a database.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseEraseArgs, TargetRefused } from "../../scripts/erase-closed-club.mjs";

const BY_HAND = { env: {} as Record<string, string | undefined>, interactive: true };
const GOOD = ["cmabc123def456ghi789jk", "--reason", "Owner email 1 Nov 2026 asking for full erasure", "--expect-host", "ep-hidden-salad"];

describe("parseEraseArgs", () => {
  it("accepts a club id, a written-request reason and an expected host; --confirm is reported, not assumed", () => {
    expect(parseEraseArgs(GOOD, BY_HAND)).toEqual({ tenantId: GOOD[0], reason: GOOD[2], expectHost: "ep-hidden-salad", confirm: false });
    expect(parseEraseArgs([...GOOD, "--confirm"], BY_HAND).confirm).toBe(true);
  });

  it.each(["CI", "GITHUB_ACTIONS", "VERCEL", "VERCEL_ENV"])("refuses when %s is set: never part of anything automatic", (k) => {
    expect(() => parseEraseArgs([...GOOD, "--confirm"], { env: { [k]: "1" }, interactive: true })).toThrow(TargetRefused);
  });

  it("refuses when not run from an interactive terminal (an agent, a pipe, a scheduler)", () => {
    expect(() => parseEraseArgs([...GOOD, "--confirm"], { env: {}, interactive: false })).toThrow(/interactive/);
  });

  it("refuses a missing or malformed club id, a missing or short reason, and a missing expected host", () => {
    expect(() => parseEraseArgs(GOOD.slice(1), BY_HAND)).toThrow(/club's id/);
    expect(() => parseEraseArgs(["x;rm", ...GOOD.slice(1)], BY_HAND)).toThrow(/club's id/);
    expect(() => parseEraseArgs([GOOD[0], "--expect-host", "ep-hidden-salad"], BY_HAND)).toThrow(/--reason/);
    expect(() => parseEraseArgs([GOOD[0], "--reason", "too short", "--expect-host", "ep-hidden-salad"], BY_HAND)).toThrow(/--reason/);
    expect(() => parseEraseArgs(GOOD.slice(0, 3), BY_HAND)).toThrow(/--expect-host/);
  });

  it("the runner refuses an open club, needs --confirm to act, and reads a busy row as try-again-later", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "scripts/erase-closed-club-run.ts"), "utf8");
    expect(src).toMatch(/if \(!club\.deletedAt\)[\s\S]*?return 2;/);
    expect(src).toMatch(/if \(!confirm\)[\s\S]*?return 3;/);
    expect(src).toMatch(/isTenantRowBusyError\(e\)[\s\S]*?return 75;/);
    expect(src).toMatch(/purgeTenantById\(tenantId, new Date\(\), \(\) => false, \{ writtenRequest: reason \}\)/);
  });

  it("the inner script repeats every guard itself, so running it directly skips nothing", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "scripts/erase-closed-club-run.ts"), "utf8");
    const guards = src.indexOf("parseEraseArgs(argv()");
    expect(guards).toBeGreaterThan(-1);
    expect(src).toMatch(/resolveDbTarget\(process\.env\.DATABASE_URL/);
    expect(src).toMatch(/if \(!process\.env\.BLOB_READ_WRITE_TOKEN\)/);
    // Nothing connects before the guards: the database modules are imported after them.
    expect(src.indexOf('await import("../lib/prisma-tenant")')).toBeGreaterThan(guards);
  });

  it("nothing automatic calls it: no route, cron, workflow or package script names it", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|js|ya?ml|json)$/.test(e.name) && fs.readFileSync(p, "utf8").includes("erase-closed-club")) hits.push(p);
      }
    };
    for (const dir of ["app", "lib", ".github"]) if (fs.existsSync(dir)) walk(dir);
    expect(hits).toEqual([]);
    expect(fs.readFileSync("package.json", "utf8")).not.toContain("erase-closed-club");
    expect(fs.readFileSync("vercel.json", "utf8")).not.toContain("erase-closed-club");
  });
});
