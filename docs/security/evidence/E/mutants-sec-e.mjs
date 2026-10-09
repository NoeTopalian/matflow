// Mutation check for lane E guards: apply one mutant at a time, run the two sec-e test files, restore.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const repo = "C:/Users/NoeTo/Desktop/matflow";
const SC = `${repo}/scripts/readiness/supply-chain-check.mjs`;
const AI = `${repo}/scripts/readiness/asset-inventory.mjs`;
const SS = `${repo}/scripts/readiness/secret-scan.mjs`;
const mutants = [
  ["M1 mysql2 dropped from BUILD_CHAIN_ONLY", SC, '["mysql2", "postgres"', '["postgres"'],
  ["M2 install-script allowlist check removed", SC, "if (!INSTALL_SCRIPT_ALLOWLIST.has(name)) violations.push", "if (false) violations.push"],
  ["M3 registry host check removed", SC, "if (!resolved.startsWith(ALLOWED_REGISTRY)) violations", "if (false) violations"],
  ["M4 exception never expires", SC, "exceptions.filter((e) => e.expires >= today)", "exceptions.filter(() => true)"],
  ["M5 every finding classified placeholder", SS, 'classification: isPlaceholder(m[0]) ? "placeholder" : "candidate"', 'classification: "placeholder"'],
  ["M6 value leaked into finding", SS, "fingerprint: fingerprint(value),", "fingerprint: fingerprint(value), value,"],
  ["M7 neon-password rule disabled", SS, String.raw`re: /\bnpg_[0-9A-Za-z]{12,}\b/g`, "re: /(?!)/g"],
  ["M8 dynamic import not matched", SC, "|\\bimport\\s*\\(\\s*", ""],
  ["M9 cron marker regex broken", AI, '["cronSecret", /CRON_SECRET/]', '["cronSecret", /(?!)/]'],
  ["M10 operator marker regex broken", AI, '["operator", /getOperatorContext|verifyOperatorSession|requireOperator|withOperator|isAdminAuthed|checkOperatorSession|isAdminPageAuthed|resolveOperatorFromCookie/]', '["operator", /(?!)/]'],
];
const results = [];
for (const [name, file, from, to] of mutants) {
  const orig = fs.readFileSync(file, "utf8");
  if (!orig.includes(from)) { results.push(`${name}: MUTANT NOT APPLIED (pattern missing)`); continue; }
  fs.writeFileSync(file, orig.replace(from, to));
  try {
    const r = spawnSync("npx", ["vitest", "run", "tests/unit/sec-e-supply-chain.test.ts", "tests/unit/sec-e-secret-scan.test.ts", "tests/unit/sec-e-asset-inventory.test.ts"], { cwd: repo, shell: true, encoding: "utf8" });
    const failed = /Tests\s+(\d+) failed/.exec(r.stdout + r.stderr);
    results.push(`${name}: exit=${r.status} ${failed ? `KILLED (${failed[1]} failed)` : "SURVIVED"}`);
  } finally {
    fs.writeFileSync(file, orig);
  }
}
console.log(results.join("\n"));
