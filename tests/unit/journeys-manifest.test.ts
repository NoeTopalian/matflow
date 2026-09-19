// The journey manifest is the spine of the break-the-system loop (plan PART X-12
// §4.1): every API route file must be claimed by at least one journey, every
// journey must name at least one route, and ids must be unique. A route nobody
// claims is a cell nobody drives.
import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { JOURNEYS, ROLES, apiPaths, cellsFor } from "../e2e/campaign/assess/journeys";

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

describe("journey manifest", () => {
  it("has unique ids and at least one route per journey", () => {
    const ids = JOURNEYS.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const j of JOURNEYS) expect(j.routes.length, j.id).toBeGreaterThan(0);
  });

  it("claims every app/api route file", () => {
    const root = join(process.cwd(), "app", "api");
    const files = routeFiles(root).map((p) => relative(root, p).replace(/\\/g, "/").replace(/\/route\.ts$/, ""));
    const claimed = new Set(apiPaths());
    const unclaimed = files.filter((f) => !claimed.has(f)).sort();
    expect(unclaimed, `routes no journey names: ${unclaimed.join(", ")}`).toEqual([]);
  });

  it("names only routes that exist", () => {
    const root = join(process.cwd(), "app", "api");
    const files = new Set(routeFiles(root).map((p) => relative(root, p).replace(/\\/g, "/").replace(/\/route\.ts$/, "")));
    const ghosts = apiPaths().filter((p) => !files.has(p));
    expect(ghosts, `routes named but absent: ${ghosts.join(", ")}`).toEqual([]);
  });

  it("gives every journey a cell for every role, and the primary role is allowed", () => {
    for (const j of JOURNEYS) {
      const cells = cellsFor(j);
      expect(cells.length).toBe(ROLES.length);
      expect(j.allowed, `${j.id} primary role`).toContain(j.primaryRole);
    }
  });
});
