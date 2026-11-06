/**
 * Keep closed clubs (product rule, Noe, 16 Oct 2026): a club that closes is
 * KEPT, sign-in disabled, so it can reopen. MatFlow never deletes a club or its
 * data on its own; erasure happens only on the club's written request, run by
 * an operator through `purgeTenantById`.
 *
 * Source ratchets. They read the files rather than importing the route so no
 * database, mock table or env is needed, and so a re-introduced purge rule is
 * caught even if it is wired in a way the behavioural tests do not exercise.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Every .ts/.tsx file under `dir`, recursively (no node_modules under app/ or lib/). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(ROOT, dir));
  return out;
}

describe("(a) the retention cron has no tenant purge rule", () => {
  const src = read("app/api/cron/retention/route.ts");

  it("no rule in the rule list is named after a tenant or a purge", () => {
    const names = [...src.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
    // Since 6 Nov 2026 nothing of a club's is deleted automatically: the only rule left is the rate-limit counters.
    expect(names).toEqual(["rateLimitHit"]);
    expect(names.filter((n) => /tenant|purge/i.test(n))).toEqual([]);
  });

  it("the route does not import lib/tenant-purge at all", () => {
    expect(src).not.toMatch(/from\s+"@\/lib\/tenant-purge"/);
  });
});

describe("(e) the by-age bulk purge is gone and the explicit path is not reachable from any cron", () => {
  it("purgeSoftDeletedTenants does not exist anywhere under app/ or lib/", () => {
    const hits = [...sourceFiles("app"), ...sourceFiles("lib")].filter((f) => fs.readFileSync(f, "utf8").includes("purgeSoftDeletedTenants"));
    expect(hits.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("purgeTenantById is neither imported nor called by any file under app/api/cron", () => {
    // A comment may point at it (the retention route does); an import or a call may not.
    const hits = sourceFiles("app/api/cron").filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      return /import[^;]*\bpurgeTenantById\b/.test(src) || /\bpurgeTenantById\s*\(/.test(src);
    });
    expect(hits.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("purgeTenantById still exists (the explicit-erasure path is kept, not deleted)", () => {
    expect(read("lib/tenant-purge.ts")).toMatch(/export async function purgeTenantById\(/);
  });

  it("the recovery window is gone from the lifecycle module", () => {
    const lifecycle = read("lib/tenant-lifecycle.ts");
    expect(lifecycle).not.toMatch(/TENANT_SOFT_DELETE_GRACE_MS|softDeleteCutoff|window-expired/);
  });

  it("the soft-delete route no longer promises a hard-delete date", () => {
    expect(read("app/api/admin/customers/[id]/soft-delete/route.ts")).not.toMatch(/hardDeleteAfter/);
  });
});
