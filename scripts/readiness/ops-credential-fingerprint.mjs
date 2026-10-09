// OPERATOR-RUN, OFFLINE credential fingerprint check (security campaign iteration 2, lane E2, 9 Oct 2026).
//
// Question it answers: "is the value I hold now the same value that leaked on 7 May 2026 (public git history,
// commit fa3c460)?" It compares 12-hex SHA-256 fingerprints only. It opens NO network connection, never prints a
// value, and never prints the fingerprint of the value you give it (only MATCH / no match per leaked item).
//
// Usage (run by Noe; the agent never runs it against a real credential):
//   node scripts/readiness/ops-credential-fingerprint.mjs --env-file <path> --var DATABASE_URL --var RESEND_API_KEY
//   <one value per line> | node scripts/readiness/ops-credential-fingerprint.mjs --stdin
// Exit codes: 0 = no input matched a leaked value; 3 = at least one MATCH (treat that credential as compromised);
// 2 = usage error.
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

/** Strip one layer of matching quotes and trailing CR; tolerate `export NAME=` lines. */
export function parseEnvText(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/^\s*export\s+/, "");
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
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

function main(argv) {
  const vars = [];
  let envFile = null;
  let stdin = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env-file") envFile = argv[++i];
    else if (argv[i] === "--var") vars.push(argv[++i]);
    else if (argv[i] === "--stdin") stdin = true;
    else { console.error(`unknown argument ${argv[i]}`); return 2; }
  }
  const inputs = [];
  if (envFile) {
    if (vars.length === 0) { console.error("--env-file needs at least one --var NAME"); return 2; }
    const env = parseEnvText(fs.readFileSync(envFile, "utf8"));
    for (const v of vars) inputs.push({ label: v, value: env[v] });
  } else if (stdin) {
    fs.readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean).forEach((v, i) => inputs.push({ label: `stdin#${i + 1}`, value: v.trim() }));
  } else {
    console.error("usage: --env-file <path> --var NAME [--var NAME…]  |  --stdin");
    return 2;
  }
  let matched = false;
  for (const { label, value } of inputs) {
    if (!value) { console.log(`${label}: not present`); continue; }
    const ids = matchLeaked(value);
    if (ids.length) matched = true;
    console.log(`${label}: ${ids.length ? `MATCH leaked ${ids.join(",")} — treat as compromised` : "no match with any 7 May leaked value"}`);
  }
  return matched ? 3 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
