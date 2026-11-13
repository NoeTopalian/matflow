// Club-managed class categories (Release B): management is switched off server-side, on every mutation route.
// Hiding the Categories button is not the control; each write handler must refuse first. The DB suite proves the
// behaviour (class-categories-b-db "switched off"); this guard stops a new handler or route from skipping the check.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "app", "api", "class-categories");
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : []));

describe("category management: the switch is checked in every mutation handler", () => {
  const routes = files(ROOT);
  it("finds the three route files", () => {
    expect(routes.map((f) => path.relative(ROOT, f).replace(/\\/g, "/")).sort()).toEqual(["[id]/route.ts", "order/route.ts", "route.ts"]);
  });
  for (const file of routes) {
    const src = fs.readFileSync(file, "utf8");
    const handlers = [...src.matchAll(/export async function (POST|PUT|PATCH|DELETE)\b/g)];
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    it(`${rel}: has a mutation handler`, () => {
      expect(handlers.length).toBeGreaterThan(0);
    });
    for (const h of handlers) {
      const start = h.index ?? 0;
      const next = src.indexOf("export async function", start + 1);
      const body = src.slice(start, next < 0 ? undefined : next);
      it(`${rel} ${h[1]}: refuses while the switch is off, before any database work`, () => {
        const guard = body.indexOf("if (!categoryManagementEnabled())");
        expect(guard, "no switch check").toBeGreaterThan(-1);
        for (const write of ["withTenantContext(", "prisma.", "$queryRaw", "$executeRaw"]) {
          const at = body.indexOf(write);
          if (at >= 0) expect(guard, `${write} before the switch check`).toBeLessThan(at);
        }
        expect(body.slice(guard, guard + 200)).toMatch(/status: 404/);
      });
    }
  }
});
