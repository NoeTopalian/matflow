/**
 * SF-129 — rotation-tool hardening (security campaign iteration 2, lane M2, 10 Oct 2026; authorised by Noe 10 Oct
 * 23:29 Italy). Residuals R8 found in the TEST-only tool scripts/readiness/demo-accounts-rotate.mjs and the shared
 * guard scripts/readiness/db-target.mjs:
 *  (a) the .env refusal compared the basename case-sensitively, so `--env-file <dir>/.ENV` read `.env` on Windows;
 *      it now refuses case-insensitively, by real path, and by file identity (a link to .env under another name);
 *  (b) --ids was optional with --confirm; a confirm now needs the ids a dry run printed (exit 2, nothing changed);
 *  (c) db-target did not look at the password field, where Neon also accepts its `endpoint=<id>$<password>` routing
 *      form; one new refusal;
 *  (d) the tool's own libpq-variable check missed lower-case names;
 *  (e) the output and the audit row carried the first character of the local part and an unsalted 12-hex SHA-256 of
 *      the address (guessable for demo addresses); now the domain only and an HMAC under a random per-run key that
 *      is never printed or stored.
 * No database and no network: every spawned run reads a synthetic env file whose host ends in `.invalid` (RFC 6761).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, it, expect, afterAll } from "vitest";
import {
  parseArgs,
  refusePgEnvironment,
  refuseProductionEnvFile,
  maskEmail,
  emailDigest,
  Refused,
} from "../../scripts/readiness/demo-accounts-rotate.mjs";
import { resolveDbTarget, TargetRefused } from "../../scripts/readiness/db-target.mjs";

const SCRIPT = path.join(process.cwd(), "scripts/readiness/demo-accounts-rotate.mjs");
const PROD = "ep-bold-wave-abt39t7x";
const TEST = "ep-hidden-salad-abom7cg4";
const SUFFIX = ".eu-west-2.aws.neon.tech";
// Synthetic credentials built at runtime (the tree secret scan must never see a literal one); never sent anywhere.
const FIX_USER = "secm2";
const FIX_PASS = "fixture-" + "m".repeat(16);
const url = (host: string, pass = FIX_PASS) => `postgresql://${FIX_USER}:${pass}@${host}/neondb?sslmode=require`;
const INVALID_TEST_URL = url(`${TEST}-pooler${SUFFIX}.invalid`);

const dirs: string[] = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "secm2-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A temp dir holding a synthetic `.env` (never the repo's) with an unresolvable TEST-shaped URL. */
function fakeDotEnvDir() {
  const d = tmp();
  fs.writeFileSync(path.join(d, ".env"), `TEST_DATABASE_URL="${INVALID_TEST_URL}"\n`);
  return d;
}

function spawnTool(args: string[], env: Record<string, string> = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^PG[A-Z]/i.test(k)));
  // "--" before the script: Node >=20 consumes `--env-file` anywhere in argv as its own flag and exits 9 on a missing
  // file before the script runs; "--" hands everything after it to the script (so the tool's own refusal is reached).
  return spawnSync(process.execPath, ["--", SCRIPT, ...args], {
    env: { ...clean, ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
}

const CAN_SYMLINK = (() => {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, "t"), "");
    fs.symlinkSync(path.join(d, "t"), path.join(d, "l"), "file");
    return true;
  } catch {
    return false; // Windows without Developer Mode: EPERM
  }
})();

describe("SF-129 (a): the env file can never be .env", () => {
  it("parseArgs refuses .env in any letter case (and Windows trailing dots/spaces or a stream suffix)", () => {
    for (const f of [".ENV", ".Env", "some/dir/.eNv", ".env.", ".env ", ".env::$DATA"]) {
      expect(() => parseArgs(["--slug", "secm2-x", "--env-file", f]), f).toThrow(Refused);
    }
    // Positive control: the intended file and other names pass the name check.
    expect(parseArgs(["--slug", "secm2-x", "--env-file", ".env.test"]).envFile).toBe(".env.test");
    expect(parseArgs(["--slug", "secm2-x", "--env-file", "x/secm2.env"]).envFile).toBe("x/secm2.env");
  });

  it("by real path: a name that resolves to .env is refused (injected resolver: a symlink called secm2.env)", () => {
    const d = fakeDotEnvDir();
    const link = path.join(d, "secm2.env");
    const realpath = (p: string) => (p === link ? path.join(d, ".env") : p);
    expect(() => refuseProductionEnvFile(link, { realpath, productionEnvPaths: [] })).toThrow(/resolves to \.env/);
  });

  it.skipIf(!CAN_SYMLINK)("by real path: a real file symlink to .env is refused", () => {
    const d = fakeDotEnvDir();
    const link = path.join(d, "secm2-link.env");
    fs.symlinkSync(path.join(d, ".env"), link, "file");
    expect(() => refuseProductionEnvFile(link, { productionEnvPaths: [] })).toThrow(Refused);
  });

  it("by file identity: a hard link to the production .env under another name is refused", () => {
    const d = fakeDotEnvDir();
    const hard = path.join(d, "secm2-hard.env");
    fs.linkSync(path.join(d, ".env"), hard);
    expect(() => refuseProductionEnvFile(hard, { productionEnvPaths: [path.join(d, ".env")] })).toThrow(/same file as \.env/);
  });

  it("positive control: an ordinary env file is admitted and its real path returned", () => {
    const d = tmp();
    const f = path.join(d, "secm2.env");
    fs.writeFileSync(f, `TEST_DATABASE_URL="${INVALID_TEST_URL}"\n`);
    expect(path.basename(refuseProductionEnvFile(f, { productionEnvPaths: [path.join(fakeDotEnvDir(), ".env")] }))).toBe("secm2.env");
  });

  it("spawned: --env-file <dir>/.ENV exits 2 with the .env refusal, before reading or connecting", () => {
    const d = fakeDotEnvDir();
    const r = spawnTool(["--slug", "secm2-x", "--env-file", path.join(d, ".ENV")]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/REFUSED: .*\.env/);
    expect(r.stderr).not.toMatch(/allowlisted|host/);
    expect(r.stdout).not.toMatch(/target:/);
  });

  it("spawned, Linux order: a NON-EXISTENT <dir>/.ENV is refused by name (exit 2) before any existence check or read", () => {
    const r = spawnTool(["--slug", "secm2-x", "--env-file", path.join(tmp(), "no-such-dir", ".ENV")]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/REFUSED: \.env holds the production credentials/);
    expect(r.stderr).not.toMatch(/does not exist/);
  });
});

describe("SF-129 (b): --confirm requires --ids", () => {
  it("parseArgs: confirm without ids is refused; with ids it parses; ids without confirm is still refused", () => {
    expect(() => parseArgs(["--slug", "secm2-x", "--confirm"])).toThrow(/--ids/);
    expect(parseArgs(["--slug", "secm2-x", "--confirm", "--ids", "a,b"])).toMatchObject({ confirm: true, ids: ["a", "b"] });
    expect(() => parseArgs(["--slug", "secm2-x", "--ids", "a"])).toThrow(/--confirm/);
    expect(parseArgs(["--slug", "secm2-x"])).toMatchObject({ confirm: false, ids: null });
  });

  it("spawned: --confirm without --ids exits 2 and never reaches the target", () => {
    const d = tmp();
    const f = path.join(d, "secm2.env");
    fs.writeFileSync(f, `TEST_DATABASE_URL="${INVALID_TEST_URL}"\n`);
    const r = spawnTool(["--slug", "secm2-x", "--env-file", f, "--confirm"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--confirm requires --ids/);
    expect(r.stdout).not.toMatch(/target:/);
  });
});

describe("SF-129 (c): db-target refuses Neon's endpoint= routing form in the password", () => {
  const host = `${TEST}-pooler${SUFFIX}`;
  it("refused: endpoint=<prod>$pw, endpoint=<id>;pw, upper case, percent-encoded", () => {
    for (const pw of [`endpoint=${PROD}$${FIX_PASS}`, `endpoint=${PROD};${FIX_PASS}`, `ENDPOINT=${PROD}$${FIX_PASS}`, `endpoint%3D${PROD}%24${FIX_PASS}`]) {
      expect(() => resolveDbTarget(url(host, pw), { expectHost: "ep-hidden-salad" }), pw.slice(0, 12)).toThrow(TargetRefused);
      expect(() => resolveDbTarget(url(host, pw), { expectHost: "ep-hidden-salad" })).toThrow(/endpoint=/);
    }
  });
  it("positive control: an ordinary password, and one merely containing the word, are admitted", () => {
    expect(resolveDbTarget(url(host), { expectHost: "ep-hidden-salad" })).toBe(host);
    expect(resolveDbTarget(url(host, `x-endpoint=${FIX_PASS}`), { expectHost: "ep-hidden-salad" })).toBe(host);
  });
});

describe("SF-129 (d): the tool's own libpq check is case-insensitive", () => {
  it("lower- and mixed-case PG* names are refused; empty values and unrelated names are not", () => {
    for (const k of ["pgoptions", "pghost", "PgHostAddr", "pGpassword", "pgservice"]) {
      expect(() => refusePgEnvironment({ [k]: "x" } as unknown as NodeJS.ProcessEnv), k).toThrow(Refused);
    }
    expect(() => refusePgEnvironment({ PATH: "x", pghost: "", PAGER: "less" } as unknown as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe("SF-129 (e): nothing guessable about the address leaves the tool", () => {
  const email = "secm2-owner@demo.matflow";
  const unsalted = createHash("sha256").update(email).digest("hex").slice(0, 12);

  it("the mask is the domain only: no character of the local part", () => {
    expect(maskEmail(email)).toBe("***@demo.matflow");
    expect(maskEmail("Ab@Demo.Matflow")).toBe("***@demo.matflow");
    expect(maskEmail(email)).not.toContain("s***");
  });

  it("the digest is keyed: no key → refused; never the unsalted SHA-256; a different key → a different tag", () => {
    expect(() => emailDigest(email)).toThrow();
    const k1 = Buffer.alloc(32, 1);
    const k2 = Buffer.alloc(32, 2);
    expect(emailDigest(email, k1)).toMatch(/^[0-9a-f]{12}$/);
    expect(emailDigest(email, k1)).not.toBe(unsalted);
    expect(emailDigest(email, k1)).not.toBe(emailDigest(email, k2));
    expect(emailDigest("SECM2-Owner@demo.matflow ", k1)).toBe(emailDigest(email, k1));
  });

  it("static: the tool no longer computes an unsalted digest, keys the tag per run, and never prints the key", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/createHash\(/);
    expect(src).toMatch(/createHmac\("sha256"/);
    expect(src).toMatch(/randomBytes\(32\)/);
    // The run key is used ONLY as emailDigest's key argument: never printed, stored or passed anywhere else.
    const uses = src.match(/run\.key/g) ?? [];
    const asDigestKey = src.match(/emailDigest\(c\.email, run\.key\)/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.length).toBe(asDigestKey.length);
  });
});
