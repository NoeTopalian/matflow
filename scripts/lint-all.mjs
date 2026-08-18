#!/usr/bin/env node
/**
 * Runs BOTH lint gates and fails if either does.
 *
 * This used to be `eslint && node scripts/check-ui-rules.mjs`. Under `&&` a
 * single eslint error short-circuits the chain, so the UI-RULES ratchet never
 * executes — which is exactly what happened on feat/dashboard-desktop-system:
 * one react-hooks error silently disabled the whole of UI-RULES §11 enforcement
 * while `docs/UI-RULES.md` §0.2 still claimed `npm run lint` enforced it.
 *
 * Reordering would only swap which gate holds the other hostage, so both run
 * unconditionally and their exit codes are aggregated.
 */
import { spawnSync } from "node:child_process";

const GATES = [
  { name: "eslint", cmd: "npx", args: ["eslint"] },
  { name: "ui-rules ratchet", cmd: "node", args: ["scripts/check-ui-rules.mjs"] },
];

const failed = [];

for (const gate of GATES) {
  console.log(`\n=== ${gate.name} ===`);
  const result = spawnSync(gate.cmd, gate.args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  const code = result.status ?? 1;
  if (code !== 0) failed.push(`${gate.name} (exit ${code})`);
}

if (failed.length > 0) {
  console.error(`\nLint FAILED: ${failed.join(", ")}`);
  process.exit(1);
}

console.log("\nLint passed: eslint clean, UI-RULES ratchet at or below baseline.");
