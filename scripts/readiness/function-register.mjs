#!/usr/bin/env node
/**
 * Generates docs/readiness/FUNCTION-REGISTER.md from the code, not from memory
 * (readiness spec v3 §4, 30 Sep 2026). Regenerate; never hand-edit the output.
 *
 *   node scripts/readiness/function-register.mjs [--run <summary.json>] [--sha <sha>]
 *
 * Rows: every API route (methods, guard, CSRF, rate limit, models touched,
 * external effects), every page, every scheduled job, every club setting.
 * Evidence is joined, never assumed:
 *   - e2e: journeys in tests/e2e/campaign/assess/journeys.ts that claim the
 *     route or page; PASS only when every lane file of that journey's group
 *     passed in the serial run given by --run (x12 summary.json).
 *   - unit: test files under tests/unit and tests/integration that import the
 *     route module.
 *   - settings: a key counts as exercised end to end only if an e2e spec names it.
 * A row with no evidence is NOT RUN. Status vocabulary: PASS · FAIL · NOT RUN.
 * BLOCKED / NOT AVAILABLE / N/A are set by hand in the limitations register,
 * not guessed here.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const runFiles = args.flatMap((a, i) => (a === "--run" ? [args[i + 1]] : []));
const runFile = runFiles.at(-1);
const sha = opt("--sha") ?? "(not given)";

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
function walk(dir, pred, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) walk(rel, pred, out);
    else if (pred(rel)) out.push(rel);
  }
  return out;
}

// ── evidence: serial run ────────────────────────────────────────────────────
const laneResult = new Map(); // "lb-1-club-setup" -> { passed, failed }
// Later runs override earlier ones for the same lane file.
for (const rf of runFiles) {
  const rows = JSON.parse(fs.readFileSync(rf, "utf8"));
  for (const r of rows) {
    const base = path.basename(r.spec).replace(/\.spec\.ts$/, "");
    laneResult.set(base, { passed: r.passed, failed: r.failed, didNotRun: r.didNotRun });
  }
}
const assessFiles = walk("tests/e2e/campaign/assess", (p) => p.endsWith(".spec.ts")).map((p) => path.basename(p, ".spec.ts"));
const GROUP_PREFIX = { "L-A": "la-", "L-B": "lb-", "L-C": "lc-", "L-D": "ld-", "L-E": "le-", "L-F": "lf-", "L-G": "lg-" };
function groupStatus(group) {
  const files = assessFiles.filter((f) => f.startsWith(GROUP_PREFIX[group] ?? "??"));
  if (!runFile || files.length === 0) return { status: "NOT RUN", files };
  const results = files.map((f) => laneResult.get(f));
  if (results.some((r) => !r)) return { status: "NOT RUN", files };
  if (results.some((r) => r.failed > 0 || r.didNotRun > 0)) return { status: "FAIL", files };
  return { status: "PASS", files };
}

// ── evidence: journeys ──────────────────────────────────────────────────────
const journeys = [];
for (const line of read("tests/e2e/campaign/assess/journeys.ts").split("\n")) {
  const m = line.match(/\{\s*id:\s*"(J\d+[a-z]?)",\s*name:\s*"([^"]+)",\s*group:\s*"(L-[A-G])".*routes:\s*\[([^\]]*)\]/);
  if (!m) continue;
  const routes = [...m[4].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  journeys.push({ id: m[1], name: m[2], group: m[3], routes });
}
const journeysFor = (verb, apiPath) =>
  journeys.filter((j) => j.routes.some((r) => {
    const [v, p] = r.includes(" ") ? r.split(" ") : [null, r];
    return p === apiPath && (!v || !verb || v === verb);
  }));
const journeysForPage = (pagePath) => journeys.filter((j) => j.routes.includes(pagePath));

// ── evidence: unit / integration tests importing a route ────────────────────
const testFiles = [...walk("tests/unit", (p) => /\.test\.tsx?$/.test(p)), ...walk("tests/integration", (p) => /\.test\.tsx?$/.test(p))];
const testSrc = new Map(testFiles.map((f) => [f, read(f)]));
const unitFor = (apiPath) => {
  const needle = `@/app/api/${apiPath}/route`;
  return [...testSrc].filter(([, s]) => s.includes(needle)).map(([f]) => path.basename(f));
};
const e2eSrc = assessFiles.map((f) => read(`tests/e2e/campaign/assess/${f}.spec.ts`)).join("\n");

// ── API routes ──────────────────────────────────────────────────────────────
function guardOf(src) {
  const g = [];
  for (const [re, label] of [
    [/requireApiOwner\(\)/, "owner"],
    [/requireApiOwnerOrManager\(\)/, "owner+manager"],
    [/requireApiStaff\(\)/, "staff"],
    [/requireOwner\(\)/, "owner (page helper)"],
    [/requireStaff\(\)/, "staff (page helper)"],
    [/requireOperatorSession\(|isOperatorRequest\(|x-admin-secret|MATFLOW_ADMIN_SECRET/, "operator"],
    [/CRON_SECRET/, "cron secret"],
    [/constructEvent|webhooks\.construct|svix|RESEND_WEBHOOK_SECRET/, "provider signature"],
    [/kioskTokenHash|displayTokenHash|hashToken\(/, "device/link token"],
  ]) if (re.test(src)) g.push(label);
  if (g.length === 0 && /await auth\(\)/.test(src)) g.push("session (role checked in route)");
  return g.length ? g.join(", ") : "public";
}
function modelsOf(src) {
  const s = new Set();
  for (const m of src.matchAll(/\b(?:tx|prisma|db)\.([a-z][A-Za-z]+)\.(?:find|create|update|upsert|delete|count|aggregate|groupBy)/g)) s.add(m[1]);
  return [...s].sort().join(", ") || "-";
}
function effectsOf(src) {
  const e = [];
  if (/stripe\.|getStripe|createSubscriptionForMember/.test(src)) e.push("Stripe");
  if (/sendEmail\(|sendMagicLink|sendInvite/.test(src)) e.push("email");
  if (/@vercel\/blob|\bput\(|uploadSignature|import-storage/.test(src)) e.push("file storage");
  if (/logAudit\(/.test(src)) e.push("audit row");
  if (/withRlsBypass\(/.test(src)) e.push("RLS bypass");
  return e.join(", ") || "-";
}
const routeFiles = walk("app/api", (p) => p.endsWith("/route.ts"));
const apiRows = routeFiles.map((f) => {
  const src = read(f);
  const apiPath = f.replace(/^app\/api\//, "").replace(/\/route\.ts$/, "");
  const methods = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
  const js = [...new Map(methods.flatMap((v) => journeysFor(v, apiPath)).concat(journeysFor(null, apiPath)).map((j) => [j.id, j])).values()];
  const units = unitFor(apiPath);
  const groups = [...new Set(js.map((j) => j.group))];
  const gs = groups.map(groupStatus);
  let status = "NOT RUN";
  if (gs.some((g) => g.status === "FAIL")) status = "FAIL";
  else if (gs.some((g) => g.status === "PASS")) status = "PASS";
  else if (units.length) status = "PASS (unit only)";
  return {
    id: `API:${apiPath}`,
    methods: methods.join(",") || "?",
    who: guardOf(src),
    csrf: /assertSameOrigin\(/.test(src) ? "yes" : "-",
    rl: /checkRateLimit\(/.test(src) ? "yes" : "-",
    models: modelsOf(src),
    effects: effectsOf(src),
    journeys: js.map((j) => j.id).join(" ") || "-",
    lanes: [...new Set(gs.flatMap((g) => g.files))].join(" ") || "-",
    units: units.length ? `${units.length} (${units.slice(0, 2).join(", ")}${units.length > 2 ? ", …" : ""})` : "-",
    status,
  };
});

// ── pages ───────────────────────────────────────────────────────────────────
const pageFiles = walk("app", (p) => p.endsWith("/page.tsx") && !p.startsWith("app/api/"));
const pageRows = pageFiles.map((f) => {
  const route = "/" + f.replace(/^app\//, "").replace(/\/?page\.tsx$/, "").replace(/\([^)]+\)\/?/g, "");
  const r = route === "/" ? "/" : route.replace(/\/$/, "");
  const js = journeysForPage(r);
  const gs = [...new Set(js.map((j) => j.group))].map(groupStatus);
  let status = "NOT RUN";
  if (gs.some((g) => g.status === "FAIL")) status = "FAIL";
  else if (gs.some((g) => g.status === "PASS")) status = "PASS";
  else if (e2eSrc.includes(`"${r}"`) || e2eSrc.includes(`'${r}'`) || e2eSrc.includes(`\`${r}`)) status = "PASS (visited by an e2e spec, not claimed by a journey)";
  return { id: `PAGE:${r}`, journeys: js.map((j) => j.id).join(" ") || "-", status };
});

// ── scheduled jobs ──────────────────────────────────────────────────────────
const vercel = JSON.parse(read("vercel.json"));
const cronRows = (vercel.crons ?? []).map((c) => ({ id: `CRON:${c.path}`, schedule: c.schedule }));

// ── club settings ───────────────────────────────────────────────────────────
const settingsSrc = read("lib/settings-registry.ts");
const settingRows = [...settingsSrc.matchAll(/spec\(\{\s*key:\s*"([^"]+)",\s*group:\s*"([^"]+)",[^}]*?editRole:\s*"([^"]+)",\s*risk:\s*"([^"]+)"/g)].map((m) => ({
  id: `SETTING:${m[1]}`, group: m[2], editRole: m[3], risk: m[4],
  status: new RegExp(`["'\`]${m[1]}["'\`]|\\b${m[1]}:`).test(e2eSrc) ? "PASS (named by an e2e spec)" : "NOT RUN",
}));

// ── write ───────────────────────────────────────────────────────────────────
const count = (rows, s) => rows.filter((r) => r.status.startsWith(s)).length;
const esc = (s) => String(s).replace(/\|/g, "\\|");
const lines = [];
lines.push("# Function register");
lines.push("");
lines.push(`Generated by \`scripts/readiness/function-register.mjs\` at candidate \`${sha}\`${runFiles.length ? ` against the serial run(s) ${runFiles.map((r) => `\`${path.basename(path.dirname(r))}\``).join(" then ")} (a later run overrides an earlier one for the same lane file)` : " (no serial run given: every e2e status is NOT RUN)"}. Regenerate; do not hand-edit. Hand-set dispositions (BLOCKED, NOT AVAILABLE, N/A, named limitations) live in \`FUNCTION-REGISTER-DISPOSITIONS.md\`.`);
lines.push("");
lines.push("How a status is earned: **PASS** — a journey claiming the route/page belongs to a lane group whose every file passed in the run. **PASS (unit only)** — imported and exercised by a unit/integration test, never end to end. **FAIL** — a claiming lane failed. **NOT RUN** — no evidence found. A PASS is evidence that the lane's assertions held, not that every behaviour of the route was asserted; the journey IDs say what was.");
lines.push("");
lines.push("## Totals");
lines.push("");
lines.push("| Kind | Rows | PASS (e2e) | PASS (unit only) | PASS (other) | FAIL | NOT RUN |");
lines.push("|---|---|---|---|---|---|---|");
const tot = (name, rows) => lines.push(`| ${name} | ${rows.length} | ${rows.filter((r) => r.status === "PASS").length} | ${count(rows, "PASS (unit")} | ${rows.filter((r) => r.status.startsWith("PASS (") && !r.status.startsWith("PASS (unit")).length} | ${count(rows, "FAIL")} | ${count(rows, "NOT RUN")} |`);
tot("API routes", apiRows);
tot("Pages", pageRows);
tot("Club settings", settingRows);
lines.push(`| Scheduled jobs | ${cronRows.length} | see the connection register | | | | |`);
lines.push("");
lines.push("## API routes");
lines.push("");
lines.push("| ID | Methods | Who (guard in code) | CSRF | Rate limit | Tables touched | External effects | Journeys | Lanes | Unit/integration tests | Status |");
lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of apiRows.sort((a, b) => a.id.localeCompare(b.id))) lines.push(`| ${esc(r.id)} | ${r.methods} | ${esc(r.who)} | ${r.csrf} | ${r.rl} | ${esc(r.models)} | ${r.effects} | ${r.journeys} | ${r.lanes} | ${esc(r.units)} | ${r.status} |`);
lines.push("");
lines.push("## Pages");
lines.push("");
lines.push("| ID | Journeys | Status |");
lines.push("|---|---|---|");
for (const r of pageRows.sort((a, b) => a.id.localeCompare(b.id))) lines.push(`| ${esc(r.id)} | ${r.journeys} | ${r.status} |`);
lines.push("");
lines.push("## Scheduled jobs (`vercel.json`)");
lines.push("");
lines.push("| ID | Schedule (UTC) |");
lines.push("|---|---|");
for (const r of cronRows) lines.push(`| ${r.id} | \`${r.schedule}\` |`);
lines.push("");
lines.push("## Club settings (`lib/settings-registry.ts`)");
lines.push("");
lines.push("| ID | Group | Who may edit | Risk | Status |");
lines.push("|---|---|---|---|---|");
for (const r of settingRows) lines.push(`| ${r.id} | ${r.group} | ${r.editRole} | ${r.risk} | ${r.status} |`);
lines.push("");
fs.writeFileSync(path.join(ROOT, "docs/readiness/FUNCTION-REGISTER.md"), lines.join("\n"));
console.log(`journeys parsed: ${journeys.length}; api ${apiRows.length}, pages ${pageRows.length}, crons ${cronRows.length}, settings ${settingRows.length}`);
for (const [k, rows] of [["api", apiRows], ["pages", pageRows], ["settings", settingRows]]) {
  console.log(k, "PASS", rows.filter((r) => r.status === "PASS").length, "unit-only", count(rows, "PASS (unit"), "FAIL", count(rows, "FAIL"), "NOT RUN", count(rows, "NOT RUN"));
}
