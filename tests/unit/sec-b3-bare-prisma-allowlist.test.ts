// SF-87 (lane B3, 10 Oct 2026): every `prisma.<model>.<method>(…)` call made on the singleton OUTSIDE
// withTenantContext / withRlsBypass runs on whatever pooled server connection it lands on. B3 measured on the
// TEST pooler that a session-level app.* setting left by an idle client reaches a later client's plain query
// on that connection, while withTenantContext holds. Today no bare call touches a tenant table; this test pins
// that so a future bare call on an RLS-protected model fails CI instead of silently serving another club.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
// Models WITHOUT a tenantId and WITHOUT an RLS policy (B3 01-inventory.md): the only models a bare call may touch.
const ALLOWED_MODELS = new Set(["operator", "rateLimitHit", "platformConfig"]);
const METHODS = "findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy";
const CALL = new RegExp(`\\bprisma\\.([a-zA-Z]+)\\.(?:${METHODS})\\s*(?:<[^>]*>)?\\(`, "g");

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
}

function stripComments(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function bareCalls() {
  const files: string[] = [];
  for (const d of ["app", "lib"]) walk(join(ROOT, d), files);
  for (const f of ["auth.ts", "proxy.ts"]) files.push(join(ROOT, f));
  const hits: Array<{ file: string; model: string; line: number }> = [];
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"));
    let m: RegExpExecArray | null;
    CALL.lastIndex = 0;
    while ((m = CALL.exec(src))) {
      const line = src.slice(0, m.index).split("\n").length;
      hits.push({ file: relative(ROOT, f).replace(/\\/g, "/"), model: m[1], line });
    }
  }
  return hits;
}

describe("SF-87: bare prisma.<model> calls stay on non-RLS platform tables", () => {
  const hits = bareCalls();
  it("finds the bare calls the inventory counted (control: the scan is not empty)", () => {
    expect(hits.length).toBeGreaterThanOrEqual(20);
  });
  it("every bare call targets a model without tenant rows or an RLS policy", () => {
    const offenders = hits.filter((h) => !ALLOWED_MODELS.has(h.model)).map((h) => `${h.file}:${h.line} prisma.${h.model}`);
    expect(offenders).toEqual([]);
  });
  it("control: a bare call on a tenant model would be reported", () => {
    const planted = "const x = prisma.member.findMany({ where: { id } });";
    CALL.lastIndex = 0;
    const m = CALL.exec(planted);
    expect(m && m[1]).toBe("member");
    expect(ALLOWED_MODELS.has("member")).toBe(false);
  });
});
