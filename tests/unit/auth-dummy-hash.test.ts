// Speed quick win 2b (6 Nov 2026): auth.ts's DUMMY_HASH — the hash a sign-in
// for an unknown address is compared against, so it takes as long as a real
// one (no email enumeration by timing) — is a precomputed literal instead of
// bcrypt.hashSync at module load, which cost every cold start a full cost-12
// hash. These pin the properties the timing padding depends on.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import bcrypt from "bcryptjs";

const src = readFileSync(join(process.cwd(), "auth.ts"), "utf8");
const DUMMY_HASH = src.match(/^const DUMMY_HASH = "(\$2[aby]\$\d\d\$[./A-Za-z0-9]{53})";\r?$/m)?.[1];

describe("auth.ts DUMMY_HASH", () => {
  it("is a well-formed bcrypt literal", () => {
    expect(DUMMY_HASH).toBeDefined();
  });

  it("has cost 12, the cost of real password hashes", () => {
    expect(bcrypt.getRounds(DUMMY_HASH!)).toBe(12);
  });

  it("nothing in auth.ts hashes at module load any more", () => {
    expect(src).not.toMatch(/hashSync\(/);
  });

  it("the unknown-address path compares against it", () => {
    expect(src).toMatch(/\?\?\s*\n?\s*DUMMY_HASH;/);
    expect(src).toMatch(/await bcrypt\.compare\(password, targetHash\)/);
  });

  it("a compare takes the normal path: a full cost-12 compare that answers false", async () => {
    // A malformed or low-cost hash would answer fast and leak "no such account".
    const real = await bcrypt.hash("someone's real password", 12);
    const time = async (hash: string) => {
      const t = performance.now();
      const ok = await bcrypt.compare("a wrong guess", hash);
      return { ok, ms: performance.now() - t };
    };
    await time(real); // warm the JIT
    const dummy = await time(DUMMY_HASH!);
    const control = await time(real);
    expect(dummy.ok).toBe(false);
    expect(control.ok).toBe(false);
    // Same cost, same work: within a wide band so a busy CI machine cannot flake it.
    expect(dummy.ms).toBeGreaterThan(control.ms * 0.4);
    expect(dummy.ms).toBeLessThan(control.ms * 2.5);
  }, 30_000);
});
