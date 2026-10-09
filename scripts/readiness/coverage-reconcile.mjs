// Reconciles docs/security/COVERAGE-MATRIX.md (security campaign; iteration 2, lanes lead + F2, 9 Oct 2026).
//
//   node scripts/readiness/coverage-reconcile.mjs [--require-reviewed] [--list] [--matrix=<path>] [--findings=<path>]
//
// Every SEC-001..096 must be present exactly once with the header's column count. Applicability and verification are
// SEPARATE dimensions, each classified from its own cell by an explicit, ordered vocabulary (no substring guessing):
//   1. strip markdown emphasis; take the FINAL state — the text after the last "→" (a history like
//      "FAIL → FIXED AWAITING RETEST" is classified by where it ended, and remembers that it passed through FIXED);
//   2. split that state on top-level " / " (outside parentheses) into alternatives — "PASS (config) / BLOCKED (live)"
//      is TWO verdicts and the row takes the WORST of them (FAIL < BLOCKED < UNKNOWN < NOT RUN < PARTIAL <
//      FIXED AWAITING RETEST < PASS);
//   3. drop a leading finding id ("SF-26 ", "AH-C2 ") and match the alternative's LEADING words against TOKENS
//      below. Anything not matched is UNPARSED and fails the run (exhaustive by construction).
// Qualifiers after the leading words ("PASS (C); browser NOT RUN") never change the class; rows carrying such
// residual qualifiers are counted separately so they are not mistaken for clean passes.
// --require-reviewed: a row whose final state is FIXED (or PASS reached through FIXED) counts as PASS only when the
//   Reviewer column names an approval ("approved", not "not approved" / "reviewed"); otherwise it stays
//   FIXED AWAITING RETEST. Without the flag FIXED rows are never counted as PASS.
// Consistency: a "guard test" (N/A) verification must sit on a NOT APPLICABLE WITH EVIDENCE row, and vice versa.
// The findings ledger (FINDINGS.md) is checked for unique ids and well-formed rows (cell count = its table header);
// those problems are reported and, with --findings-strict, fail the run.
// Exit 1 on any missing / duplicated / malformed / UNPARSED / inconsistent matrix row. Prints one JSON line (and the
// per-row classification with --list).
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const TOKENS = [
  ["FIXED AWAITING RETEST", "FIXED AWAITING RETEST"],
  ["PARTIALLY FIXED", "PARTIAL"],
  ["NOT RUN", "NOT RUN"],
  ["DOCUMENTED ONLY", "NOT RUN"],
  ["TEST PASS", "PASS"],
  ["PASS", "PASS"],
  ["FAIL", "FAIL"],
  ["OPEN", "FAIL"],
  ["CONFIRMED", "FAIL"],
  ["FIXED", "FIXED AWAITING RETEST"],
  ["BLOCKED", "BLOCKED"],
  ["UNKNOWN", "UNKNOWN"],
  ["GUARD TEST", "N/A (guard test)"],
];
const RANK = { FAIL: 0, BLOCKED: 1, UNKNOWN: 2, "NOT RUN": 3, PARTIAL: 4, "FIXED AWAITING RETEST": 5, PASS: 6, "N/A (guard test)": 7 };
const RESIDUAL = /\b(NOT RUN|UNKNOWN|BLOCKED|OPEN|FAIL|PARTIAL|NOT AUTHORI[SZ]ED)\b/;

function splitTopLevel(s, sep) {
  const out = []; let depth = 0, cur = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && s.startsWith(sep, i)) { out.push(cur); cur = ""; i += sep.length - 1; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Classify one verification cell. Returns { cls, viaFixed, residual, alternatives } or cls "UNPARSED". */
export function classifyVerification(cell) {
  const text = String(cell ?? "").replace(/\*\*/g, "").trim();
  const headToken = (s) => {
    const head = s.replace(/^((SF|AH)-[\w-]+\s+)+/i, "").toUpperCase();
    const hit = TOKENS.find(([t]) => head.startsWith(t) && !/[A-Z]/.test(head.charAt(t.length)));
    return hit ? hit[1] : null;
  };
  // "→" is a state transition only when the text after it starts with a status ("FAIL → FIXED AWAITING RETEST");
  // otherwise it is a cross-reference ("transfer → SEC-032", "other routes → lane C") and stays in the text.
  const parts = splitTopLevel(text, "→");
  const states = [];
  for (const p of parts) {
    if (states.length === 0 || headToken(p)) states.push(p);
    else states[states.length - 1] += ` → ${p}`;
  }
  const final = states.at(-1) ?? "";
  const viaFixed = states.slice(0, -1).some((h) => /\bFIXED\b/i.test(h)) || /^\s*((SF|AH)-[\w-]+\s+)?FIXED\b/i.test(final);
  // Each alternative is classified by its leading words; an alternative that names a scope first ("fuzz NOT RUN",
  // "browser NOT RUN") is classified by the first status word written in capitals inside it.
  const alternatives = splitTopLevel(final, " / ").map((alt) => {
    const h = headToken(alt);
    if (h) return h;
    let best = null;
    for (const [t, c] of TOKENS) {
      const i = alt.search(new RegExp(`\\b${t.replace(/ /g, "\\s+")}\\b`));
      if (i >= 0 && (best === null || i < best.i)) best = { i, c };
    }
    return best ? best.c : "UNPARSED";
  });
  if (alternatives.length === 0 || alternatives.includes("UNPARSED")) return { cls: "UNPARSED", viaFixed, residual: false, alternatives };
  const cls = alternatives.reduce((w, a) => (RANK[a] < RANK[w] ? a : w), alternatives[0]);
  const lead = (final.match(/^[^(;—–]*/) ?? [""])[0];
  const residual = RESIDUAL.test(final.slice(lead.length).toUpperCase()) || alternatives.length > 1;
  return { cls, viaFixed, residual, alternatives };
}

export function classifyApplicability(a) {
  const A = String(a ?? "").replace(/\*\*/g, "").trim().toUpperCase();
  if (A.startsWith("NOT APPLICABLE")) return "NOT APPLICABLE WITH EVIDENCE";
  if (A.startsWith("UNKNOWN")) return "UNKNOWN";
  if (A.startsWith("APPLICABLE")) return "APPLICABLE";
  return "UNPARSED";
}

export function reviewerApproved(r) {
  const R = String(r ?? "");
  return /\bapproved\b/i.test(R) && !/\bnot approved\b/i.test(R);
}

const cellsOf = (line) => line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

/** Pure reconciliation of the matrix text (unit-tested in tests/unit/sec-f2-coverage-reconcile.test.ts). */
export function reconcileMatrix(src, { requireReviewed = false, expectedCount = 96 } = {}) {
  const lines = src.split(/\r?\n/);
  const header = lines.find((l) => /^\|\s*ID\s*\|/.test(l));
  const width = header ? cellsOf(header).length : 11;
  const rows = lines.filter((l) => l.startsWith("| SEC-"));
  const cells = rows.map(cellsOf);
  const ids = cells.map((c) => c[0]);
  const expected = Array.from({ length: expectedCount }, (_, i) => `SEC-${String(i + 1).padStart(3, "0")}`);
  const missing = expected.filter((id) => !ids.includes(id));
  const dups = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  const unexpected = ids.filter((id) => !expected.includes(id));
  const malformed = cells.filter((c) => c.length !== width).map((c) => `${c[0]} (${c.length} cells, header ${width})`);
  const app = {}, ver = {}, unparsed = [], inconsistent = [], perRow = [];
  let residualRows = 0, fixedCountedAsPass = 0, fixedAwaitingApproval = 0;
  for (const c of cells) {
    const a = classifyApplicability(c[6]);
    const v = classifyVerification(c[7]);
    const approved = reviewerApproved(c[9]);
    let cls = v.cls;
    if (cls === "PASS" && v.viaFixed && requireReviewed && !approved) { cls = "FIXED AWAITING RETEST"; }
    if (cls === "FIXED AWAITING RETEST" && requireReviewed) {
      if (approved) { cls = "PASS"; fixedCountedAsPass += 1; } else fixedAwaitingApproval += 1;
    }
    app[a] = (app[a] ?? 0) + 1; ver[cls] = (ver[cls] ?? 0) + 1;
    if (a === "UNPARSED" || cls === "UNPARSED") unparsed.push(c[0]);
    if ((cls === "N/A (guard test)") !== (a === "NOT APPLICABLE WITH EVIDENCE")) inconsistent.push(`${c[0]}: applicability ${a} with verification ${cls}`);
    if (v.residual && cls !== "UNPARSED") residualRows += 1;
    perRow.push({ id: c[0], applicability: a, verification: cls, viaFixed: v.viaFixed, reviewerApproved: approved, residual: v.residual });
  }
  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)));
  const ok = missing.length === 0 && dups.length === 0 && unexpected.length === 0 && malformed.length === 0 && unparsed.length === 0 && inconsistent.length === 0;
  return {
    summary: {
      rows: rows.length, missing, dups, unexpected, malformed, unparsed, inconsistent,
      applicability: sortObj(app), verification: sortObj(ver), requireReviewed,
      ...(requireReviewed ? { fixedCountedAsPass, fixedAwaitingApproval } : {}),
      rowsWithResidualQualifiers: residualRows,
      verdict: ok ? "RECONCILED" : "FAIL",
    },
    perRow,
  };
}

/** Findings ledger shape: unique ids, every SF row as wide as its own table's header. */
export function reconcileFindings(src) {
  const problems = [];
  let width = 0;
  const ids = [];
  for (const l of src.split(/\r?\n/)) {
    if (/^\|\s*ID\s*\|/.test(l)) { width = cellsOf(l).length; continue; }
    if (!l.startsWith("| SF-")) continue;
    const c = cellsOf(l);
    ids.push(c[0]);
    if (c.length !== width) problems.push(`${c[0]}: ${c.length} cells, its table header has ${width} (an unescaped "|" inside a cell?)`);
  }
  const dups = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  const nums = ids.map((i) => Number(i.replace(/^SF-/, ""))).filter(Number.isFinite);
  const max = Math.max(0, ...nums);
  const gaps = Array.from({ length: max }, (_, i) => i + 1).filter((n) => !nums.includes(n)).map((n) => `SF-${String(n).padStart(2, "0")}`);
  const outOfOrder = ids.filter((id, i) => i > 0 && Number(id.slice(3)) < Number(ids[i - 1].slice(3)));
  return { rows: ids.length, dups, gaps, outOfOrder, problems, verdict: dups.length || gaps.length || problems.length ? "FAIL" : "RECONCILED" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
  const matrixPath = opt("matrix", new URL("../../docs/security/COVERAGE-MATRIX.md", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const findingsPath = opt("findings", new URL("../../docs/security/FINDINGS.md", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const m = reconcileMatrix(fs.readFileSync(decodeURIComponent(matrixPath), "utf8"), { requireReviewed: args.includes("--require-reviewed") });
  const f = fs.existsSync(decodeURIComponent(findingsPath)) ? reconcileFindings(fs.readFileSync(decodeURIComponent(findingsPath), "utf8")) : null;
  console.log(JSON.stringify({ ...m.summary, findings: f }));
  if (args.includes("--list")) for (const r of m.perRow) console.log(JSON.stringify(r));
  const fail = m.summary.verdict !== "RECONCILED" || (args.includes("--findings-strict") && f && f.verdict !== "RECONCILED");
  process.exit(fail ? 1 : 0);
}
