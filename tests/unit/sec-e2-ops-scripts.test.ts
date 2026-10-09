/**
 * Security campaign iteration 2, lane E2 (9 Oct 2026): operator-run containment helpers.
 *  - scripts/readiness/ops-credential-fingerprint.mjs (offline: is a held value one of the 7 May leaked values?)
 *  - scripts/readiness/ops-blob-host-count.mjs (read-only: which Blob stores do stored URLs reference? SF-48)
 * Synthetic values only, generated at run time. No database and no network in this file.
 */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEAKED,
  STRIPE_PREFIX_LEN,
  candidateForms,
  fingerprint,
  matchAgainst,
  matchLeaked,
  parseEnvText,
} from "../../scripts/readiness/ops-credential-fingerprint.mjs";
import {
  assertTlsNotDowngraded,
  classifyBlobHost,
  columnQuery,
  extractBlobHosts,
  quoteIdent,
  storeIdFingerprint,
} from "../../scripts/readiness/ops-blob-host-count.mjs";

const ROOT = path.resolve(__dirname, "../..");
const FP_SCRIPT = path.join(ROOT, "scripts/readiness/ops-credential-fingerprint.mjs");
const BLOB_SCRIPT = path.join(ROOT, "scripts/readiness/ops-blob-host-count.mjs");
const rnd = (n: number) => randomBytes(n).toString("hex").slice(0, n);
const join = (...p: string[]) => p.join("");

describe("ops-credential-fingerprint", () => {
  it("carries exactly the four 7 May leaked fingerprints recorded by the history scan", () => {
    expect(LEAKED.map((l) => l.id)).toEqual(["neon-password", "resend-api-key", "cron-secret", "stripe-key-prefix"]);
    for (const l of LEAKED) expect(l.fp).toMatch(/^[0-9a-f]{12}$/);
    const summary = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/security/evidence/E/secret-scan-summary-2026-10-09.json"), "utf8"));
    const recorded = JSON.stringify(summary);
    for (const l of LEAKED) expect(recorded).toContain(l.fp);
  });

  it("checks the whole value, the password inside a postgres URL, and a Stripe live-key prefix", () => {
    const pw = join("np", "g_", rnd(12));
    const url = `postgresql://role_x:${pw}@ep-synthetic-000000.example.invalid/db?sslmode=require`;
    expect(candidateForms(url)).toEqual([url, pw]);
    const key = join("rk", "_live_", rnd(60));
    expect(candidateForms(key)).toEqual([key, key.slice(0, STRIPE_PREFIX_LEN)]);
    expect(candidateForms("")).toEqual([]);
  });

  it("matches through every form (synthetic leak list) and never matches the real list with random values", () => {
    const pw = join("np", "g_", rnd(12));
    const key = join("sk", "_live_", rnd(50));
    const list = [
      { id: "pw", fp: fingerprint(pw) },
      { id: "prefix", fp: fingerprint(key.slice(0, STRIPE_PREFIX_LEN)) },
    ];
    expect(matchAgainst(`postgres://u:${pw}@h.example.invalid/d`, list)).toEqual(["pw"]);
    expect(matchAgainst(key, list)).toEqual(["prefix"]);
    expect(matchAgainst(rnd(40), list)).toEqual([]);
    for (let i = 0; i < 20; i++) expect(matchLeaked(rnd(64))).toEqual([]);
  });

  it("parses env files with export prefixes, quotes and CRLF", () => {
    const env = parseEnvText('export A="one"\r\nB=\'two\'\nC=three\n# D=no\nlower_ok=4\n');
    expect(env).toEqual({ A: "one", B: "two", C: "three", lower_ok: "4" });
  });

  it("CLI never echoes the value it was given (stdin and env-file modes)", () => {
    const secret = join("re", "_", rnd(8), "_", rnd(24));
    const out = execFileSync(process.execPath, [FP_SCRIPT, "--stdin"], { input: `${secret}\n`, encoding: "utf8" });
    expect(out).toContain("no match");
    expect(out).not.toContain(secret);
    expect(out).not.toContain(fingerprint(secret));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-e2-"));
    const file = path.join(dir, "x.env");
    fs.writeFileSync(file, `DATABASE_URL=postgres://u:${secret}@h.example.invalid/d\n`);
    try {
      const out2 = execFileSync(process.execPath, [FP_SCRIPT, "--env-file", file, "--var", "DATABASE_URL", "--var", "ABSENT"], { encoding: "utf8" });
      expect(out2).toMatch(/DATABASE_URL: no match/);
      expect(out2).toMatch(/ABSENT: not present/);
      expect(out2).not.toContain(secret);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is offline: imports no network or database module", () => {
    const src = fs.readFileSync(FP_SCRIPT, "utf8");
    expect(src).not.toMatch(/from "(pg|node:net|node:http|node:https|node:tls|undici)"/);
    expect(src).not.toMatch(/\bfetch\(/);
  });
});

describe("ops-blob-host-count", () => {
  it("extracts Blob hosts case-insensitively and ignores a store name hidden in a foreign URL path", () => {
    const text = '{"a":"https://AbC123.private.blob.vercel-storage.com/x.png","b":"https://evil.example/q.blob.vercel-storage.com/y","c":"https://blob.vercel-storage.com/z"}';
    expect(extractBlobHosts(text)).toEqual(["abc123.private.blob.vercel-storage.com", "blob.vercel-storage.com"]);
  });

  it("classifies store kind and fingerprints the store label the same way as the Vercel store id", () => {
    const id = `store_${rnd(16)}`;
    const label = id.replace(/^store_/, "").toLowerCase();
    expect(classifyBlobHost(`${label}.private.blob.vercel-storage.com`)).toEqual({ storeFp: storeIdFingerprint(id), kind: "private" });
    expect(classifyBlobHost(`${label}.public.blob.vercel-storage.com`).kind).toBe("public");
    expect(classifyBlobHost("blob.vercel-storage.com")).toEqual({ storeFp: "(bare)", kind: "bare" });
  });

  it("refuses connection strings that would switch TLS verification off", () => {
    const base = "postgresql://u:p@ep-x.example.invalid/db";
    for (const bad of ["?sslmode=disable", "?sslmode=no-verify", "?sslmode=prefer", "?sslmode=allow", "?uselibpqcompat=true&sslmode=require", "?sslrootcert=x"]) {
      expect(() => assertTlsNotDowngraded(base + bad)).toThrow(/REFUSED/);
    }
    for (const ok of ["", "?sslmode=require", "?sslmode=verify-full", "?sslmode=require&channel_binding=require"]) {
      expect(() => assertTlsNotDowngraded(base + ok)).not.toThrow();
    }
  });

  it("quotes catalogue identifiers so a hostile name cannot break out of the query", () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
    const q = columnQuery('T"; drop table x; --', "c");
    expect(q).toContain('public."T""; drop table x; --"');
    expect(q).toMatch(/^select /);
  });

  it("is read-only by construction: one READ ONLY transaction, rolled back, no data-changing SQL", () => {
    const src = fs.readFileSync(BLOB_SCRIPT, "utf8");
    expect(src).toContain('client.query("BEGIN READ ONLY")');
    expect(src).toContain('client.query("ROLLBACK")');
    expect(src).toContain("allowProduction: true");
    expect(src).toContain("assertTlsNotDowngraded(url)");
    const sql = [...src.matchAll(/client\.query\(\s*(`[^`]*`|"[^"]*")/g)].map((m) => m[1]).join("\n");
    expect(sql).not.toMatch(/\b(insert|update|delete|drop|alter|truncate|grant|revoke|create)\b/i);
  });
});
