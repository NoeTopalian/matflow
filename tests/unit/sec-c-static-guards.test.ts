// Security campaign lane C — code-level guards for SEC-033 (SQL/ORM injection),
// SEC-034 (command injection), SEC-037 (unsafe deserialisation), SEC-040 (XML
// parsers), SEC-038 (file resolution) and SEC-047 (shared server caches).
//
// These are inventories turned into tests: each pins today's reviewed shape of
// the RUNTIME code (app/, lib/, components/, auth.ts, proxy.ts) so a change that
// introduces a new raw-SQL string, a process spawn, an eval, an XML parser, a
// filesystem read or a tenant-blind cache key fails here and is reviewed.
// Each has a positive control proving the matcher sees the bad shape.
// Scripts under scripts/ are build/operator tooling and are reviewed in the
// lane C report, not here.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) files(rel, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(rel);
  }
  return out;
}
const RUNTIME = [...files("app"), ...files("lib"), ...files("components"), "auth.ts", "proxy.ts"].filter((f) => fs.existsSync(path.join(ROOT, f)));
/** Source with comments removed, so prose about a pattern is not the pattern. */
const code = (f: string) =>
  fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const hits = (re: RegExp) => RUNTIME.filter((f) => re.test(code(f)));

describe("SEC-033 raw SQL is parameterised", () => {
  const UNSAFE = /\$(queryRawUnsafe|executeRawUnsafe)\b|Prisma\.raw\(|\bsql\.raw\(/;
  it("positive control", () => {
    expect(UNSAFE.test("await tx.$queryRawUnsafe(`SELECT ${x}`)")).toBe(true);
  });
  it("no $queryRawUnsafe / $executeRawUnsafe / Prisma.raw in runtime code", () => {
    expect(hits(UNSAFE)).toEqual([]);
  });
  it("every $queryRaw/$executeRaw is a tagged template (never called with a built string)", () => {
    const called = /\$(queryRaw|executeRaw)\s*(<[^>`]*>)?\s*\(/;
    expect(called.test("tx.$queryRaw(Prisma.sql`x`)")).toBe(true); // control
    expect(hits(called)).toEqual([]);
  });
  it("the reviewed raw-SQL call sites are exactly these (values interpolated as bind parameters only)", () => {
    expect(hits(/\$(queryRaw|executeRaw)\s*(<[^`]*>)?\s*`/).sort()).toEqual([
      "app/api/admin/dsar/erase/route.ts", // lane D3: SELECT … FOR UPDATE re-read of the subject inside the erase transaction; ids are bind parameters
      "app/api/health/route.ts",
      "app/api/member/children/[id]/route.ts", // lane D3: locked read of the child row inside the deletion transaction; ids are bind parameters
      "app/api/member/class-subscriptions/[classId]/route.ts",
      "app/api/members/[id]/route.ts", // lane D3: locked read of the member + children inside the deletion transaction; ids are bind parameters
      "app/api/staff/[id]/route.ts", // lane D3: locked read of the user row inside the deletion transaction; ids are bind parameters
      "lib/attendance-import.ts", // release-digest read (lane D third pass): only tenantId is interpolated, as a bind parameter
      "lib/auth-lockout.ts", // lane A4 (R6-N1): failure-slot reservation, C3's advisory lock + conditional insert; buckets, ids, caps, window, exempt flag and lock namespace are bind parameters
      "lib/checkin.ts",
      "lib/login-email.ts",
      "lib/prisma-tenant.ts",
      "lib/rate-limit.ts", // lane C3: per-bucket advisory lock + conditional insert; bucket, window, id, max and the lock namespace are bind parameters
    ]);
  });
  it("no ORM query takes a computed key (orderBy/select/where built from a variable name)", () => {
    const computed = /(orderBy|select|where)\s*:\s*\{\s*\[[^\]]+\]\s*:/;
    expect(computed.test("orderBy: { [sort]: dir }")).toBe(true); // control
    expect(hits(computed)).toEqual([]);
  });
});

describe("SEC-034 / SEC-037 no process execution or code evaluation at runtime", () => {
  const EXEC = /from\s+["'](node:)?(child_process|vm|worker_threads)["']|require\(["'](node:)?(child_process|vm)["']\)|\beval\s*\(|new\s+Function\s*\(/;
  it("positive control", () => {
    expect(EXEC.test('import { execSync } from "node:child_process"')).toBe(true);
    expect(EXEC.test("const f = new Function('a', body)")).toBe(true);
  });
  it("none in runtime code", () => {
    expect(hits(EXEC)).toEqual([]);
  });
  it("no unsafe deserialiser or XML/archive parser is imported at runtime (SEC-037 / SEC-040)", () => {
    const PARSERS = /from\s+["'](node-serialize|serialize-javascript|js-yaml|yaml|superjson|devalue|xml2js|fast-xml-parser|@xmldom\/xmldom|xmldom|libxmljs2?|sax|xlsx|exceljs|jszip|adm-zip|yauzl|unzipper|tar|pdf-parse)["']|from\s+["'](node:)?v8["']/;
    expect(PARSERS.test('import { XMLParser } from "fast-xml-parser"')).toBe(true); // control
    expect(hits(PARSERS)).toEqual([]);
  });
  it("signed tokens are verified BEFORE their payload is JSON-parsed", () => {
    for (const f of ["lib/card-token.ts", "lib/kiosk-token.ts", "lib/impersonation.ts", "lib/operator-step-up.ts"]) {
      const src = code(f);
      const verify = src.search(/timingSafeEqual\(/);
      const parse = src.search(/JSON\.parse\(/);
      expect(verify, `${f} verifies`).toBeGreaterThan(-1);
      expect(parse, `${f} parses`).toBeGreaterThan(verify);
    }
  });
});

describe("SEC-038 filesystem resolution at runtime", () => {
  it("only lib/import-storage.ts touches the filesystem, and it confines names with path.basename", () => {
    const FS = /from\s+["'](node:)?fs(\/promises)?["']|require\(["'](node:)?fs["']\)/;
    expect(hits(FS)).toEqual(["lib/import-storage.ts"]);
    const src = code("lib/import-storage.ts");
    // Every read/unlink of a caller-supplied name goes through basename().
    for (const m of src.matchAll(/fs\.(readFile|unlink|rm)\(\s*path\.join\(LOCAL_DIR,\s*([a-zA-Z_]+)\)/g)) {
      expect(src).toMatch(new RegExp(`const ${m[2]} = path\\.basename\\(`));
    }
    // And local storage is unreachable in production.
    expect(src).toMatch(/VERCEL_ENV !== "production" && process\.env\.TESTING_MODE === "true"/);
  });
  it("Blob object names are server-built (tenant id from the session + random id)", () => {
    for (const f of hits(/\bput\(/)) {
      const src = code(f);
      for (const m of src.matchAll(/\bput\(\s*([^,]+),/g)) {
        expect(m[1], `${f}: ${m[1]}`).toMatch(/tenants\/\$\{tenantId\}|^filename$|^\s*$/);
      }
    }
  });
});

describe("SEC-047 shared server caches are keyed by tenant", () => {
  it("every unstable_cache key and tag carries the tenant id", () => {
    const sites = hits(/unstable_cache\(/);
    expect(sites.length).toBeGreaterThan(0);
    for (const f of sites) {
      const src = code(f);
      for (const m of src.matchAll(/unstable_cache\(([\s\S]*?)\)\(\)/g)) {
        expect(m[1], `${f} cache key`).toMatch(/tenantId/);
        expect(m[1], `${f} cache tag`).toMatch(/tags:\s*\[\s*`[a-z-]+-\$\{tenantId\}`/);
      }
    }
  });
  it("no 'use cache' / Cache Components / draftMode (the GHSA-3w37-wq28-93x7 surface)", () => {
    expect(hits(/["']use cache["']|draftMode\(/)).toEqual([]);
    expect(code("next.config.ts")).not.toMatch(/cacheComponents|useCache/);
  });
});
