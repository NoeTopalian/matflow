import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Admin hub AH-09 (9 Oct 2026): `npm audit` showed a critical chain
 * (proxy-addr, ip-address, express, ts-morph, fast-glob…) reaching the tree
 * only through the `shadcn` CLI, which was listed as a production dependency
 * although nothing imports it at runtime. It is a code generator, so it
 * belongs in devDependencies; the audit of what actually ships (`--omit=dev`)
 * must not carry it.
 */
describe("production dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it("the shadcn CLI is a dev dependency, not a runtime one", () => {
    expect(pkg.dependencies.shadcn).toBeUndefined();
    expect(pkg.devDependencies.shadcn).toBeDefined();
  });

  it("nothing in the app imports the shadcn package", () => {
    // The generated components live in components/ui and import radix /
    // class-variance-authority directly; the CLI itself is never imported.
    let out = "";
    try {
      out = execFileSync("git", ["grep", "-l", "from \"shadcn", "--", "app", "components", "lib"], { encoding: "utf8" });
    } catch (e) {
      // git grep exits 1 when nothing matches
      out = (e as { stdout?: string }).stdout ?? "";
    }
    expect(out.trim()).toBe("");
  });
});
