/**
 * Security campaign lane E (9 Oct 2026): supply-chain policy (SEC-057..SEC-060).
 * Synthetic cases prove each rule fires; the repository cases hold the real tree to the policy.
 * Evidence: docs/security/evidence/E/E-02-mysql2-prisma.md, E-03-native-inventory.md.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_REGISTRY,
  AUDIT_EXCEPTIONS,
  BUILD_CHAIN_ONLY,
  analyseLockfile,
  forbiddenImports,
  manifestViolations,
  shippedSourceFiles,
  unexcepted,
} from "../../scripts/readiness/supply-chain-check.mjs";

const ROOT = path.resolve(__dirname, "../..");
const sha = "sha512-" + "A".repeat(86) + "==";
const entry = (name: string, extra: Record<string, unknown> = {}) => ({
  version: "1.0.0",
  resolved: `${ALLOWED_REGISTRY}${name}/-/${name}-1.0.0.tgz`,
  integrity: sha,
  ...extra,
});

describe("analyseLockfile — synthetic", () => {
  it("accepts a clean registry-only lockfile (positive control)", () => {
    const r = analyseLockfile({ lockfileVersion: 3, packages: { "": {}, "node_modules/a": entry("a") } });
    expect(r.violations).toEqual([]);
    expect(r.entries).toBe(1);
  });

  it("flags a tarball from another host (dependency confusion / mirror swap)", () => {
    const r = analyseLockfile({
      lockfileVersion: 3,
      packages: { "": {}, "node_modules/a": entry("a", { resolved: "https://evil.example/a-1.0.0.tgz" }) },
    });
    expect(r.violations.join("\n")).toMatch(/resolved outside/);
  });

  it("flags git and file dependencies", () => {
    const r = analyseLockfile({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/g": entry("g", { resolved: "git+ssh://git@github.com/x/g.git#abc" }),
        "node_modules/l": { link: true, resolved: "../local" },
      },
    });
    expect(r.violations.some((v: string) => v.includes("node_modules/g"))).toBe(true);
    expect(r.violations.some((v: string) => v.includes("linked"))).toBe(true);
  });

  it("flags missing and non-sha512 integrity", () => {
    const r = analyseLockfile({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/a": entry("a", { integrity: undefined }),
        "node_modules/b": entry("b", { integrity: "sha1-abc=" }),
      },
    });
    expect(r.violations.join("\n")).toMatch(/no integrity/);
    expect(r.violations.join("\n")).toMatch(/not sha512/);
  });

  it("flags an install script outside the reviewed allowlist, and accepts an allowlisted one", () => {
    const r = analyseLockfile({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/prisma": entry("prisma", { hasInstallScript: true }),
        "node_modules/new-native-thing": entry("new-native-thing", { hasInstallScript: true }),
      },
    });
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatch(/new-native-thing: install script not on the reviewed allowlist/);
  });
});

describe("forbiddenImports — synthetic", () => {
  it("catches static, dynamic and require imports of build-chain-only packages", () => {
    const hits = forbiddenImports({
      "lib/a.ts": 'import mysql from "mysql2/promise";',
      "lib/b.ts": 'const m = await import("mysql2");',
      "lib/c.ts": 'const p = require("prisma");',
      "lib/d.ts": 'import { x } from "shadcn/registry";',
      "lib/e.ts": 'import "@prisma/studio-core/data";',
    });
    expect(hits).toHaveLength(5);
  });

  it("does not flag the runtime Prisma client or adapter (positive control)", () => {
    const hits = forbiddenImports({
      "lib/prisma.ts": 'import { PrismaClient } from "@prisma/client";\nimport { PrismaPg } from "@prisma/adapter-pg";\nimport pg from "pg";',
    });
    expect(hits).toEqual([]);
  });
});

describe("unexcepted — advisory exceptions expire", () => {
  const audit = {
    vulnerabilities: {
      mysql2: { via: [{ severity: "high", url: "https://github.com/advisories/GHSA-3f6p-5ww8-9rcr", range: "<3.22.0" }] },
      other: { via: [{ severity: "critical", url: "https://github.com/advisories/GHSA-xxxx-yyyy-zzzz", range: "*" }] },
    },
  };
  it("an unexcepted critical always fails", () => {
    expect(unexcepted(audit, AUDIT_EXCEPTIONS, "2026-10-09")).toEqual(["other GHSA-xxxx-yyyy-zzzz critical *"]);
  });
  it("a live exception suppresses only its own advisory", () => {
    expect(unexcepted(audit, AUDIT_EXCEPTIONS, "2026-10-09")).not.toContain(expect.stringMatching(/mysql2/));
  });
  it("the exception lapses after its expiry date", () => {
    expect(unexcepted(audit, AUDIT_EXCEPTIONS, "2026-11-10").some((s: string) => s.startsWith("mysql2"))).toBe(true);
  });
});

describe("repository policy (real lockfile and source)", () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  it("every lockfile entry is registry.npmjs.org + sha512, install scripts only from the reviewed allowlist", () => {
    const r = analyseLockfile(lock);
    expect(r.violations).toEqual([]);
    expect(Object.keys(r.hosts)).toEqual([ALLOWED_REGISTRY]);
  });

  it("shipped code never imports a build-chain-only package (mysql2, prisma CLI, shadcn …)", () => {
    const files = shippedSourceFiles(ROOT);
    expect(Object.keys(files).length).toBeGreaterThan(300);
    expect(forbiddenImports(files)).toEqual([]);
    expect(BUILD_CHAIN_ONLY).toContain("mysql2");
  });

  it("shadcn stays a devDependency", () => {
    expect(manifestViolations(pkg)).toEqual([]);
    expect(pkg.devDependencies.shadcn).toBeTruthy();
  });

  it("an installed mysql2 below the fixed version (3.23.1) is only tolerated under a live exception", () => {
    const v: string = lock.packages["node_modules/mysql2"]?.version ?? "0.0.0";
    const [maj, min, pat] = v.split(".").map(Number);
    const fixed = maj > 3 || (maj === 3 && (min > 23 || (min === 23 && pat >= 1)));
    if (!fixed) {
      const today = new Date().toISOString().slice(0, 10);
      const live = AUDIT_EXCEPTIONS.filter((e: { pkg: string; expires: string }) => e.pkg === "mysql2" && e.expires >= today);
      // Fails on 2026-11-10 unless the override in ADV-01 lands or the decision is renewed with a new date.
      expect(live.length).toBe(2);
    }
  });
});
