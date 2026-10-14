/**
 * Security campaign lane E (9 Oct 2026): redacted secret scan (SEC-062).
 * Synthetic secrets are generated at run time (random, never real, never committed as literals).
 * Evidence: docs/security/evidence/E/E-06-secret-scan.md.
 */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import os from "node:os";
import { RULES, fingerprint, scanText, loadAllowlist, applyAllowlist } from "../../scripts/readiness/secret-scan.mjs";

const ROOT = path.resolve(__dirname, "../..");
const alnum = (n: number) => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from(randomBytes(n), (b) => chars[b % chars.length]).join("");
};
const join = (...parts: string[]) => parts.join("");

const SYNTHETIC: Array<[string, string]> = [
  ["stripe-live-secret", join("sk", "_live_", alnum(40))],
  ["stripe-test-secret", join("sk", "_test_", alnum(40))],
  ["stripe-webhook-secret", join("wh", "sec_", alnum(32))],
  ["resend-api-key", join("re", "_", alnum(8), "_", alnum(24))],
  ["vercel-blob-token", join("vercel_blob", "_rw_", alnum(16), "_", alnum(30))],
  ["aws-access-key-id", join("AK", "IA", alnum(16).toUpperCase().replace(/[^A-Z0-9]/g, "Q"))],
  ["github-token", join("gh", "p_", alnum(36))],
  ["google-oauth-client-secret", join("GOC", "SPX-", alnum(28))],
  ["anthropic-api-key", join("sk-", "ant-", alnum(40))],
  ["neon-password", join("np", "g_", alnum(14))],
  ["postgres-url-with-password", join("postgresql://app_user:", alnum(20), "@ep-sec-e-synthetic.eu-west-2.aws.neon.tech/db")],
  ["secret-env-assignment", join("NEXTAUTH", "_SECRET=", alnum(40))],
  ["private-key-block", join("-----BEGIN ", "PRIVATE KEY-----")],
  // Lane E3 (review R2 owed 3): names that were absent from the rule list.
  ["rls-context-signing-key", join("RLS_CONTEXT", "_SIGNING_KEY=", randomBytes(64).toString("hex"))],
  ["password-env-assignment", join("OPERATOR", "_PASSWORD=", alnum(20))],
  ["database-url-env-assignment", join("MIGRATION_DATABASE", "_URL=postgresql://neondb_owner:", alnum(9), "@ep-sec-e-synthetic.eu-west-2.aws.neon.tech/neondb")],
  // Lane F3 (SF-82 residual): the generic *_PASSWORD / *_SECRET / *_TOKEN rule; its own cells are in sec-f3-secret-scan-residuals.
  ["generic-secret-assignment", join("SMTP", "_PASSWORD=", alnum(20))],
];

const hex = (n: number) => randomBytes(n).toString("hex");
const kinds = (text: string) => scanText(text, "plant.txt").map((f: { rule: string; classification: string }) => `${f.rule}:${f.classification}`);

describe("lane E3: missing secret names and the placeholder test on the CAPTURED value (review R2 owed 3)", () => {
  it.each([
    ["RLS_CONTEXT_SIGNING_KEY (128 hex)", () => join("RLS_CONTEXT", "_SIGNING_KEY=", hex(64)), "rls-context-signing-key"],
    ["OPERATOR_PASSWORD", () => join("OPERATOR", "_PASSWORD=", alnum(20)), "password-env-assignment"],
    ["MATFLOW_PROD_PASSWORD", () => join("MATFLOW_PROD", "_PASSWORD=", alnum(14)), "password-env-assignment"],
    ["TEST_PASSWORD (quoted, JSON)", () => join('{"TEST', '_PASSWORD": "', alnum(12), '"}'), "password-env-assignment"],
    ["MIGRATION_DATABASE_URL with a short non-npg_ password", () => join("MIGRATION_DATABASE", "_URL=postgresql://neondb_owner:", alnum(5), "@ep-planted.eu-west-2.aws.neon.tech/neondb"), "database-url-env-assignment"],
    ["DATABASE_URL_DIRECT with a non-npg_ password", () => join("DATABASE", "_URL_DIRECT=postgres://app:", alnum(18), "@ep-planted.eu-west-2.aws.neon.tech/neondb"), "database-url-env-assignment"],
    ["a real-looking owner URL followed by '...'", () => join("MIGRATION_DATABASE", "_URL=postgresql://neondb_owner:", alnum(16), "@ep-planted.eu-west-2.aws.neon.tech/neondb... (see vault)"), "postgres-url-with-password"],
    ["a live key containing 'Fake'", () => join("sk", "_live_", alnum(10), "Fake", alnum(20)), "stripe-live-secret"],
    ["a live key containing 'abcdef'", () => join("sk", "_live_", alnum(12), "abcdef", alnum(18)), "stripe-live-secret"],
    ["a key assignment containing 'probe'", () => join("AUTH", "_SECRET=", alnum(14), "probe", alnum(16)), "secret-env-assignment"],
  ])("reports %s as a candidate", (_label, make, rule) => {
    const value = make();
    const findings = scanText(`${value}\n`, "plant.txt");
    const hit = findings.find((f: { rule: string; classification: string }) => f.rule === rule && f.classification === "candidate");
    expect(hit, `${rule} not reported as a candidate: ${kinds(value).join(",")}`).toBeTruthy();
    expect(JSON.stringify(findings)).not.toContain(value.slice(-10));
  });

  it.each([
    ["zero-padded Stripe test key", join("STRIPE", "_SECRET_KEY=sk", "_test_", "0".repeat(24))],
    ["low-entropy CRON_SECRET", join("CRON", "_SECRET=", "a".repeat(24))],
    ["localhost URL", "postgresql://postgres:postgres@localhost:5432/matflow"],
    ["${} interpolation", join("AUTH", "_SECRET=${AUTH_SECRET_FROM_VAULT}")],
    ["interpolated password variable", join("OPERATOR", "_PASSWORD: `lane-h-password-${STAMP}`")],
    ["process.env reference", join("const TEST", "_PASSWORD = process.env.E2E_PASSWORD")],
    ["placeholder URL password", join("MIGRATION_DATABASE", "_URL=postgresql://USER:PASSWORD@HOST/DB")],
    ["interpolated URL password", join("DATABASE", "_URL_DIRECT=postgresql://owner:${PW}@ep-x.eu-west-2.aws.neon.tech/db")],
    ["zero-padded RLS key", join("RLS_CONTEXT", "_SIGNING_KEY=", "0".repeat(127), "1")],
    ["replace-with assignment", join("AUTH", '_SECRET="replace-with-openssl-rand-base64-32"')],
  ])("negative control: %s is never a candidate", (_label, text) => {
    expect(kinds(text).filter((k: string) => k.endsWith(":candidate"))).toEqual([]);
  });
});

describe("scanText — every rule fires on a synthetic value and never echoes it", () => {
  for (const [rule, value] of SYNTHETIC) {
    it(rule, () => {
      const findings = scanText(`const x = "${value}";\n`, "synthetic.ts");
      const hit = findings.find((f: { rule: string }) => f.rule === rule);
      expect(hit, `rule ${rule} did not fire`).toBeTruthy();
      expect(hit!.classification).toBe("candidate");
      expect(JSON.stringify(findings)).not.toContain(value.slice(-12));
    });
  }

  it("every declared rule has a synthetic case", () => {
    const covered = new Set(SYNTHETIC.map(([r]) => r));
    const untested = RULES.map((r: { id: string }) => r.id).filter(
      (id: string) => !covered.has(id) && !["jwt", "sentry-auth-token", "stripe-live-key-fragment", "secret-name-table-value"].includes(id),
    );
    expect(untested).toEqual([]);
  });

  it("fingerprints are stable 12-hex digests (correlation without disclosure)", () => {
    expect(fingerprint("abc")).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint("abc")).toBe(fingerprint("abc"));
  });
});

describe("placeholders are classified, not hidden", () => {
  it("localhost URLs and replace-with values are placeholders (negative control)", () => {
    const f = scanText(
      'DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"\nAUTH_SECRET="replace-with-openssl-rand-base64-32"\n',
      ".env.example",
    );
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((x: { classification: string }) => x.classification === "placeholder")).toBe(true);
  });

  it("low-entropy assignments do not fire", () => {
    expect(scanText("CRON_SECRET=aaaaaaaaaaaaaaaaaaaaaaaa\n", "x").filter((x: { rule: string }) => x.rule === "secret-env-assignment")).toEqual([]);
  });
});

describe("the fail-closed allowlist (external review of PR #30, 14 Oct 2026)", () => {
  it("the committed allowlist file is well-formed and every entry names a real rule", () => {
    const list = loadAllowlist(ROOT);
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(1); // exactly the documented demo-seed entry
    expect(list[0].fingerprint).toBe("b94e8093ff12");
    expect(list[0].path).toBe("scripts/seed-demo-rich.mjs");
  });

  it("a malformed allowlist is a hard error, never a silent skip", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-e-allow-"));
    fs.mkdirSync(path.join(dir, "scripts", "readiness"), { recursive: true });
    const file = path.join(dir, "scripts", "readiness", "secret-scan-allowlist.json");
    for (const bad of [
      "{ not json",
      JSON.stringify({ fingerprint: "b94e8093ff12" }), // not an array
      JSON.stringify([{ fingerprint: "nope", rule: "generic-secret-assignment", path: "x", reason: "a reason long enough to pass", addedOn: "2026-10-14" }]),
      JSON.stringify([{ fingerprint: "b94e8093ff12", rule: "no-such-rule", path: "x", reason: "a reason long enough to pass", addedOn: "2026-10-14" }]),
      JSON.stringify([{ fingerprint: "b94e8093ff12", rule: "generic-secret-assignment", path: "x", reason: "too short", addedOn: "2026-10-14" }]),
      JSON.stringify([{ fingerprint: "b94e8093ff12", rule: "generic-secret-assignment", path: "x", reason: "a reason long enough to pass", addedOn: "14/10/2026" }]),
      JSON.stringify([{ fingerprint: "b94e8093ff12", rule: "generic-secret-assignment", path: "x", reason: "a reason long enough to pass", addedOn: "2026-10-14", extra: 1 }]),
    ]) {
      fs.writeFileSync(file, bad);
      expect(() => loadAllowlist(dir), bad.slice(0, 40)).toThrow(/fail closed/);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an entry downgrades ONLY its exact (fingerprint, rule, path) triple; a genuine secret beside it still fails", () => {
    // Synthetic candidate values, assembled so this source file never contains them.
    const demoish = ["DEMO", "_PASSWORD = \"", "Zq", "7", "wXk", "3", "pR", "9", "tY", "\""].join("");
    const neighbour = ["SMTP", "_PASSWORD = \"", "Vb", "8", "nQj", "2", "sL", "6", "uE", "\""].join("");
    const text = `${demoish}
${neighbour}
`;
    const findings = scanText(text, "scripts/seed-demo-rich.mjs");
    const cands = findings.filter((f) => f.classification === "candidate");
    expect(cands.length).toBe(2);
    const entry = { fingerprint: cands[0].fingerprint, rule: cands[0].rule, path: "scripts/seed-demo-rich.mjs", reason: "canary entry for this test, long enough", addedOn: "2026-10-14" };
    const used = applyAllowlist(findings, [entry]);
    expect(used.has(0)).toBe(true);
    const after = findings.filter((f) => f.classification === "candidate");
    expect(after.length).toBe(1); // the neighbour STILL fails
    expect(after[0].fingerprint).not.toBe(entry.fingerprint);
    // wrong path or wrong rule never matches
    const f2 = scanText(text, "scripts/other.mjs");
    expect(applyAllowlist(f2, [entry]).size).toBe(0);
  });
});

describe("repository tree (tracked files at HEAD)", () => {
  // 14 Oct 2026 (fix/secrets-fixtures): the four secret-shaped test fixtures
  // were replaced with placeholder-marked values of the same shape, so the
  // scan classifies them placeholder. The one remaining accepted candidate is
  // the deliberately public demo-seed password, carried by the fail-closed
  // allowlist file (scripts/readiness/secret-scan-allowlist.json) - this test
  // accepts exactly what that file accepts, so the two can never drift.
  const KNOWN_FIXTURE_FINGERPRINTS = new Set(loadAllowlist(ROOT).map((e) => `${e.fingerprint}@${e.path}`));

  // ~1 s alone; R2 saw it exceed the 30 s default with 7 files in parallel (lane E3: explicit 180 s budget).
  it("contains no candidate secret beyond the documented fixtures", { timeout: 180_000 }, () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 1 << 28 })
      .toString()
      .split("\0")
      .filter(Boolean)
      .filter((f) => !f.startsWith("tests/unit/sec-e-"));
    const unknown: string[] = [];
    for (const rel of files) {
      const abs = path.join(ROOT, rel);
      let body: Buffer;
      try {
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
        body = fs.readFileSync(abs);
      } catch {
        continue;
      }
      if (body.subarray(0, 8000).includes(0)) continue;
      for (const f of scanText(body.toString("utf8"), rel)) {
        if (f.classification === "candidate" && !KNOWN_FIXTURE_FINGERPRINTS.has(`${f.fingerprint}@${rel}`)) {
          unknown.push(`${f.rule} ${f.location}:${f.line} fp=${f.fingerprint}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});
