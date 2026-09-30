// The nightly retention cron hard-deletes a club 30 days after it was
// soft-deleted (`purgeTenant` in app/api/cron/retention/route.ts). Every table
// whose foreign key to Tenant is ON DELETE RESTRICT (Prisma's default) must be
// emptied first, or `tx.tenant.delete` fails and the erasure silently never
// happens.
//
// The Location table (migration 20260925000000) was added without a purge step
// and broke this for every club, and the existing retention tests mock
// `tenant.delete`, so nothing noticed. This test reads the schema itself: any new
// model with a tenant relation must be purged explicitly or listed below with
// the reason it goes some other way.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const schema = fs.readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");
const route = fs.readFileSync(path.join(process.cwd(), "app/api/cron/retention/route.ts"), "utf8");

// Tables removed through a required parent that is itself purged.
const REMOVED_VIA_PARENT: Record<string, string> = {
  MemberStatusEvent: "memberId is required and ON DELETE CASCADE from Member (step 2)",
};

function tenantModels(): Array<{ name: string; cascades: boolean }> {
  const out: Array<{ name: string; cascades: boolean }> = [];
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [, name, body] = m;
    if (name === "Tenant") continue;
    const rel = body.match(/^\s+\w+\s+Tenant\??\s+@relation\(([^)]*)\)/m);
    if (!rel) continue;
    out.push({ name, cascades: /onDelete:\s*Cascade/.test(rel[1]) });
  }
  return out;
}

describe("retention purge covers every table that blocks a Tenant delete", () => {
  it("finds the tenant-related models (sanity)", () => {
    const names = tenantModels().map((m) => m.name);
    expect(names).toContain("Member");
    expect(names).toContain("Location");
  });

  it.each(tenantModels().filter((m) => !m.cascades).map((m) => m.name))(
    "%s is purged before the tenant row",
    (name) => {
      if (REMOVED_VIA_PARENT[name]) return;
      const accessor = `tx.${name[0].toLowerCase()}${name.slice(1)}`;
      expect(route.includes(accessor), `${name}: add a purge step in purgeTenant, or document it in REMOVED_VIA_PARENT`).toBe(true);
    },
  );

  it("purges Location after classes and tiers, before the tenant row", () => {
    const loc = route.indexOf(`["location"`);
    expect(loc).toBeGreaterThan(route.indexOf(`["membershipTier"`));
    expect(loc).toBeGreaterThan(route.indexOf("tx.class.deleteMany"));
    expect(loc).toBeLessThan(route.indexOf("tx.tenant.delete"));
  });
});
