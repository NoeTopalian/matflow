// G6 (owner decision, 27 Oct 2026): "It should be till it runs out". After
// the review of 27 Oct 2026 nothing in the app reads MemberClassPack.expiresAt
// to decide anything, nothing writes the status "expired", and every pack
// written gets expiresAt NULL. Pinned at source level across every file that
// touches class packs, so a later edit cannot quietly bring expiry back.
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

describe("class packs never expire — writers", () => {
  it("finds the files that touch member class packs (sanity)", () => {
    const paths = packFiles.map((f) => f.path);
    expect(paths).toContain("lib/checkin.ts");
    expect(paths).toContain("app/api/stripe/webhook/route.ts");
    expect(paths).toContain("app/api/member/class-packs/route.ts");
  });

  it("no file writes the status \"expired\" (Prisma data or SQL)", () => {
    const offenders = packFiles.filter((f) =>
      /data:\s*\{[^}]*status:\s*["']expired["']/.test(f.src) ||
      /SET\s+"?status"?\s*=\s*'expired'/i.test(f.src) ||
      /INSERT INTO "MemberClassPack"[\s\S]{0,400}?'expired'/.test(f.src),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("no file writes a pack expiry other than NULL", () => {
    const offenders = packFiles.filter((f) =>
      /data:\s*\{[^}]*expiresAt:\s*(?!null\b)[^\s,}]/.test(f.src) ||
      /SET\s+"?expiresAt"?\s*=\s*(?!NULL)/i.test(f.src),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("the spend and list paths do not read expiresAt", () => {
    const claim = packFiles.find((f) => f.path === "lib/checkin.ts")!.src;
    const claimPack = claim.slice(claim.indexOf("async function claimPack"), claim.indexOf("async function claimPack") + 1500);
    expect(claimPack).not.toMatch(/expiresAt/);
    expect(packFiles.find((f) => f.path === "app/api/member/class-packs/route.ts")!.src).not.toMatch(/expiresAt/);
  });
});
