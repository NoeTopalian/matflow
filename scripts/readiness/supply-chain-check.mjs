#!/usr/bin/env node
/**
 * Supply-chain policy check (security campaign lane E, 9 Oct 2026; SEC-057..SEC-060, SEC-063).
 *
 *   node scripts/readiness/supply-chain-check.mjs              lockfile + import + manifest policy (offline)
 *   node scripts/readiness/supply-chain-check.mjs --audit      also runs `npm audit --omit=dev --json` and fails on
 *                                                              any high/critical advisory without a live exception
 *   node scripts/readiness/supply-chain-check.mjs --osv        also queries OSV (independent of npm's database) and
 *                                                              fails on any non-dev hit without a live exception
 *
 * Exit 0 = policy holds; 1 = violation; 2 = usage/I-O error. Read-only.
 *
 * What it enforces, and why:
 *  - every lockfile entry resolves from registry.npmjs.org with a sha512 integrity (no git/file/link/tarball URLs);
 *    a new registry host or a missing integrity is how dependency confusion or a tampered tarball would show up;
 *  - install scripts only from a reviewed allowlist (a new one runs arbitrary code on every `npm install`,
 *    including the Vercel build that holds production DATABASE_URL);
 *  - build-chain-only packages (the Prisma CLI and its MySQL/Studio drivers, the shadcn CLI) are never imported by
 *    code that ships in the server or client bundle;
 *  - `shadcn` stays a devDependency;
 *  - advisory exceptions carry an expiry date and lapse automatically.
 * It is a policy gate, not proof that the tree is safe: it cannot see a malicious version published under an
 * already-allowed name, and `npm audit` only knows advisories that exist.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED_REGISTRY = "https://registry.npmjs.org/";

/** Packages whose install scripts were reviewed on 9 Oct 2026 (docs/security/evidence/E/E-03-native-inventory.md). */
export const INSTALL_SCRIPT_ALLOWLIST = new Set(["@prisma/engines", "prisma", "@sentry/cli", "fsevents", "unrs-resolver"]);

/** Never imported by shipped code. */
export const BUILD_CHAIN_ONLY = ["mysql2", "postgres", "better-sqlite3", "@prisma/studio-core", "@prisma/dev", "prisma", "shadcn"];

/**
 * Advisory exceptions. Each one is a decision with an owner and an expiry, not a permanent waiver.
 * GHSA ids verified against OSV/GitHub on 9 Oct 2026 (docs/security/ADVISORY-REGISTER.md, ADV-01/02).
 */
export const AUDIT_EXCEPTIONS = [
  { id: "GHSA-3f6p-5ww8-9rcr", pkg: "mysql2", expires: "2026-11-09", reason: "prisma CLI 7.10.0 pins mysql2 3.15.3; loaded only by `prisma studio` for a MySQL datasource; override proposed (ADV-01)" },
  { id: "GHSA-rgwj-5xj2-c3m3", pkg: "mysql2", expires: "2026-11-09", reason: "as above (ADV-02)" },
];

const pkgName = (key, v) => v.name || key.replace(/^.*node_modules\//, "");

export function analyseLockfile(lock) {
  const violations = [];
  const installScripts = [];
  const hosts = {};
  let entries = 0;
  for (const [key, v] of Object.entries(lock.packages || {})) {
    if (!key) continue;
    entries++;
    const name = pkgName(key, v);
    if (v.link) { violations.push(`${key}: linked (file:) dependency`); continue; }
    const resolved = v.resolved || "";
    const host = (/^[a-z+]+:\/\/[^/]+\//i.exec(resolved) || [resolved || "<none>"])[0];
    hosts[host] = (hosts[host] || 0) + 1;
    if (!resolved.startsWith(ALLOWED_REGISTRY)) violations.push(`${key}: resolved outside ${ALLOWED_REGISTRY} (${host})`);
    if (!v.integrity) violations.push(`${key}: no integrity`);
    else if (!v.integrity.startsWith("sha512-")) violations.push(`${key}: integrity is not sha512`);
    if (v.hasInstallScript) {
      installScripts.push(`${name}@${v.version}${v.dev ? " (dev)" : v.optional ? " (optional)" : ""}`);
      if (!INSTALL_SCRIPT_ALLOWLIST.has(name)) violations.push(`${key}: install script not on the reviewed allowlist`);
    }
  }
  return { lockfileVersion: lock.lockfileVersion, entries, hosts, installScripts, violations };
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

export function forbiddenImports(files) {
  const hits = [];
  for (const [file, src] of Object.entries(files)) {
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[1];
      const bare = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (BUILD_CHAIN_ONLY.includes(bare)) hits.push(`${file}: imports ${spec}`);
    }
  }
  return hits;
}

export function manifestViolations(pkg) {
  const v = [];
  if (pkg.dependencies?.shadcn) v.push("shadcn is in dependencies (must be devDependencies)");
  return v;
}

/** Returns the advisories (high/critical) that are not covered by a live exception. */
export function unexcepted(auditJson, exceptions, today) {
  const live = exceptions.filter((e) => e.expires >= today);
  const open = [];
  for (const [name, vuln] of Object.entries(auditJson.vulnerabilities || {})) {
    for (const via of vuln.via || []) {
      if (typeof via === "string") continue;
      if (!["high", "critical"].includes(via.severity)) continue;
      const ghsa = (via.url || "").split("/").pop();
      if (live.some((e) => e.id === ghsa && e.pkg === name)) continue;
      open.push(`${name} ${ghsa} ${via.severity} ${via.range}`);
    }
  }
  return open;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

export function shippedSourceFiles(root) {
  const files = [
    ...walk(path.join(root, "app")),
    ...walk(path.join(root, "lib")),
    ...walk(path.join(root, "components")),
    ...["auth.ts", "proxy.ts", "instrumentation.ts", "instrumentation-client.ts", "next.config.ts",
      "sentry.client.config.ts", "sentry.server.config.ts", "sentry.edge.config.ts"].map((f) => path.join(root, f)).filter((f) => fs.existsSync(f)),
  ];
  return Object.fromEntries(files.map((f) => [path.relative(root, f).split(path.sep).join("/"), fs.readFileSync(f, "utf8")]));
}

async function main() {
  const root = process.cwd();
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lockResult = analyseLockfile(lock);
  const imports = forbiddenImports(shippedSourceFiles(root));
  const manifest = manifestViolations(pkg);
  const report = {
    at: new Date().toISOString(),
    node: process.version,
    lockfile: { version: lockResult.lockfileVersion, entries: lockResult.entries, hosts: lockResult.hosts, installScripts: lockResult.installScripts },
    violations: [...lockResult.violations, ...imports, ...manifest],
  };
  if (process.argv.includes("--audit")) {
    let out;
    try {
      // Fixed command string, no interpolated input (a shell is needed to resolve npm.cmd on Windows).
      out = execSync("npm audit --omit=dev --json", { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
    } catch (e) {
      out = e.stdout; // npm audit exits 1 when it finds anything
    }
    const audit = JSON.parse(out);
    const today = new Date().toISOString().slice(0, 10);
    const open = unexcepted(audit, AUDIT_EXCEPTIONS, today);
    report.audit = { counts: audit.metadata?.vulnerabilities, unexcepted: open, exceptions: AUDIT_EXCEPTIONS.map((e) => `${e.id} until ${e.expires}`) };
    report.violations.push(...open.map((o) => `advisory without live exception: ${o}`));
  }
  if (process.argv.includes("--osv")) {
    report.osv = await osvCorrelate(lock);
    const ex = new Set(AUDIT_EXCEPTIONS.filter((e) => e.expires >= new Date().toISOString().slice(0, 10)).map((e) => e.id));
    for (const h of report.osv.hits) {
      if (h.scope !== "prod") continue; // dev/build-only hits are reported, not gating
      const open = h.ids.filter((id) => !ex.has(id));
      if (open.length) report.violations.push(`OSV ${h.name}@${h.version}: ${open.join(", ")}`);
    }
  }
  console.log(JSON.stringify(report, null, 1));
  process.exit(report.violations.length ? 1 : 0);
}

/** Second, independent advisory source: OSV querybatch over every unique package@version in the lockfile. */
export async function osvCorrelate(lock) {
  const seen = new Map();
  for (const [key, v] of Object.entries(lock.packages || {})) {
    if (!key || !v.version) continue;
    const name = pkgName(key, v);
    const k = `${name}@${v.version}`;
    const scope = v.dev || v.devOptional ? "dev" : "prod";
    const prev = seen.get(k);
    if (prev) { if (scope === "prod") prev.scope = "prod"; continue; }
    seen.set(k, { name, version: v.version, scope });
  }
  const pkgs = [...seen.values()];
  const hits = [];
  for (let i = 0; i < pkgs.length; i += 500) {
    const chunk = pkgs.slice(i, i + 500);
    const res = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: chunk.map((p) => ({ package: { name: p.name, ecosystem: "npm" }, version: p.version })) }),
    });
    if (!res.ok) throw new Error(`OSV querybatch HTTP ${res.status}`);
    const j = await res.json();
    j.results.forEach((r, idx) => { if (r.vulns?.length) hits.push({ ...chunk[idx], ids: r.vulns.map((x) => x.id) }); });
  }
  return { queried: pkgs.length, hits };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
