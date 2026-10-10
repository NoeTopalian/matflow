/**
 * SF-130 — every checkRateLimit call site starts its bucket with a LITERAL family (security campaign iteration 2,
 * lane M2, 10 Oct 2026; authorised by Noe 10 Oct 23:29 Italy).
 *
 * SF-120 made lib/rate-limit.ts log the bucket's family (the text before the first ':') and never the rest, because
 * the rest is an e-mail address, an IP, a user id or a token hash. That is only safe while every caller puts a fixed
 * family first: a bucket built as `${email}:forgot` would make the address the "family" and put it straight back in
 * the over-limit log. R8 counted 82 call sites, all literal, with nothing pinning it. This test parses every non-test
 * source file with the TypeScript compiler and requires the first argument of every checkRateLimit call to be one of:
 *   - a string or template literal whose fixed head starts `<family>:` (family = [A-Za-z0-9][A-Za-z0-9._-]*);
 *   - a `"<family>:" + …` concatenation whose leftmost operand is such a literal;
 *   - an identifier bound by `const` in the same file to one of the above (a documented constant), or listed in
 *     DOCUMENTED_CONSTANTS below with the reason (none today).
 * A planted-call control proves the checker rejects the shapes it must reject.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", "tests", "docs", "public", "test-results", "playwright-report"]);
const FAMILY_HEAD = /^[A-Za-z0-9][A-Za-z0-9._-]*:/;
/** Imported or cross-file constants accepted as a family, with why. Empty: every call site is literal today. */
const DOCUMENTED_CONSTANTS: Record<string, string> = {};

type Site = { file: string; line: number; ok: boolean; family: string | null; shape: string; text: string };

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name) || e.name.startsWith("playwright-mcp-")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function familyOf(expr: ts.Expression, sf: ts.SourceFile, depth = 0): { family: string | null; shape: string } {
  if (ts.isParenthesizedExpression(expr)) return familyOf(expr.expression, sf, depth);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    const m = FAMILY_HEAD.exec(expr.text);
    return { family: m ? m[0].slice(0, -1) : null, shape: "literal" };
  }
  if (ts.isTemplateExpression(expr)) {
    const m = FAMILY_HEAD.exec(expr.head.text);
    return { family: m ? m[0].slice(0, -1) : null, shape: "template" };
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    let left: ts.Expression = expr;
    while (ts.isBinaryExpression(left) && left.operatorToken.kind === ts.SyntaxKind.PlusToken) left = left.left;
    if (ts.isStringLiteral(left) || ts.isNoSubstitutionTemplateLiteral(left) || ts.isTemplateExpression(left)) {
      return { ...familyOf(left, sf, depth), shape: "concatenation" };
    }
    return { family: null, shape: "concatenation-non-literal-left" };
  }
  if (ts.isIdentifier(expr)) {
    const name = expr.text;
    if (DOCUMENTED_CONSTANTS[name]) return { family: name, shape: "documented-constant" };
    if (depth > 0) return { family: null, shape: `identifier:${name}` };
    const decls: ts.VariableDeclaration[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) decls.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (decls.length === 0) return { family: null, shape: `identifier-unresolved:${name}` };
    const fams = decls.map((d) => {
      const isConst = ts.isVariableDeclarationList(d.parent) && (d.parent.flags & ts.NodeFlags.Const) !== 0;
      return isConst && d.initializer ? familyOf(d.initializer, sf, depth + 1).family : null;
    });
    const fam = fams.every((f) => f !== null) ? fams[0] : null;
    return { family: fam, shape: `const:${name}` };
  }
  return { family: null, shape: ts.SyntaxKind[expr.kind] };
}

function isCheckRateLimitCall(n: ts.Node): n is ts.CallExpression {
  if (!ts.isCallExpression(n)) return false;
  const c = n.expression;
  return (ts.isIdentifier(c) && c.text === "checkRateLimit") || (ts.isPropertyAccessExpression(c) && c.name.text === "checkRateLimit");
}

function scanSource(file: string, text: string): Site[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".ts") || file.endsWith(".mts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const sites: Site[] = [];
  const visit = (n: ts.Node) => {
    if (isCheckRateLimitCall(n)) {
      const arg = n.arguments[0];
      const { family, shape } = arg ? familyOf(arg, sf) : { family: null, shape: "no-argument" };
      sites.push({
        file,
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        ok: family !== null,
        family,
        shape,
        text: arg ? arg.getText(sf).slice(0, 60) : "",
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

describe("SF-130: every checkRateLimit bucket starts with a literal family", () => {
  const files = sourceFiles(ROOT);
  const sites = files.flatMap((f) => scanSource(path.relative(ROOT, f).split(path.sep).join("/"), fs.readFileSync(f, "utf8")));

  it("finds at least the 82 call sites R8 counted (the scanner is not silently blind)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(82);
    if (process.env.SECM2_EVIDENCE_DIR) {
      fs.writeFileSync(
        path.join(process.env.SECM2_EVIDENCE_DIR, "sf130-callsites.jsonl"),
        sites.map((s) => JSON.stringify({ file: s.file, line: s.line, shape: s.shape, family: s.family, ok: s.ok })).join("\n") + "\n",
      );
    }
  });

  it("every call site's bucket has a literal family", () => {
    const bad = sites.filter((s) => !s.ok).map((s) => `${s.file}:${s.line} ${s.shape} ${s.text}`);
    expect(bad).toEqual([]);
  });

  it("planted-call control: the checker rejects every unsafe shape and accepts the safe ones", () => {
    const planted = [
      "declare const email: string, ip: string, id: string, x: any;",
      "checkRateLimit(email, 5, 60_000);", // bare key
      "checkRateLimit(`${email}:forgot`, 5, 60_000);", // key first
      "checkRateLimit(`:${ip}`, 5, 60_000);", // empty family
      "checkRateLimit(email + ':forgot', 5, 60_000);", // concatenation, key first
      "checkRateLimit(`forgot${email}`, 5, 60_000);", // no separator
      "let b = `login:${ip}`; checkRateLimit(b, 5, 60_000);", // not const
      "checkRateLimit(param(), 5, 60_000);", // call result
      "x.checkRateLimit(email, 5, 60_000);", // member call
      "checkRateLimit(`${email}`, 5, 60_000);",
      // Safe shapes:
      "checkRateLimit(`forgot:${email}`, 5, 60_000);",
      "checkRateLimit('login:' + ip, 5, 60_000);",
      "checkRateLimit(\"apply:global\", 5, 60_000);",
      "const k = `reset-attempt:${id}`; checkRateLimit(k, 5, 60_000);",
      "x.checkRateLimit(`kiosk.lookup:${id}`, 5, 60_000);",
    ].join("\n");
    const found = scanSource("planted.ts", planted);
    expect(found).toHaveLength(14);
    expect(found.filter((s) => !s.ok)).toHaveLength(9);
    expect(found.filter((s) => s.ok).map((s) => s.family)).toEqual(["forgot", "login", "apply", "reset-attempt", "kiosk.lookup"]);
  });
});
