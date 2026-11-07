/**
 * A promotion photo replaced by a newer one is kept (row and file) and marked `replacedAt`
 * (app/api/members/[id]/rank, 6 Nov 2026). Every place that LISTS a member's photos must hide it.
 * Source ratchet: each listing query filters `replacedAt: null`. The erasure, the export, the
 * member and child deletes and the club erasure deliberately still reach replaced photos.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const LISTS = [
  "app/api/members/[id]/photos/route.ts",
  "app/api/member/children/[id]/photos/route.ts",
  "app/member/family/[childId]/page.tsx",
];

describe("replaced promotion photos are hidden wherever photos are listed", () => {
  it.each(LISTS)("%s lists only photos that were not replaced", (file) => {
    const src = read(file);
    const listing = src.match(/memberPhoto\.findMany\(\{[\s\S]*?where:\s*\{([^}]*)\}/);
    expect(listing, "a memberPhoto.findMany listing").not.toBeNull();
    expect(listing![1]).toMatch(/replacedAt:\s*null/);
  });

  it("replacing a promotion photo marks the old rows instead of deleting them", () => {
    const src = read("app/api/members/[id]/rank/route.ts");
    expect(src).toMatch(/memberPhoto\.updateMany\(\{[\s\S]*?kind: "promotion", replacedAt: null[\s\S]*?data: \{ replacedAt: new Date\(\) \}/);
    expect(src).not.toMatch(/memberPhoto\.deleteMany/);
  });

  it("the erasure still finds every photo of the member, replaced ones included", () => {
    const src = read("app/api/admin/dsar/erase/route.ts");
    expect(src).toMatch(/memberPhoto\.findMany\(\{\s*where: \{ memberId, tenantId \}/);
  });
});
