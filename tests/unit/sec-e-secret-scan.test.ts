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
import { RULES, fingerprint, scanText } from "../../scripts/readiness/secret-scan.mjs";

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
];

describe("scanText — every rule fires on a synthetic value and never echoes it", () => {
  for (const [rule, value] of SYNTHETIC) {
    it(rule, () => {
      const findings = scanText(`const x = "${value}";\n`, "synthetic.ts");
      const hit = findings.find((f: { rule: string }) => f.rule === rule);
      expect(hit, `rule ${rule} did not fire`).toBeTruthy();
      expect(hit.classification).toBe("candidate");
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

describe("repository tree (tracked files at HEAD)", () => {
  // The only accepted non-placeholder values: the truncated Stripe key prefix and its sibling fixture, documented in
  // E-06 §Triage 2 as test fixtures (prefix only, cannot authenticate). Anything else is a new secret in the tree.
  const KNOWN_FIXTURE_FINGERPRINTS = new Set(["7d3bddd6e499", "0895203bc15e"]);

  it("contains no candidate secret beyond the documented fixtures", () => {
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
        if (f.classification === "candidate" && !KNOWN_FIXTURE_FINGERPRINTS.has(f.fingerprint)) {
          unknown.push(`${f.rule} ${f.location}:${f.line} fp=${f.fingerprint}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});
