/**
 * SF-109 rotation tool — the target guard and argument handling, with no database (security campaign iteration 2,
 * lane M1 v2, 10 Oct 2026). The tool is TEST-only by construction: there is no production mode, no flag admits
 * production, libpq environment overrides are refused, and the pg client is built from explicit fields, never a
 * connection string. The production URL shapes are checked against the pure guard function only, so nothing here can
 * open a connection to production even if the guard were broken; the spawned refusals use `.invalid` hosts (RFC 6761).
 * Behaviour on the TEST branch: tests/integration/sec-m1-demo-rotate-db.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import {
  parseArgs,
  vetTarget,
  refusePgEnvironment,
  clientConfig,
  maskEmail,
  emailDigest,
  Refused,
} from "../../scripts/readiness/demo-accounts-rotate.mjs";

const SCRIPT = path.join(process.cwd(), "scripts/readiness/demo-accounts-rotate.mjs");
const PROD = "ep-bold-wave-abt39t7x";
const TEST = "ep-hidden-salad-abom7cg4";
const SUFFIX = ".eu-west-2.aws.neon.tech";
// Synthetic credentials; these strings never reach a network call in this file.
const url = (host: string, extra = "") => `postgresql://secm1user:secm1pass@${host}/neondb?sslmode=require${extra}`;

function run(args: string[], env: Record<string, string> = {}, envFileUrl?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secm1-"));
  const file = path.join(dir, "secm1.env");
  fs.writeFileSync(file, `TEST_DATABASE_URL="${envFileUrl ?? url(`${TEST}-pooler${SUFFIX}.invalid`)}"\n`);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^PG[A-Z]/.test(k)));
  const r = spawnSync(process.execPath, [SCRIPT, "--env-file", file, ...args], {
    env: { ...clean, ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

describe("demo-accounts-rotate: no production mode", () => {
  it("the guard refuses every production host shape (pure function, no connection)", () => {
    for (const h of [`${PROD}${SUFFIX}`, `${PROD}-pooler${SUFFIX}`, `${PROD.toUpperCase()}-POOLER${SUFFIX.toUpperCase()}`]) {
      expect(() => vetTarget(url(h)), h).toThrow(Refused);
    }
    // The TEST hostname re-pointed at production through an override parameter.
    expect(() => vetTarget(url(`${TEST}-pooler${SUFFIX}`, `&options=endpoint%3D${PROD}`))).toThrow(Refused);
    expect(() => vetTarget(url(`${TEST}-pooler${SUFFIX}`, `&host=${PROD}${SUFFIX}`))).toThrow(Refused);
    // A restore branch or any other endpoint is not the TEST endpoint either.
    expect(() => vetTarget(url(`ep-other-branch-abcd1234${SUFFIX}`))).toThrow(Refused);
    expect(() => vetTarget(url(`${TEST}.example.test`))).toThrow(Refused);
  });

  it("positive control: the TEST endpoint, pooled and direct, is admitted", () => {
    expect(vetTarget(url(`${TEST}-pooler${SUFFIX}`))).toBe(`${TEST}-pooler${SUFFIX}`);
    expect(vetTarget(url(`${TEST}${SUFFIX}`))).toBe(`${TEST}${SUFFIX}`);
  });

  it("no option admits production; unknown options, .env and other variables are refused", () => {
    for (const flag of ["--production", "--allow-production", "--prod", "--target", "--force", "--yes"]) {
      expect(() => parseArgs(["--slug", "secm1-x", flag]), flag).toThrow(/unknown option/);
    }
    expect(() => parseArgs(["--slug", "secm1-x", "--var", "DATABASE_URL"])).toThrow(Refused);
    expect(() => parseArgs(["--slug", "secm1-x", "--env-file", ".env"])).toThrow(Refused);
    expect(() => parseArgs(["--slug", "secm1-x", "--env-file", "some/dir/.env"])).toThrow(Refused);
    expect(() => parseArgs([])).toThrow(/--slug/);
    expect(() => parseArgs(["--slug", "Bad Slug"])).toThrow(Refused);
    expect(() => parseArgs(["--slug", "secm1-x", "--ids", "a,b"])).toThrow(/--confirm/);
    expect(parseArgs(["--slug", "secm1-x"])).toMatchObject({ slug: "secm1-x", confirm: false, varName: "TEST_DATABASE_URL" });
    expect(parseArgs(["--slug", "secm1-x", "--confirm", "--var", "RESTRICTED_DATABASE_URL", "--ids", "a,b"])).toMatchObject({
      confirm: true,
      varName: "RESTRICTED_DATABASE_URL",
      ids: ["a", "b"],
    });
  });

  it("libpq environment overrides are refused", () => {
    for (const k of ["PGHOST", "PGHOSTADDR", "PGOPTIONS", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSSLMODE", "PGSERVICE", "PGPASSFILE"]) {
      expect(() => refusePgEnvironment({ [k]: "x" } as unknown as NodeJS.ProcessEnv), k).toThrow(Refused);
    }
    expect(() => refusePgEnvironment({ PATH: "x", PGHOST: "" } as unknown as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("the pg config is explicit fields with TLS verification, never a connection string", () => {
    const c = clientConfig(url(`${TEST}-pooler${SUFFIX}`, "&sslmode=disable"));
    expect(c).not.toHaveProperty("connectionString");
    expect(c.ssl).toEqual({ rejectUnauthorized: true });
    expect(c.host).toBe(`${TEST}-pooler${SUFFIX}`);
    const src = fs.readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/connectionString/);
    expect(src).not.toMatch(/allowProduction\s*:/);
    expect(src).toMatch(/resolveDbTarget\(url, \{ expectHost: TEST_ENDPOINT_ID \}\)/);
  });

  it("output helpers: the address is masked and digested, never shown", () => {
    expect(maskEmail("secm1-owner@demo.matflow")).toBe("s***@demo.matflow");
    expect(maskEmail("ab@demo.matflow")).toBe("***@demo.matflow");
    expect(emailDigest("Secm1-Owner@demo.matflow")).toMatch(/^[0-9a-f]{12}$/);
    expect(emailDigest("Secm1-Owner@demo.matflow")).toBe(emailDigest("secm1-owner@demo.matflow"));
  });

  it("spawned: a production-shaped target is refused with exit 2 before any connection", () => {
    const r = run(["--slug", "secm1-x"], {}, url(`${PROD}-pooler${SUFFIX}.invalid`));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/REFUSED/);
    expect(r.stdout).not.toMatch(/target: TEST/);
  });

  it("spawned: PGHOST in the environment is refused with exit 2", () => {
    const r = run(["--slug", "secm1-x"], { PGHOST: `${PROD}${SUFFIX}.invalid` });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/PGHOST/);
  });

  it("spawned: --allow-production is refused with exit 2", () => {
    const r = run(["--slug", "secm1-x", "--allow-production", "--confirm"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown option --allow-production/);
  });
});
