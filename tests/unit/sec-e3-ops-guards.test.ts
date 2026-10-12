/**
 * Security campaign iteration 2, lane E3 (9 Oct 2026): closes review R2 "Owed" items 1 and 2.
 *  1. ops-blob-host-count.mjs — the TLS guard read the FIRST sslmode while pg-connection-string applies the LAST, and URL
 *     parameters overrode the script's own ssl option. The client is now built from an explicit config (host, port,
 *     user, password, database, ssl { rejectUnauthorized: true }); TLS/target parameters and PG* variables are refused.
 *  2. ops-credential-fingerprint.mjs — (i) an unknown argument was echoed in full; (ii) KEY="…" # comment kept the
 *     quotes and the comment, so a leaked value in that form reported "no match".
 * Synthetic values only, generated at run time. No connection is ever opened in this file.
 */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { envValueVariants, fingerprint, matchAgainst, parseEnvText } from "../../scripts/readiness/ops-credential-fingerprint.mjs";
import { assertTlsNotDowngraded, buildClientConfig } from "../../scripts/readiness/ops-blob-host-count.mjs";

const ROOT = path.resolve(__dirname, "../..");
const FP_SCRIPT = path.join(ROOT, "scripts/readiness/ops-credential-fingerprint.mjs");
const rnd = (n: number) => randomBytes(n).toString("hex").slice(0, n);
const join = (...p: string[]) => p.join("");
const TEST_HOST = "ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech";
const testUrl = (qs = "") => `postgresql://role_x:${rnd(16)}@${TEST_HOST}/neondb${qs}`;

/** The output must contain neither the value nor any 8-character window of it. */
function expectNoTrace(out: string, value: string) {
  expect(out).not.toContain(value);
  for (let i = 0; i + 8 <= value.length; i++) expect(out, `8-char window at ${i} leaked`).not.toContain(value.slice(i, i + 8));
}

function runFp(args: string[], input?: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [FP_SCRIPT, ...args], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("ops-blob-host-count: TLS and target cannot be steered by the URL (R2 owed 1)", () => {
  it.each([
    ["duplicate sslmode, the last one weakens (require then no-verify)", "?sslmode=require&sslmode=no-verify"],
    ["duplicate sslmode, the last one disables TLS", "?sslmode=require&sslmode=disable"],
    ["percent-encoded key (ssl%6dode=no-verify)", "?sslmode=require&ssl%6dode=no-verify"],
    ["percent-encoded key alone", "?ssl%6Dode=disable"],
    ["upper-case key", "?SSLMODE=disable"],
    ["ssl=0", "?ssl=0"],
    ["ssl=false", "?ssl=false"],
    ["sslrootcert (pg-connection-string reads the file at parse time)", "?sslmode=require&sslrootcert=x"],
    ["uselibpqcompat", "?uselibpqcompat=true&sslmode=require"],
    ["host override", `?host=${TEST_HOST}`],
    ["encoded host override", `?h%6fst=${TEST_HOST}`],
    ["upper-case hostaddr", "?HOSTADDR=10.0.0.1"],
    ["options", "?options=endpoint%3Dep-other"],
    ["endpoint", "?endpoint=ep-other"],
    ["sslmode=verify-ca (no CA pinned: weaker than verify-full)", "?sslmode=verify-ca"],
  ])("refuses %s", (_label, qs) => {
    expect(() => assertTlsNotDowngraded(testUrl(qs))).toThrow(/REFUSED/);
    expect(() => buildClientConfig(testUrl(qs), { expectHost: "ep-hidden-salad", env: {} })).toThrow(/REFUSED/);
  });

  it("positive control: the standard Neon URL forms are accepted and become an explicit, verified-TLS config", () => {
    for (const qs of ["", "?sslmode=require", "?sslmode=verify-full", "?sslmode=require&channel_binding=require"]) {
      const cfg = buildClientConfig(testUrl(qs), { expectHost: "ep-hidden-salad", env: {} });
      expect(cfg.host).toBe(TEST_HOST);
      expect(cfg.port).toBe(5432);
      expect(cfg.user).toBe("role_x");
      expect(cfg.database).toBe("neondb");
      expect(cfg.ssl).toEqual({ rejectUnauthorized: true, servername: TEST_HOST });
      expect(cfg).not.toHaveProperty("connectionString");
      expect(cfg).not.toHaveProperty("options");
      expect(Object.keys(cfg).sort()).toEqual(["application_name", "database", "host", "password", "port", "ssl", "user"]);
    }
  });

  it.each(["PGOPTIONS", "PGHOST", "PGHOSTADDR", "PGSSLMODE", "PGUSER", "PGSSLROOTCERT"])(
    "refuses %s in the environment (node-postgres applies PG* variables to an explicit config)",
    (k) => {
      expect(() => buildClientConfig(testUrl("?sslmode=require"), { expectHost: "ep-hidden-salad", env: { [k]: "x" } })).toThrow(new RegExp(`REFUSED.*${k}`));
    },
  );

  it("refuses a URL without a password or database rather than letting pg fill the gap from the environment", () => {
    expect(() => buildClientConfig(`postgresql://role_x@${TEST_HOST}/neondb`, { expectHost: "ep-hidden-salad", env: {} })).toThrow(/REFUSED/);
    expect(() => buildClientConfig(`postgresql://role_x:${rnd(12)}@${TEST_HOST}/`, { expectHost: "ep-hidden-salad", env: {} })).toThrow(/REFUSED/);
  });

  it("the CLI connects with the explicit config, never with connectionString", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts/readiness/ops-blob-host-count.mjs"), "utf8");
    expect(src).not.toMatch(/connectionString\s*:/);
    expect(src).toMatch(/config = buildClientConfig\(url, \{ expectHost \}\)/);
    expect(src).toMatch(/new pg\.Client\(config\)/);
  });
});

describe("ops-credential-fingerprint: never echoes an argument; parses env lines as dotenv does (R2 owed 2)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it("an unknown positional argument (a secret pasted by mistake) is not echoed — only its position", () => {
    const secret = join("np", "g_", rnd(24));
    const r = runFp(["--stdin", secret], "");
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/unexpected argument at position 2/);
    expectNoTrace(r.out, secret);
  });

  it("a secret given where a --var NAME belongs is not echoed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-e3-")); dirs.push(dir);
    const file = path.join(dir, "x.env");
    fs.writeFileSync(file, "A=1\n");
    const secret = join("re", "_", rnd(8), "_", rnd(24));
    const r = runFp(["--from-env-file", file, "--var", secret]);
    expect(r.code).toBe(2);
    expectNoTrace(r.out, secret);
    const lower = rnd(40); // a lower-case hex value is a valid identifier: it must still never be printed
    const r2 = runFp(["--from-env-file", file, "--var", lower]);
    expect(r2.code).toBe(2);
    expectNoTrace(r2.out, lower);
  });

  it("an unreadable --from-env-file path is not echoed (a secret pasted as the path)", () => {
    const secret = join("sk", "_live_", rnd(40));
    const r = runFp(["--from-env-file", secret, "--var", "DATABASE_URL"]);
    expect(r.code).toBe(2);
    expectNoTrace(r.out, secret);
  });

  it("the option is --from-env-file: Node itself intercepts --env-file even after the script path (and prints the path)", () => {
    // Measured on Node v24.21.0 (lane E3): `node script.mjs --env-file <missing>` exits 9 printing "<path>: not found"
    // before the script runs. With an existing file Node loads it and passes the arguments on; the script then refuses.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-e3-")); dirs.push(dir);
    const file = path.join(dir, "x.env");
    fs.writeFileSync(file, "A=1\n");
    const r = runFp(["--env-file", file, "--var", "A"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/unexpected argument at position 1/);
    expect(r.out).toContain("--from-env-file <path>");
    const src = fs.readFileSync(FP_SCRIPT, "utf8");
    expect(src).not.toMatch(/ops-credential-fingerprint\.mjs --env-file/);
  });

  it("a missing option value is reported without echoing anything", () => {
    const r = runFp(["--from-env-file"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/position 1/);
  });

  it("KEY=\"value\" # comment, KEY='value' # comment and KEY=value # comment yield the bare value, which MATCHes its own fingerprint", () => {
    const pw = join("np", "g_", rnd(16));
    const url = `postgresql://role_x:${pw}@ep-synthetic-000000.example.invalid/db?sslmode=require`;
    const list = [{ id: "synthetic", fp: fingerprint(pw) }];
    const text = [
      `A="${url}" # rotated? no`,
      `B='${url}'   # comment`,
      `C=${url} # trailing comment`,
      `export D = "${url}"#no-space comment after a quoted value`,
      `E="has # inside quotes"`,
      `F=hash#inside-unquoted`,
    ].join("\n");
    const env = parseEnvText(text);
    for (const k of ["A", "B", "C", "D"]) {
      expect(env[k], k).toBe(url);
      expect(matchAgainst(env[k], list), k).toEqual(["synthetic"]);
    }
    expect(env.E).toBe("has # inside quotes");
    // dotenv (and so Next.js) ends an UNQUOTED value at the first '#'; the CLI also checks the uncut form, so a value
    // that really contains '#' cannot hide behind that rule.
    expect(env.F).toBe("hash");
    expect(envValueVariants(text).F).toEqual(expect.arrayContaining(["hash", "hash#inside-unquoted"]));
    expect(envValueVariants(text).A).toEqual([url]);
  });

  it("CLI: a quoted + commented line holding a leaked-form value is evaluated on the bare value (no trace in output)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-e3-")); dirs.push(dir);
    const file = path.join(dir, "x.env");
    const pw = join("np", "g_", rnd(16));
    fs.writeFileSync(file, `DATABASE_URL="postgresql://u:${pw}@h.example.invalid/d" # pulled 9 Oct\n`);
    const r = runFp(["--from-env-file", file, "--var", "DATABASE_URL"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/DATABASE_URL: no match/);
    expectNoTrace(r.out, pw);
  });
});
