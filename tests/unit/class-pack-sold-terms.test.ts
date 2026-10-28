// Packs per product (owner decision, 27 Oct 2026): "Existing purchases keep
// their recorded terms and remaining credits ... Later product edits must not
// silently rewrite sold entitlements."
//
// A purchase's expiry is written once, when the Stripe webhook creates the
// MemberClassPack, and never rewritten. Nothing writes the status "expired":
// the member pack list applies the date when reading (no lazy write, so a
// no-expiry pack can never be marked expired by a `null < now` comparison).
// Pinned at source level across every file that touches member class packs.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const DIRS = ["app", "lib", "components", "scripts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const packFiles = DIRS.flatMap((d) => walk(join(ROOT, d)))
  .map((p) => ({ path: relative(ROOT, p).replace(/\\/g, "/"), src: stripComments(readFileSync(p, "utf8")) }))
  .filter((f) => /memberClassPack|"MemberClassPack"/.test(f.src));

/** The argument text of every memberClassPack update/updateMany/upsert call, up to its closing `})`. */
function updateCalls(src: string): string[] {
  const out: string[] = [];
  const re = /memberClassPack\.(update|updateMany|upsert)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

describe("sold class packs keep their recorded terms", () => {
  it("finds the files that touch member class packs (sanity)", () => {
    const paths = packFiles.map((f) => f.path);
    expect(paths).toContain("lib/checkin.ts");
    expect(paths).toContain("app/api/stripe/webhook/route.ts");
    expect(paths).toContain("app/api/member/class-packs/route.ts");
    expect(packFiles.flatMap((f) => updateCalls(f.src)).length).toBeGreaterThan(3);
  });

  it("no update rewrites a sold pack's expiresAt (Prisma or SQL)", () => {
    const offenders = packFiles.filter((f) =>
      updateCalls(f.src).some((call) => /expiresAt/.test(call)) ||
      /UPDATE\s+"MemberClassPack"[\s\S]{0,300}?SET[\s\S]{0,300}?"expiresAt"/i.test(f.src),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("nothing writes the status \"expired\"; expiry is applied when reading", () => {
    const offenders = packFiles.filter((f) =>
      /status:\s*["']expired["']/.test(f.src) ||
      /SET\s+"?status"?\s*=\s*'expired'/i.test(f.src),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("the only place a pack's expiry is set is the sale, from the product's validityDays", () => {
    const webhook = packFiles.find((f) => f.path === "app/api/stripe/webhook/route.ts")!.src;
    expect(webhook).toMatch(/memberClassPack\.create\(/);
    expect(webhook).toMatch(/packExpiresAt\(\s*purchasedAt\s*,\s*pack\.validityDays\s*\)/);
  });
});
