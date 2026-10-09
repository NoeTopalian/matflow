// OPERATOR-RUN, OFFLINE credential fingerprint check (security campaign iteration 2, lane E2, 9 Oct 2026).
//
// Question it answers: "is the value I hold now the same value that leaked on 7 May 2026 (public git history,
// commit fa3c460)?" It compares 12-hex SHA-256 fingerprints only. It opens NO network connection, never prints a
// value, and never prints the fingerprint of the value you give it (only MATCH / no match per leaked item).
//
// Usage (run by Noe; the agent never runs it against a real credential):
//   node scripts/readiness/ops-credential-fingerprint.mjs --from-env-file <path> --var DATABASE_URL --var RESEND_API_KEY
//   <one value per line> | node scripts/readiness/ops-credential-fingerprint.mjs --stdin
// Exit codes: 0 = no input matched a leaked value; 3 = at least one MATCH (treat that credential as compromised);
// 2 = usage error.
// Lane E3 (review R2): argument values are never printed — a mistake reports only its position; --var takes an
// UPPER_CASE name; env lines are read as dotenv reads them (quotes and `# comment` stripped; for an unquoted value the
// uncut form is checked too). The option is --from-env-file, not --env-file: Node 24 intercepts --env-file even after
// the script path, loads that file into the process environment and, when it is missing, prints the path and exits 9.
//
// What it does NOT prove: "no match" means the value you supplied differs from the leaked one. It does not prove
// the leaked value was revoked at the provider (a Postgres role has one password, so for the SAME role a different
// current password does mean the old one no longer authenticates; a Resend account can hold several keys, so a
// different current key says nothing about whether the leaked key was deleted).
import fs from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

/** Fingerprints of the 7 May 2026 leaked values, as recorded by scripts/readiness/secret-scan.mjs --history. */
export const LEAKED = Object.freeze([
  { id: "neon-password", fp: "af8167cf87cc", note: "Neon role password (npg_ form) from DATABASE_URL in local .env, 7 May" },
  { id: "resend-api-key", fp: "7879e88681d3", note: "Resend API key (re_ form, 36 chars), 7 May" },
  { id: "cron-secret", fp: "f71010f7e71b", note: "CRON_SECRET (64 hex), 7 May" },
  { id: "stripe-key-prefix", fp: "7d3bddd6e499", note: "first 25 chars of the Stripe restricted live key (prefix only; not usable alone)" },
]);

export const STRIPE_PREFIX_LEN = 25;

export function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

// dotenv 17's line grammar, which @next/env (and so the app) uses: optional `export`, `KEY = value`, a quoted value
// ends at its closing quote, an UNQUOTED value ends at the first `#`, a trailing `# comment` is dropped.
const DOTENV_LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/**
 * Parse env text exactly as dotenv does (review R2: `KEY="…" # comment` kept its quotes and comment → false "no match").
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvText(text) {
  /** @type {Record<string, string>} */
  const out = {};
  const src = String(text).replace(/\r\n?/g, "\n");
  DOTENV_LINE.lastIndex = 0;
  let m;
  while ((m = DOTENV_LINE.exec(src)) !== null) {
    let v = (m[2] || "").trim();
    const q = v[0];
    v = v.replace(/^(['"`])([\s\S]*)\1$/, "$2");
    if (q === '"') v = v.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    out[m[1]] = v;
  }
  return out;
}

/**
 * Every plausible reading of each key: the dotenv value, plus — for a line dotenv cuts at a `#` — the value cut only
 * at ` #` (whitespace + hash) and the uncut value, for an UNQUOTED value. Checking more readings can only add
 * a MATCH (12-hex fingerprints), so a value that really contains `#` cannot hide behind the dotenv rule.
 * @param {string} text
 * @returns {Record<string, string[]>}
 */
export function envValueVariants(text) {
  const dotenv = parseEnvText(text);
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [k, v] of Object.entries(dotenv)) out[k] = [v];
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(raw);
    if (!m || !out[m[1]]) continue;
    const whole = m[2].trim();
    if (/^['"`]/.test(whole)) continue; // a quoted value is exact under dotenv: it ends at its closing quote
    for (const v of [whole, whole.replace(/\s+#.*$/, "").trim()]) {
      if (v && !out[m[1]].includes(v)) out[m[1]].push(v);
    }
  }
  return out;
}

/** Every form of a value that could equal a leaked item: the whole value, a URL password, a Stripe key prefix. */
export function candidateForms(value) {
  const forms = [];
  if (typeof value !== "string" || value.length === 0) return forms;
  forms.push(value);
  if (/^postgres(ql)?:\/\//i.test(value)) {
    try {
      const pw = decodeURIComponent(new URL(value).password);
      if (pw) forms.push(pw);
    } catch {
      /* not a parsable URL: the whole-value form is still checked */
    }
  }
  if (/^(rk|sk)_live_/.test(value) && value.length >= STRIPE_PREFIX_LEN) forms.push(value.slice(0, STRIPE_PREFIX_LEN));
  return forms;
}

/** Returns the ids of leaked items this value matches (empty array = no match). */
export function matchAgainst(value, list) {
  const fps = new Set(candidateForms(value).map(fingerprint));
  return list.filter((l) => fps.has(l.fp)).map((l) => l.id);
}

export function matchLeaked(value) {
  return matchAgainst(value, LEAKED);
}

// A --var name is printed back as the result label, so it must look like an env-variable NAME (upper case, as in every
// .env file this check is for). Anything else might be a pasted value and is refused WITHOUT being echoed (review R2).
const VAR_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const USAGE = "usage: --from-env-file <path> --var NAME [--var NAME…]  |  --stdin   (argument values are never printed)";

function main(argv) {
  const vars = [];
  let envFile = null;
  let stdin = false;
  // Positions are 1-based. No argument VALUE is ever printed: a secret passed by mistake must not reach the terminal.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from-env-file" || a === "--var") {
      if (i + 1 >= argv.length) { console.error(`missing value after the option at position ${i + 1}`); return 2; }
      const v = argv[++i];
      if (a === "--from-env-file") envFile = v;
      else if (VAR_NAME.test(v)) vars.push(v);
      else { console.error(`unexpected --var value at position ${i + 1} (expected an UPPER_CASE variable name; the value is not shown)`); return 2; }
    } else if (a === "--stdin") stdin = true;
    else { console.error(`unexpected argument at position ${i + 1} (not shown)`); console.error(USAGE); return 2; }
  }
  const inputs = [];
  if (envFile) {
    if (vars.length === 0) { console.error("--from-env-file needs at least one --var NAME"); return 2; }
    let text;
    try { text = fs.readFileSync(envFile, "utf8"); } catch (e) {
      console.error(`cannot read the --from-env-file (${e?.code ?? "error"}; the path is not shown)`);
      return 2;
    }
    const env = envValueVariants(text);
    for (const v of vars) inputs.push({ label: v, values: env[v] ?? [] });
  } else if (stdin) {
    fs.readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean).forEach((v, i) => inputs.push({ label: `stdin#${i + 1}`, values: [v.trim()] }));
  } else {
    console.error(USAGE);
    return 2;
  }
  let matched = false;
  for (const { label, values } of inputs) {
    if (!values.some(Boolean)) { console.log(`${label}: not present`); continue; }
    const ids = [...new Set(values.flatMap((value) => matchLeaked(value)))];
    if (ids.length) matched = true;
    console.log(`${label}: ${ids.length ? `MATCH leaked ${ids.join(",")} — treat as compromised` : "no match with any 7 May leaked value"}`);
  }
  return matched ? 3 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
