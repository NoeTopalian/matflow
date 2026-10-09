#!/usr/bin/env node
/**
 * Secret scan with REDACTED output (security campaign lane E, 9 Oct 2026; catalogue SEC-062).
 *
 *   node scripts/readiness/secret-scan.mjs --history [--json <out>]   every blob reachable from every ref
 *   node scripts/readiness/secret-scan.mjs --tree    [--json <out>]   tracked files at HEAD
 *   node scripts/readiness/secret-scan.mjs --dir <path> [--json <out>] any directory (e.g. .next/static)
 *
 * Output never contains a matched value: each finding carries the rule, the location, the length,
 * the rule's fixed public prefix (e.g. `sk_live_`) and a 12-hex SHA-256 fingerprint so two findings can be
 * correlated without revealing the secret. Placeholders (`not-real`, `example`, localhost URLs …) are
 * classified `placeholder` and do not fail the run.
 *
 * Exit codes: 0 = no non-placeholder finding; 1 = at least one; 2 = usage or I/O error.
 * The scan is a pattern list, not proof of absence: a secret in an unknown format is not detected.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RULES = [
  { id: "stripe-live-secret", prefix: "sk_live_", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g, severity: "critical" },
  { id: "stripe-test-secret", prefix: "sk_test_", re: /\b(?:sk|rk)_test_[0-9A-Za-z]{20,}\b/g, severity: "high" },
  { id: "stripe-webhook-secret", prefix: "whsec_", re: /\bwhsec_[0-9A-Za-z+/]{20,}\b/g, severity: "high" },
  { id: "resend-api-key", prefix: "re_", re: /\bre_[0-9A-Za-z]{8,}_[0-9A-Za-z]{16,}\b/g, severity: "high" },
  { id: "vercel-blob-token", prefix: "vercel_blob_rw_", re: /\bvercel_blob_rw_[0-9A-Za-z]{8,}_[0-9A-Za-z]{16,}\b/g, severity: "critical" },
  { id: "aws-access-key-id", prefix: "AKIA", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, severity: "high" },
  { id: "github-token", prefix: "gh*_", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b|\bgithub_pat_[0-9A-Za-z_]{60,}\b/g, severity: "critical" },
  { id: "google-oauth-client-secret", prefix: "GOCSPX-", re: /\bGOCSPX-[0-9A-Za-z_-]{20,}/g, severity: "high" },
  { id: "anthropic-api-key", prefix: "sk-ant-", re: /\bsk-ant-[0-9A-Za-z_-]{20,}/g, severity: "high" },
  { id: "sentry-auth-token", prefix: "sntrys_", re: /\bsntrys_[0-9A-Za-z+/=_-]{20,}/g, severity: "high" },
  { id: "private-key-block", prefix: "-----BEGIN", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g, severity: "critical" },
  {
    id: "postgres-url-with-password",
    prefix: "postgres://",
    re: /\bpostgres(?:ql)?:\/\/[^\s:@/'"`<>]+:[^\s@'"`<>]{6,}@[^\s'"`<>]+/g,
    severity: "critical",
  },
  // Neon role passwords are issued as `npg_` + 12+ characters; they also appear outside a URL
  // (the 7 May 2026 audit table quoted one as "password npg_…").
  { id: "neon-password", prefix: "npg_", re: /\bnpg_[0-9A-Za-z]{12,}\b/g, severity: "critical" },
  // A truncated live key still discloses the account's key prefix; flag it so a human looks.
  { id: "stripe-live-key-fragment", prefix: "rk_live_/sk_live_", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{8,19}(?![0-9A-Za-z])/g, severity: "high" },
  // Markdown/table form: `SECRET_NAME` | `value`
  {
    id: "secret-name-table-value",
    prefix: "NAME|",
    re: /(?:AUTH_SECRET|NEXTAUTH_SECRET|MATFLOW_ADMIN_SECRET|CRON_SECRET|E2E_BYPASS_TOKEN|VAPID_PRIVATE_KEY|STRIPE_SECRET_KEY|RESEND_API_KEY|BLOB_READ_WRITE_TOKEN|ANTHROPIC_API_KEY|GOOGLE_CLIENT_SECRET|STRIPE_WEBHOOK_SECRET|RESEND_WEBHOOK_SECRET|AWS_SECRET_ACCESS_KEY)`?\s*\|\s*`([A-Za-z0-9+/_=.-]{16,})`/g,
    severity: "high",
    valueGroup: 1,
    minEntropy: 3.5,
  },
  { id: "jwt", prefix: "eyJ", re: /\beyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/g, severity: "medium" },
  {
    id: "secret-env-assignment",
    prefix: "NAME=",
    re: /(?:^|[\s"'`{,])(?:export\s+)?(?:AUTH_SECRET|NEXTAUTH_SECRET|MATFLOW_ADMIN_SECRET|CRON_SECRET|E2E_BYPASS_TOKEN|VAPID_PRIVATE_KEY|STRIPE_SECRET_KEY|RESEND_API_KEY|BLOB_READ_WRITE_TOKEN|ANTHROPIC_API_KEY|GOOGLE_CLIENT_SECRET|STRIPE_WEBHOOK_SECRET|RESEND_WEBHOOK_SECRET|AUDIT_DIGEST_KEY|AWS_SECRET_ACCESS_KEY)["']?\s*[=:]\s*["']?([A-Za-z0-9+/_.~-]{16,})/gm,
    severity: "high",
    valueGroup: 1,
    minEntropy: 3.5,
  },
];

const PLACEHOLDER = [
  /not[-_]?real/i, /example/i, /placeholder/i, /changeme/i, /dummy/i, /fake/i, /x{6,}/i, /\.{3}/, /<[^>]+>/,
  /your[-_]/i, /ci[-_]only/i, /test[-_]secret/i, /redacted/i, /\$\{/, /process\.env/, /\*{3,}/,
  /@(?:localhost|127\.0\.0\.1|0\.0\.0\.0|host|db|postgres)(?:[:/]|$)/i, /:postgres@/, /:password@/i, /:pass@/i, /:p@/,
  /^(?:sk|rk)_(?:live|test)_(?:0+|1234)/, /0{12,}/, /abcdef/i, /replace[-_]with/i, /deadbeef/i, /probe/i,
];

export function shannon(s) {
  const f = {};
  for (const c of s) f[c] = (f[c] || 0) + 1;
  let h = 0;
  for (const n of Object.values(f)) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

export function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function isPlaceholder(value) {
  return PLACEHOLDER.some((re) => re.test(value));
}

/** Scan one text. Returns redacted findings only. */
export function scanText(text, location = "<text>") {
  const findings = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text))) {
      const value = rule.valueGroup ? m[rule.valueGroup] : m[0];
      if (!value) continue;
      if (rule.minEntropy && shannon(value) < rule.minEntropy) continue;
      const lead = m[0].length - m[0].trimStart().length;
      const line = text.slice(0, m.index + lead).split("\n").length;
      let host = undefined;
      if (rule.id === "postgres-url-with-password") {
        const h = /@([^/:?\s'"`]+)/.exec(m[0]);
        host = h ? (/neon\.tech$/i.test(h[1]) ? "neon.tech" : /localhost|127\.0\.0\.1/.test(h[1]) ? "local" : "other") : "unknown";
      }
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        location,
        line,
        length: value.length,
        prefix: rule.prefix,
        fingerprint: fingerprint(value),
        hostClass: host,
        classification: isPlaceholder(m[0]) ? "placeholder" : "candidate",
      });
    }
  }
  return findings;
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const MAX_BYTES = 5 * 1024 * 1024;

function scanHistory(repo) {
  const list = execFileSync("git", ["rev-list", "--all", "--objects"], { cwd: repo, maxBuffer: 1 << 30 }).toString();
  const blobsByPath = new Map();
  for (const line of list.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const id = line.slice(0, sp);
    const p = line.slice(sp + 1);
    if (!blobsByPath.has(id)) blobsByPath.set(id, p);
  }
  const ids = [...blobsByPath.keys()];
  // Keep only blobs.
  const types = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    cwd: repo, input: ids.join("\n") + "\n", maxBuffer: 1 << 30,
  }).toString().trim().split("\n");
  const blobs = [];
  for (const t of types) {
    const [id, type, size] = t.split(" ");
    if (type === "blob" && Number(size) <= MAX_BYTES) blobs.push(id);
  }
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["cat-file", "--batch"], { cwd: repo });
    const findings = [];
    let buf = Buffer.alloc(0);
    let scanned = 0;
    proc.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const header = buf.slice(0, nl).toString();
        const [id, , sizeStr] = header.split(" ");
        const size = Number(sizeStr);
        if (buf.length < nl + 1 + size + 1) return;
        const body = buf.slice(nl + 1, nl + 1 + size);
        buf = buf.slice(nl + 1 + size + 1);
        scanned++;
        if (!isBinary(body)) {
          for (const f of scanText(body.toString("utf8"), `${blobsByPath.get(id)}@blob:${id.slice(0, 10)}`)) findings.push(f);
        }
      }
    });
    proc.on("error", reject);
    proc.on("close", () => resolve({ scanned, findings }));
    proc.stdin.write(blobs.join("\n") + "\n");
    proc.stdin.end();
  });
}

function scanFiles(root, files) {
  const findings = [];
  let scanned = 0;
  for (const rel of files) {
    const abs = path.join(root, rel);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    const body = fs.readFileSync(abs);
    scanned++;
    if (isBinary(body)) continue;
    findings.push(...scanText(body.toString("utf8"), rel.split(path.sep).join("/")));
  }
  return { scanned, findings };
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

export function summarise(result) {
  const candidates = result.findings.filter((f) => f.classification === "candidate");
  const byRule = {};
  for (const f of result.findings) {
    const k = `${f.rule}:${f.classification}`;
    byRule[k] = (byRule[k] || 0) + 1;
  }
  return { scanned: result.scanned, findings: result.findings.length, candidates: candidates.length, byRule };
}

async function main() {
  const args = process.argv.slice(2);
  const jsonIdx = args.indexOf("--json");
  const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
  const repo = process.cwd();
  let mode, result;
  if (args.includes("--history")) { mode = "history"; result = await scanHistory(repo); }
  else if (args.includes("--tree")) {
    mode = "tree";
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: repo, maxBuffer: 1 << 28 }).toString().split("\0").filter(Boolean);
    result = scanFiles(repo, files);
  } else if (args.includes("--dir")) {
    const d = args[args.indexOf("--dir") + 1];
    if (!d || !fs.existsSync(d)) { console.error("usage: --dir <existing path>"); process.exit(2); }
    mode = `dir:${d}`;
    result = scanFiles(d, walk(d));
  } else {
    console.error("usage: secret-scan.mjs --history | --tree | --dir <path> [--json <out>]");
    process.exit(2);
  }
  const summary = { mode, at: new Date().toISOString(), ...summarise(result) };
  console.log(JSON.stringify(summary, null, 1));
  for (const f of result.findings.filter((x) => x.classification === "candidate")) {
    console.log(`CANDIDATE ${f.severity} ${f.rule} ${f.location}:${f.line} len=${f.length} prefix=${f.prefix} fp=${f.fingerprint}${f.hostClass ? ` host=${f.hostClass}` : ""}`);
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ summary, findings: result.findings }, null, 1));
  process.exit(summary.candidates > 0 ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
