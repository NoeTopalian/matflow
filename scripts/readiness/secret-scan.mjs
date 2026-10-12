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
 * classified `placeholder` and do not fail the run. The placeholder test reads the CAPTURED value only (a URL's
 * password and host, an assignment's value), never the surrounding text, and a marker word downgrades a value only
 * when nothing random-looking remains without it (lane E3, review R2).
 * Lane F3 (SF-82 residuals): names match case-insensitively; a generic *_PASSWORD / *_SECRET / *_TOKEN rule takes
 * any non-empty literal, and its human-readable values in source files are classified `literal` (listed, counted,
 * not failing) while random-looking values and anything in an env/config file are `candidate`.
 *
 * Exit codes: 0 = no `candidate` finding; 1 = at least one; 2 = usage or I/O error.
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
    // Group 1 = password, group 2 = host: the placeholder test reads only these (lane E3), the fingerprint the URL.
    re: /\bpostgres(?:ql)?:\/\/[^\s:@/'"`<>]+:([^\s@'"`<>]{6,})@(?=[^\s'"`<>])([^\s'"`<>/:?]*)[^\s'"`<>]*/g,
    severity: "critical",
    checkGroup: 1,
    hostGroup: 2,
  },
  // Lane E3 (review R2): names missing from the list. The tenant-context signing key is 128 hex.
  {
    id: "rls-context-signing-key",
    prefix: "RLS_CONTEXT_SIGNING_KEY=",
    re: /(?:^|[^A-Za-z0-9_])RLS_CONTEXT_SIGNING_KEY["']?\s*[=:]\s*["'`]?([0-9A-Fa-f]{128})(?![0-9A-Fa-f])/gi,
    severity: "critical",
    valueGroup: 1,
  },
  // Names in every NAME-based rule match case-insensitively (lane F3, SF-82 residual: a lower-case
  // operator_password was missed). Passwords have no format: any assigned literal of 8+ characters that is not an
  // interpolation or a placeholder.
  {
    id: "password-env-assignment",
    prefix: "NAME=",
    re: /(?:^|[\s"'`{,])(?:export\s+)?(?:OPERATOR_PASSWORD|MATFLOW_PROD_PASSWORD|TEST_PASSWORD)["']?\s*[=:]\s*["'`]?([^\s"'`,;)}]{8,})/gim,
    severity: "high",
    valueGroup: 1,
    minEntropy: 2,
  },
  // Owner / direct URLs with ANY non-empty password (the generic URL rule needs 6+ characters).
  {
    id: "database-url-env-assignment",
    prefix: "NAME=postgres://",
    re: /(?:^|[\s"'`{,])(?:export\s+)?(?:MIGRATION_DATABASE_URL|DATABASE_URL_DIRECT)["']?\s*[=:]\s*["'`]?(postgres(?:ql)?:\/\/[^\s:@/'"`<>]+:([^\s@'"`<>]+)@([^\s'"`<>/:?]+)[^\s'"`<>]*)/gim,
    severity: "critical",
    valueGroup: 1,
    checkGroup: 2,
    hostGroup: 3,
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
    re: /(?:AUTH_SECRET|NEXTAUTH_SECRET|MATFLOW_ADMIN_SECRET|CRON_SECRET|E2E_BYPASS_TOKEN|VAPID_PRIVATE_KEY|STRIPE_SECRET_KEY|RESEND_API_KEY|BLOB_READ_WRITE_TOKEN|ANTHROPIC_API_KEY|GOOGLE_CLIENT_SECRET|STRIPE_WEBHOOK_SECRET|RESEND_WEBHOOK_SECRET|AWS_SECRET_ACCESS_KEY)`?\s*\|\s*`([A-Za-z0-9+/_=.-]{16,})`/gi,
    severity: "high",
    valueGroup: 1,
    minEntropy: 3.5,
  },
  { id: "jwt", prefix: "eyJ", re: /\beyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/g, severity: "medium" },
  {
    id: "secret-env-assignment",
    prefix: "NAME=",
    re: /(?:^|[\s"'`{,])(?:export\s+)?(?:AUTH_SECRET|NEXTAUTH_SECRET|MATFLOW_ADMIN_SECRET|CRON_SECRET|E2E_BYPASS_TOKEN|VAPID_PRIVATE_KEY|STRIPE_SECRET_KEY|RESEND_API_KEY|BLOB_READ_WRITE_TOKEN|ANTHROPIC_API_KEY|GOOGLE_CLIENT_SECRET|STRIPE_WEBHOOK_SECRET|RESEND_WEBHOOK_SECRET|AUDIT_DIGEST_KEY|AWS_SECRET_ACCESS_KEY)["']?\s*[=:]\s*["']?([A-Za-z0-9+/_.~-]{16,})/gim,
    severity: "high",
    valueGroup: 1,
    minEntropy: 3.5,
  },
  // Lane F3 (SF-82 residual): ANY name ending _PASSWORD / _PASSWD / _SECRET / _TOKEN (SMTP_PASSWORD, smtp_secret …)
  // assigned ANY non-empty literal. Three shapes, so code that merely names such a variable is not a finding:
  //   a quoted literal anywhere — NAME = "v" / NAME: 'v' / "NAME": "v" / NAME=`v` (the ":" written against the name,
  //     so a ternary "? NAME : 'text'" is not an assignment);
  //   an unquoted value as a whole env/YAML line — NAME=v or NAME: v, nothing after it but a # comment, and not
  //     ending in code punctuation (a TypeScript "NAME: string;" or "token: f(x)," is not a value);
  //   an env pair written tight anywhere — NAME=v with no space around "=" (inside a string, a command line …).
  // The placeholder test reads the captured value (as E3 built it); a dotted reference (tokens.refresh, env.X) or a
  // shell / cmd variable ($X, %X%) is a reference, not a literal. A value a named rule already reported on the
  // same line is not repeated. Classification (scanText): "candidate" when the value looks random or the file is an
  // env/config file (where deployment secrets live); otherwise "literal" — a human-readable hard-coded value in
  // source (test fixtures such as a THROWAWAY_PASSWORD): REPORTED and counted, listed by the CLI, but not failing.
  {
    id: "generic-secret-assignment",
    prefix: "*_PASSWORD|*_SECRET|*_TOKEN=",
    re: /(?:^|[^A-Za-z0-9_])[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*_(?:PASSWORD|PASSWD|SECRET|TOKEN)["']?(?:[ \t]*=|:)[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`)|^[ \t]*(?:export[ \t]+)?[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*_(?:PASSWORD|PASSWD|SECRET|TOKEN)(?:[ \t]*=|:)[ \t]*([^\s"'`#]*[^\s"'`#,;(){}[\]])[ \t]*(?:#[^\r\n]*)?\r?$|(?:^|[^A-Za-z0-9_.$])[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*_(?:PASSWORD|PASSWD|SECRET|TOKEN)=([^\s"'`#;,)}\]=][^\s"'`#;,)}\]]*)/gim,
    severity: "high",
    valueGroups: [1, 2, 3, 4, 5],
    referenceIsPlaceholder: true,
    generic: true,
  },
];

// The placeholder test reads the CAPTURED VALUE only (the rule's value/check group), never the whole match: review R2
// found a real-looking URL followed by "..." and a key containing Fake/abcdef/probe classified as placeholders because
// the patterns were tested on the whole match (lane E3, 9 Oct 2026).
//
// STRUCTURAL: the value is not a literal at all (interpolation, a reference, an angle-bracket slot) or is a bare
// placeholder word / filler. Any of these makes the value a placeholder.
const PLACEHOLDER_STRUCTURAL = [
  /\$\{/, /\$\(/, /process\.env/, /^<[^>]*>?$/, /^\*+$/, /^x+$/i, /^(.)\1*$/,
  /^(?:user|username|password|passwd|pass|pw|pwd|p|postgres|secret|changeme|test|admin|root|fixture)$/i,
];
// MARKERS: words and fillers that usually mean a fixture. A marker downgrades a value ONLY when nothing random-looking
// is left once the markers (and separators) are removed — so `sk_live_<10>Fake<20>` stays a candidate while
// `sk_test_000…`, `replace-with-openssl-rand-base64-32` and `not-a-real-key` stay placeholders.
const PLACEHOLDER_MARKERS = [
  /not[-_]?(?:a[-_]?)?real/gi, /example/gi, /placeholder/gi, /changeme/gi, /dummy/gi, /fake/gi, /x{6,}/gi, /\.{3,}/g,
  /your[-_]/gi, /ci[-_]only/gi, /test[-_]secret/gi, /redacted/gi, /\*{3,}/g, /0{12,}/g, /abcdef/gi, /replace[-_]with/gi,
  /deadbeef/gi, /probe/gi, /1234567890|123456789|12345678|1234/g,
];
// Hosts that cannot be a real database: loopback / container names, and RFC 2606 / 6761 reserved names.
const PLACEHOLDER_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|host|db|postgres|\[::1\])$|(?:^|\.)(?:example(?:\.com|\.org|\.net)?|invalid|test|localhost)$/i;

/** True when some alphanumeric run of 16+ characters (12+ for a run of mixed case and digits) looks random. */
export function hasRandomRun(s) {
  for (const run of String(s).split(/[^0-9A-Za-z]+/)) {
    if (run.length >= 16 && shannon(run) >= 3.0) return true;
    if (run.length >= 12 && /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run) && shannon(run) >= 3.0) return true;
  }
  return false;
}

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

/** Placeholder test on a CAPTURED value (never the whole match). */
export function isPlaceholder(value) {
  const v = String(value);
  if (PLACEHOLDER_STRUCTURAL.some((re) => re.test(v))) return true;
  let rest = v;
  let marked = false;
  for (const re of PLACEHOLDER_MARKERS) {
    re.lastIndex = 0;
    const next = rest.replace(re, " ");
    if (next !== rest) { marked = true; rest = next; }
  }
  // Lane F3 (SF-82 residual): a marker cut out of the MIDDLE of one token leaves the two halves of that token, which
  // count as one stretch — `<8 random>example<8 random>` leaves two runs each below hasRandomRun's length, yet
  // together they are a real password. A marker at a token's edge or between separators splits nothing.
  return marked && !hasRandomRun(rest) && !embeddedMarkerRandom(v);
}

/**
 * True when some single alphanumeric token of the value has a marker strictly inside it (letters or digits on both
 * sides) and, with the markers removed, is 12+ characters with upper AND lower case and Shannon >= 3.0.
 */
export function embeddedMarkerRandom(v) {
  for (const tok of String(v).split(/[^0-9A-Za-z]+/)) {
    let rest = tok;
    let embedded = false;
    for (const re of PLACEHOLDER_MARKERS) {
      re.lastIndex = 0;
      rest = rest.replace(re, (m, off, s) => {
        if (off > 0 && off + m.length < s.length) embedded = true;
        return "";
      });
    }
    if (embedded && rest.length >= 12 && /[a-z]/.test(rest) && /[A-Z]/.test(rest) && shannon(rest) >= 3.0) return true;
  }
  return false;
}

/** A dotted reference (tokens.refresh, env.SMTP_PASSWORD, this.secret) names a value rather than being one. */
const REFERENCE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[;,]?$|^\$[A-Za-z_]\w*$|^%\w+%$/;

/** Env / config files, where any literal secret counts (a history location carries an "@blob:<id>" suffix). */
const CONFIG_FILE = /(?:^|[\\/])(?:\.env[^\\/@]*|[^\\/@]*\.(?:env|ya?ml|toml|ini|properties|cfg|conf)|Dockerfile[^\\/@]*|\.npmrc|\.pypirc)(?:@blob:[0-9a-f]+)?$/i;

/** Host of a URL rule that cannot be a real database (loopback, container name, reserved domain). */
export function isPlaceholderHost(host) {
  return PLACEHOLDER_HOST.test(String(host).replace(/\.$/, ""));
}

/** Scan one text. Returns redacted findings only. */
export function scanText(text, location = "<text>") {
  const findings = [];
  const reported = []; // { line, value } of named-rule findings, local to this call (never returned or printed)
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text))) {
      const value = rule.valueGroups ? rule.valueGroups.map((g) => m[g]).find((v) => v !== undefined)
        : rule.valueGroup ? m[rule.valueGroup] : m[0];
      if (!value) continue;
      if (rule.minEntropy && shannon(value) < rule.minEntropy) continue;
      const lead = m[0].length - m[0].trimStart().length;
      const line = text.slice(0, m.index + lead).split("\n").length;
      let host = undefined;
      const hostVal = rule.hostGroup ? m[rule.hostGroup] ?? "" : undefined;
      if (hostVal !== undefined) {
        host = hostVal ? (/neon\.tech$/i.test(hostVal) ? "neon.tech" : /localhost|127\.0\.0\.1/.test(hostVal) ? "local" : "other") : "unknown";
      }
      // Placeholder test on the captured value only (check group, else value group, else the match for a fixed-format
      // rule whose match IS the value); a URL rule is also a placeholder when its host cannot be a real database.
      let check = rule.checkGroup ? m[rule.checkGroup] ?? "" : value;
      if (hostVal !== undefined) {
        // URL password: percent-decode, and drop Neon's `endpoint=<id>;` routing prefix — the rest is the password.
        try { check = decodeURIComponent(check); } catch { /* keep the raw form */ }
        check = check.replace(/^endpoint=[^;]*;/i, "");
      }
      const placeholder = isPlaceholder(check) || (hostVal !== undefined && isPlaceholderHost(hostVal))
        || (rule.referenceIsPlaceholder === true && REFERENCE.test(check));
      // The generic rule does not repeat a value a named rule already reported on the same line (same fingerprint),
      // nor one that sits inside a value already reported there (a URL whose password another rule judged).
      if (rule.generic && reported.some((r) => r.line === line && r.value.includes(value))) continue;
      if (!rule.generic) reported.push({ line, value });
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        location,
        line,
        length: value.length,
        prefix: rule.prefix,
        fingerprint: fingerprint(value),
        hostClass: host,
        classification: placeholder ? "placeholder"
          : rule.generic && !CONFIG_FILE.test(location) && !hasRandomRun(check) && !embeddedMarkerRandom(check) ? "literal" : "candidate",
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
  for (const f of result.findings.filter((x) => x.classification === "candidate" || x.classification === "literal")) {
    console.log(`${f.classification.toUpperCase()} ${f.severity} ${f.rule} ${f.location}:${f.line} len=${f.length} prefix=${f.prefix} fp=${f.fingerprint}${f.hostClass ? ` host=${f.hostClass}` : ""}`);
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ summary, findings: result.findings }, null, 1));
  process.exit(summary.candidates > 0 ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
