// POST /api/payments/manual REQUIRES a caller-held requestId (it dedupes a
// retried payment on it). The profile's "Mark paid manually" drawer never sent
// one, so every submit answered "Invalid data" and no payment could ever be
// recorded from there (Wave 1 re-drive, 30 Sep 2026). Every client file that
// posts to the route must send a requestId and word its failures with the
// idempotent save-failure sentence.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const callers = [...walk(join(ROOT, "components")), ...walk(join(ROOT, "app"))].filter((f) =>
  readFileSync(f, "utf8").includes('"/api/payments/manual"'),
);

describe("manual payment callers", () => {
  it("finds the callers (sanity)", () => {
    expect(callers.length).toBeGreaterThanOrEqual(2);
  });

  it.each(callers.map((f) => f.slice(ROOT.length + 1)))("%s sends a requestId held across retries", (rel) => {
    const src = readFileSync(join(ROOT, rel), "utf8");
    expect(src, "posts without a requestId").toMatch(/requestId/);
    expect(src, "requestId must be minted per payment, not per request").toMatch(/crypto\.randomUUID\(\)/);
  });
});
