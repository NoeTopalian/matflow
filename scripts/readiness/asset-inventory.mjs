#!/usr/bin/env node
/**
 * Asset inventory generator (security campaign lane E, 9 Oct 2026). Read-only; derives everything from the code.
 *
 *   node scripts/readiness/asset-inventory.mjs [--json <out>] [--markdown <out>]
 *
 * For every `app/** /route.ts` it records the URL pattern, exported HTTP methods and the guard markers found in the
 * file (the helpers it calls). It is a MAP for reviewers, not an authorization proof: a marker present in the file
 * does not prove every method or branch is guarded, and a route with no marker may be deliberately public. Lanes B/C
 * own the per-route authorization tests.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GUARDS = [
  ["operator", /getOperatorContext|verifyOperatorSession|requireOperator|withOperator|isAdminAuthed|checkOperatorSession|isAdminPageAuthed|resolveOperatorFromCookie/],
  ["stepUp", /requireStepUp/],
  ["owner", /requireApiOwner\b|requireOwner\b/],
  ["ownerOrManager", /requireApiOwnerOrManager|requireOwnerOrManager/],
  ["staff", /requireApiStaff|requireStaff\b/],
  ["role", /requireApiRole|requireRole\b/],
  ["session", /requireApiSession|requireSession\b|\bauth\(\)/],
  ["cronSecret", /CRON_SECRET/],
  ["stripeSignature", /constructEvent/],
  ["svixSignature", /svix|Webhook\(/],
  ["kioskToken", /verifyKioskMemberToken|kioskToken|kiosk_token/i],
  ["cardToken", /verifyCardToken/],
  ["magicLinkToken", /magic[-_]?link|MagicLink/],
  ["sameOrigin", /assertSameOrigin/],
  ["rateLimit", /checkRateLimit|rateLimit\(/],
  ["adminSecret", /MATFLOW_ADMIN_SECRET|checkAdminHeader|checkAdminCookie|sharedAdminSecretPermitted/],
];

export function routeUrl(rel) {
  return (
    "/" +
    rel
      .split(path.sep).join("/")
      .replace(/^app\//, "")
      .replace(/\/route\.tsx?$/, "")
      .replace(/(^|\/)\([^)]+\)/g, "")
  ).replace(/\/+/g, "/");
}

export function analyseRoute(src) {
  const methods = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]);
  // `export const { GET, POST } = handlers` and `export { GET, POST }`
  for (const m of src.matchAll(/export\s+(?:const\s*)?\{([^}]*)\}/g)) {
    for (const name of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop())) {
      if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name)) methods.push(name);
    }
  }
  const guards = GUARDS.filter(([, re]) => re.test(src)).map(([n]) => n);
  return {
    methods: [...new Set(methods)],
    guards,
    dynamic: /export const dynamic\s*=\s*["']force-dynamic/.test(src),
    runtimeEdge: /export const runtime\s*=\s*["']edge/.test(src),
    rawSql: /\$queryRaw|\$executeRaw/.test(src),
    usesSharp: /from ["']sharp["']/.test(src),
    usesBlob: /@vercel\/blob/.test(src),
    usesStripe: /from ["']stripe["']|lib\/stripe/.test(src),
    usesEmail: /lib\/email|resend/i.test(src),
    usesAnthropic: /@anthropic-ai\/sdk|lib\/ai|anthropic/i.test(src),
    usesGoogle: /googleapis|google-drive/.test(src),
  };
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export function classify(url) {
  if (url.startsWith("/api/admin")) return "operator";
  if (url.startsWith("/api/cron")) return "cron";
  if (url.startsWith("/api/webhooks") || url.startsWith("/api/stripe/webhook")) return "webhook";
  if (url.startsWith("/api/auth") || url.startsWith("/api/magic-link")) return "auth";
  if (url.startsWith("/api/kiosk") || url.startsWith("/api/checkin")) return "kiosk";
  if (url.startsWith("/api/member") && !url.startsWith("/api/members")) return "member";
  if (url === "/api/me" || url.startsWith("/api/me/")) return "self";
  if (url.startsWith("/api/health")) return "public-health";
  if (url.startsWith("/api/apply")) return "public-apply";
  if (url.startsWith("/api/")) return "staff/tenant";
  return "page";
}

function main() {
  const root = process.cwd();
  const files = walk(path.join(root, "app")).filter((f) => /[\\/]route\.tsx?$/.test(f));
  const pages = walk(path.join(root, "app")).filter((f) => /[\\/]page\.tsx?$/.test(f)).map((f) => routeUrl(path.relative(root, f).replace(/page\.tsx?$/, "route.ts")));
  const routes = files.map((f) => {
    const rel = path.relative(root, f);
    const url = routeUrl(rel);
    return { url, file: rel.split(path.sep).join("/"), area: classify(url), ...analyseRoute(fs.readFileSync(f, "utf8")) };
  }).sort((a, b) => a.url.localeCompare(b.url));
  const unguarded = routes.filter((r) => !r.guards.some((g) => !["sameOrigin", "rateLimit"].includes(g)));
  const summary = {
    routes: routes.length,
    pages: pages.length,
    byArea: routes.reduce((a, r) => ((a[r.area] = (a[r.area] || 0) + 1), a), {}),
    noIdentityMarker: unguarded.map((r) => r.url),
    rawSqlRoutes: routes.filter((r) => r.rawSql).map((r) => r.url),
    sharpRoutes: routes.filter((r) => r.usesSharp).map((r) => r.url),
  };
  const args = process.argv.slice(2);
  const j = args.indexOf("--json");
  if (j >= 0) fs.writeFileSync(args[j + 1], JSON.stringify({ generatedAt: new Date().toISOString(), summary, routes, pages }, null, 1));
  const m = args.indexOf("--markdown");
  if (m >= 0) {
    const lines = ["| Route | Methods | Area | Guard markers in file | Notes |", "|---|---|---|---|---|"];
    for (const r of routes) {
      const notes = [r.rawSql && "raw SQL", r.usesSharp && "sharp", r.usesBlob && "blob", r.usesStripe && "stripe", r.usesEmail && "email", r.usesAnthropic && "anthropic", r.usesGoogle && "google", r.runtimeEdge && "edge"].filter(Boolean).join(", ");
      lines.push(`| \`${r.url}\` | ${r.methods.join(" ") || "?"} | ${r.area} | ${r.guards.join(", ") || "**none**"} | ${notes} |`);
    }
    fs.writeFileSync(args[m + 1], lines.join("\n") + "\n");
  }
  console.log(JSON.stringify(summary, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
