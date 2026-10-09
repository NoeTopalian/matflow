// Lane C2 (9 Oct 2026): query-string boundary inventory for every app/api/**/route.ts.
// Lists each searchParams.get("<name>") / params read, and whether the route validates
// the query through zod (a safeParse/parse whose argument mentions searchParams or one
// of the read names, or a z.* schema that names the key). A map for reviewers, not a
// proof — read the route before relying on a row.
//   node docs/security/evidence/C2/scripts/query-inventory.mjs <repoRoot> [--md <out>]
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] ?? ".";
const mdIdx = process.argv.indexOf("--md");
const mdOut = mdIdx > 0 ? process.argv[mdIdx + 1] : null;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "route.ts") out.push(p);
  }
  return out;
}

const rows = [];
for (const file of walk(path.join(root, "app", "api"))) {
  const src = fs.readFileSync(file, "utf8");
  const names = new Set();
  for (const m of src.matchAll(/searchParams\.get(?:All)?\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) names.add(m[1]);
  if (names.size === 0) continue;
  const zodOnQuery =
    /(safeParse|parse)\(\s*Object\.fromEntries\([^)]*searchParams/.test(src) ||
    /(safeParse|parse)\(\s*\{[^}]*searchParams\.get/.test(src);
  const perName = [...names].map((n) => {
    const inSchema = new RegExp(`\\b${n.replace(/[^a-zA-Z0-9_]/g, "")}\\s*:\\s*z\\.`).test(src);
    const shapeChecked =
      new RegExp(`${n}[^\\n]{0,80}(\\.test\\(|Number\\.isFinite|parseInt|Number\\(|includes\\(|===|!==|isValid|safeParse)`).test(src) ||
      new RegExp(`(\\.test\\(|includes\\()[^\\n]{0,40}${n}`).test(src);
    return { n, inSchema, shapeChecked };
  });
  const rel = path.relative(root, file).replace(/\\/g, "/").replace(/^app/, "").replace(/\/route\.ts$/, "");
  const methods = [...src.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)/g)].map((m) => m[1]);
  rows.push({
    route: rel,
    methods: [...new Set(methods)].join(" "),
    params: perName.map((p) => p.n).join(", "),
    zod: zodOnQuery || perName.every((p) => p.inSchema) ? "yes" : perName.some((p) => p.inSchema) ? "partial" : "no",
    unchecked: perName.filter((p) => !p.inSchema && !p.shapeChecked).map((p) => p.n).join(", "),
  });
}
rows.sort((a, b) => a.route.localeCompare(b.route));
const total = rows.length;
const noZod = rows.filter((r) => r.zod !== "yes");
console.log(`routes reading query params: ${total}; without full zod validation: ${noZod.length}; with a param that has no visible shape check: ${rows.filter((r) => r.unchecked).length}`);
if (mdOut) {
  const lines = [
    "| Route | Methods | Query params read | zod | Params with no visible shape check |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| \`${r.route}\` | ${r.methods} | ${r.params} | ${r.zod} | ${r.unchecked} |`),
  ];
  fs.writeFileSync(mdOut, lines.join("\n") + "\n");
}
