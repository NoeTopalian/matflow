// Lane C body-boundary inventory: classifies every app/api route.ts that reads a request body.
// Usage: node body-inventory.cjs <repoRoot> [--md out.md] [--json out.json]
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
const ts = require(path.join(root, "node_modules/typescript"));
const SENSITIVE = /^(role|roles|tenantId|tenant|tenantSlug|ownerId|userId|operatorId|isOperator|isAdmin|admin|passwordHash|password|newPassword|currentPassword|totpSecret|totpEnabled|totpRecoveryCodes|recoveryCodes|mfa\w*|emailVerified|emailVerifiedAt|loginEmailProvisionalSince|sessionVersion|noLogin|hasLogin|erasedAt|deletedAt|suspendedAt|status|accountType|stripeCustomerId|stripeAccountId|stripeSubscriptionId|subscriptionStatus|paymentStatus|plan|email|loginEmail|contactEmail|guardian\w*|parentMemberId|memberId|createdById|verified\w*|isVerified)$/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "route.ts") out.push(p);
  }
  return out;
}

const rows = [];
for (const file of walk(path.join(root, "app/api")).sort()) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(root, file).replace(/\\/g, "/");
  const reads = { json: /\.json\(\s*\)/.test(src), form: /\.formData\(\s*\)/.test(src), text: /\.text\(\s*\)/.test(src) };
  if (!reads.json && !reads.form && !reads.text) continue;
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
  const methods = [];
  const objectKeys = new Set();
  const sensitiveKeys = new Set();
  let strictObjects = 0, plainObjects = 0, loose = [];
  const parseCalls = [];
  const spreads = [];
  function visit(n) {
    if (ts.isFunctionDeclaration(n) && n.name && /^(GET|POST|PUT|PATCH|DELETE)$/.test(n.name.text) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) methods.push(n.name.text);
    if (ts.isVariableStatement(n) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name) && /^(GET|POST|PUT|PATCH|DELETE)$/.test(d.name.text)) methods.push(d.name.text);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const name = n.expression.name.text;
      if ((name === "object" || name === "strictObject" || name === "looseObject") && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
        if (name === "strictObject") strictObjects++; else if (name === "looseObject") loose.push("looseObject"); else plainObjects++;
        for (const p of n.arguments[0].properties) {
          const k = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
          if (k) { objectKeys.add(k); if (SENSITIVE.test(k)) sensitiveKeys.add(k); }
        }
      }
      if (name === "passthrough" || name === "catchall") loose.push(name);
      if (name === "record") loose.push("record");
      if (name === "strict") strictObjects++;
      if (name === "safeParse" || name === "parse" || name === "parseAsync" || name === "safeParseAsync") parseCalls.push(n.expression.expression.getText(sf));
    }
    if (ts.isSpreadAssignment(n)) spreads.push(n.expression.getText(sf));
    ts.forEachChild(n, visit);
  }
  visit(sf);
  const importsSchemas = [...src.matchAll(/import\s+\{([^}]*)\}\s+from\s+"(@\/lib\/[^"]*)"/g)]
    .filter((m) => /schema|Schema|Field/.test(m[1]))
    .map((m) => `${m[1].trim().replace(/\s+/g, " ")} <- ${m[2]}`);
  // raw-body use: body read then property access without any parse call
  const rawBodyAccess = parseCalls.length === 0 && reads.json;
  // write sinks touching a spread of parsed data
  const dataSpread = /data:\s*(parsed\.data|body|input|result\.data)\b|data:\s*\{[^}]*\.\.\.(parsed\.data|body|rest|input)\b|\{\s*\.\.\.rest\s*\}/.test(src);
  rows.push({ route: rel.replace(/^app/, "").replace(/\/route\.ts$/, ""), methods: [...new Set(methods)], reads, parse: [...new Set(parseCalls)], strictObjects, plainObjects, loose: [...new Set(loose)], sensitiveKeys: [...sensitiveKeys], importsSchemas, rawBodyAccess, dataSpread });
}
const args = process.argv.slice(3);
const jsonOut = args[args.indexOf("--json") + 1];
if (args.includes("--json")) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
if (args.includes("--md")) {
  const md = ["| Route | Methods | Body | Parse | z.object (strip) / strict | Loose | Sensitive keys accepted | Spread into write | Imported schemas |", "|---|---|---|---|---|---|---|---|---|"];
  for (const r of rows) md.push(`| \`${r.route}\` | ${r.methods.join(" ")} | ${Object.entries(r.reads).filter(([, v]) => v).map(([k]) => k).join("+")} | ${r.parse.join(", ") || "**none**"} | ${r.plainObjects}/${r.strictObjects} | ${r.loose.join(",")} | ${r.sensitiveKeys.join(", ")} | ${r.dataSpread ? "yes" : ""} | ${r.importsSchemas.join("; ")} |`);
  fs.writeFileSync(args[args.indexOf("--md") + 1], md.join("\n") + "\n");
}
console.log("routes reading a body:", rows.length);
console.log("json:", rows.filter((r) => r.reads.json).length, "form:", rows.filter((r) => r.reads.form).length, "text:", rows.filter((r) => r.reads.text).length);
console.log("json routes with NO zod parse call:", rows.filter((r) => r.rawBodyAccess).map((r) => r.route).join("\n  "));
console.log("loose:", rows.filter((r) => r.loose.length).map((r) => r.route + " " + r.loose).join("\n  "));
console.log("strict:", rows.filter((r) => r.strictObjects).map((r) => r.route).join(", "));
console.log("dataSpread:", rows.filter((r) => r.dataSpread).map((r) => r.route).join(", "));
console.log("sensitive:\n  " + rows.filter((r) => r.sensitiveKeys.length).map((r) => r.route + ": " + r.sensitiveKeys.join(",")).join("\n  "));
