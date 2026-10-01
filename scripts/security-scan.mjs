#!/usr/bin/env node
/**
 * Security SAST ratchet (Semgrep).
 *
 * Runs Semgrep with a fixed set of community rulesets over the application
 * source and compares the finding counts, by severity, against the BASELINE
 * in scripts/security-baseline.json.
 *
 *  - A count ABOVE its baseline fails the build (exit 1) and lists the new
 *    findings (rule, file, line).
 *  - A count BELOW its baseline prints a win and tells you to lower the
 *    baseline in the same PR to lock it in.
 *  - ERROR-severity findings are held at zero: any ERROR fails, full stop.
 *
 * Counts may only go down. Mirrors scripts/check-ui-rules.mjs.
 *
 * Rulesets (community, no login): p/owasp-top-ten, p/nextjs, p/typescript,
 * p/javascript, p/react, p/secrets. Rules are fetched from the Semgrep
 * registry at run time, so the scan needs network. A registry/engine failure
 * is a hard error — it never silently passes.
 *
 * Tools: https://github.com/semgrep/semgrep-rules (+ p/owasp-top-ten packs).
 * Install: `pip install semgrep` (CI) or `py -3.12 -m pip install --user semgrep`.
 * Override the binary with SEMGREP_CMD if it is not on PATH.
 *
 * Usage:
 *   node scripts/security-scan.mjs          # scan + gate against the baseline
 *   node scripts/security-scan.mjs --init   # write the baseline from this scan
 *   node scripts/security-scan.mjs --json <path>   # gate a scan already on disk
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CONFIGS = [
  "p/owasp-top-ten",
  "p/nextjs",
  "p/typescript",
  "p/javascript",
  "p/react",
  "p/secrets",
];
const TARGETS = ["app", "lib", "components", "auth.ts", "proxy.ts", "scripts"];
const BASELINE_FILE = join("scripts", "security-baseline.json");
const SEVERITIES = ["ERROR", "WARNING", "INFO"];

function findSemgrep() {
  if (process.env.SEMGREP_CMD) return process.env.SEMGREP_CMD;
  const candidates = [
    "semgrep",
    join(
      process.env.APPDATA ?? "",
      "Python",
      "Python312",
      "Scripts",
      "semgrep.exe",
    ),
  ];
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8", shell: false });
    if (r.status === 0) return c;
  }
  return "semgrep";
}

function runScan() {
  const out = join(mkdtempSync(join(tmpdir(), "semgrep-")), "results.json");
  const semgrep = findSemgrep();
  const args = [
    "scan",
    "--quiet",
    "--metrics=off",
    "--json",
    "--output",
    out,
    ...CONFIGS.flatMap((c) => ["--config", c]),
    ...TARGETS,
  ];
  console.log(`Running: ${semgrep} scan --config ${CONFIGS.join(",")} ${TARGETS.join(" ")}`);
  // shell:false — semgrep is resolved to an absolute binary (or a bare name on
  // PATH in CI), and the args are fixed constants, so no shell is needed and we
  // avoid Node's DEP0190 arg-injection warning (fitting for a security script).
  const r = spawnSync(semgrep, args, {
    stdio: ["ignore", "inherit", "inherit"],
    shell: false,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  // Semgrep exits 1 when it finds matches; that is NOT a run failure. A real
  // run failure (no rules, engine crash, bad config) does not write the file.
  if (!existsSync(out)) {
    console.error(
      `\nSemgrep did not produce results (exit ${r.status}). Is it installed and online?\n` +
        `Install: pip install semgrep  —  or set SEMGREP_CMD to the binary.`,
    );
    process.exit(2);
  }
  return out;
}

function summarise(jsonPath) {
  const data = JSON.parse(readFileSync(jsonPath, "utf8"));
  if (Array.isArray(data.errors) && data.errors.some((e) => e.level === "error")) {
    const fatal = data.errors.filter((e) => e.level === "error");
    console.error(`\nSemgrep reported ${fatal.length} engine/config error(s):`);
    for (const e of fatal.slice(0, 5)) console.error(`  - ${e.message?.slice(0, 200)}`);
    process.exit(2);
  }
  const counts = { ERROR: 0, WARNING: 0, INFO: 0, total: 0 };
  const findings = [];
  for (const f of data.results ?? []) {
    const sev = (f.extra?.severity ?? "INFO").toUpperCase();
    if (!SEVERITIES.includes(sev)) continue;
    counts[sev] += 1;
    counts.total += 1;
    findings.push({
      sev,
      rule: f.check_id,
      path: f.path,
      line: f.start?.line,
      msg: (f.extra?.message ?? "").slice(0, 120),
    });
  }
  return { counts, findings };
}

function main() {
  const argv = process.argv.slice(2);
  const jsonFlag = argv.indexOf("--json");
  const jsonPath = jsonFlag >= 0 ? argv[jsonFlag + 1] : runScan();
  const { counts, findings } = summarise(jsonPath);

  console.log(
    `\nSemgrep findings: ERROR ${counts.ERROR} · WARNING ${counts.WARNING} · INFO ${counts.INFO} · total ${counts.total}`,
  );

  if (argv.includes("--init")) {
    writeFileSync(BASELINE_FILE, JSON.stringify(counts, null, 2) + "\n");
    console.log(`\nBaseline written to ${BASELINE_FILE}.`);
    return;
  }

  if (!existsSync(BASELINE_FILE)) {
    console.error(`\nNo ${BASELINE_FILE}. Run \`node scripts/security-scan.mjs --init\` once to set it.`);
    process.exit(2);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));

  const failures = [];
  // ERROR is held at zero regardless of the baseline.
  if (counts.ERROR > 0) failures.push(`ERROR findings must be 0, found ${counts.ERROR}`);
  for (const sev of SEVERITIES) {
    if (counts[sev] > (baseline[sev] ?? 0)) {
      failures.push(`${sev} rose ${baseline[sev] ?? 0} → ${counts[sev]}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\nSecurity scan FAILED:\n  ${failures.join("\n  ")}`);
    const worst = findings
      .filter((f) => f.sev === "ERROR" || f.sev === "WARNING")
      .slice(0, 40);
    console.error(`\nTop findings:`);
    for (const f of worst) console.error(`  [${f.sev}] ${f.path}:${f.line} ${f.rule}`);
    process.exit(1);
  }

  const wins = SEVERITIES.filter((s) => counts[s] < (baseline[s] ?? 0));
  if (wins.length > 0) {
    console.log(
      `\nBelow baseline on ${wins.join(", ")} — lower these in ${BASELINE_FILE} to lock the win.`,
    );
  }
  console.log("\nSecurity scan passed: at or below baseline, zero ERROR.");
}

main();
