#!/usr/bin/env node
// Checks the `Standard refs` column of docs/security/COVERAGE-MATRIX.md against versioned standards sources.
//
//   node scripts/readiness/standards-refs-check.mjs --asvs=<asvs-5.0.0-en.flat.json> --wstg=<wstg checklist .md>
//        [--matrix=docs/security/COVERAGE-MATRIX.md] [--mapping=docs/security/STANDARDS-MAPPING.md] [--require-all]
//
// Cell grammar (segments separated by ";"):
//   ASVS V<ch>.<sec>.<req>[, V…]          every id must exist as a req_id in the ASVS flat JSON
//   ASVS — (no requirement; …)            explicit "no ASVS fit" (counted, not invalid)
//   WSTG-<CAT>-<NN>[, WSTG-…]             every id must exist as a Test ID in the WSTG checklist table
//   CWE-<n>[, CWE-…]                      no local CWE copy: syntax checked, and (with --mapping) each id must be
//                                         glossed in the mapping document's CWE table
// A cell of "—" or empty is unmapped. Any other segment, a chapter/section-only ASVS id (V6 or V6.2) or an unknown id
// is INVALID. With --mapping, each SEC row of the mapping document's per-row table must carry the identical cell text.
// Exit 1 on any invalid id, malformed segment or mapping mismatch (and on unmapped rows with --require-all).
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const asvsPath = opt("asvs");
const wstgPath = opt("wstg");
const matrixPath = opt("matrix", "docs/security/COVERAGE-MATRIX.md");
const mappingPath = opt("mapping", "docs/security/STANDARDS-MAPPING.md");
const requireAll = args.includes("--require-all");
if (!asvsPath || !wstgPath) {
  console.error("usage: --asvs=<asvs flat json> --wstg=<wstg checklist md> [--matrix=…] [--mapping=…|--mapping=] [--require-all]");
  process.exit(2);
}

const asvs = JSON.parse(fs.readFileSync(asvsPath, "utf8"));
const asvsIds = new Set(asvs.requirements.map((r) => r.req_id));
const wstgIds = new Set(
  fs.readFileSync(wstgPath, "utf8").split(/\r?\n/)
    .map((l) => /^\|\s*(WSTG-[A-Z]+-\d+)\s*\|/.exec(l)?.[1]).filter(Boolean),
);

// split on sep outside parentheses ("ASVS — (no requirement; see mapping §5)" is one segment)
function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && ch === sep) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const cellsOf = (line) => line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
const matrixLines = fs.readFileSync(matrixPath, "utf8").split(/\r?\n/);
const header = matrixLines.find((l) => /^\|\s*ID\s*\|/.test(l));
if (!header) { console.error(`no header row in ${matrixPath}`); process.exit(2); }
const col = cellsOf(header).indexOf("Standard refs");
if (col < 0) { console.error("no 'Standard refs' column"); process.exit(2); }

let mappingRows = null;
let cweGloss = null;
if (mappingPath) {
  const src = fs.readFileSync(mappingPath, "utf8").split(/\r?\n/);
  mappingRows = new Map();
  cweGloss = new Set();
  for (const l of src) {
    const m = /^\|\s*(SEC-\d{3})\s*\|\s*`([^`]*)`\s*\|/.exec(l);
    if (m) mappingRows.set(m[1], m[2]);
    const g = /^\|\s*(CWE-\d+)\s*\|/.exec(l);
    if (g) cweGloss.add(g[1]);
  }
}

const counts = { rows: 0, mapped: 0, unmapped: 0, asvsNone: 0, asvsRefs: 0, wstgRefs: 0, cweRefs: 0, invalid: 0, mismatch: 0 };
const problems = [];
const unmappedRows = [];
const distinct = { asvs: new Set(), wstg: new Set(), cwe: new Set() };

for (const line of matrixLines) {
  if (!/^\|\s*SEC-\d{3}\s*\|/.test(line)) continue;
  const cells = cellsOf(line);
  const id = cells[0];
  counts.rows += 1;
  const cell = cells[col] ?? "";
  if (mappingRows) {
    const m = mappingRows.get(id);
    if (m === undefined) { counts.mismatch += 1; problems.push(`${id}: missing from mapping document per-row table`); }
    else if (m !== cell) { counts.mismatch += 1; problems.push(`${id}: mapping document says "${m}", matrix says "${cell}"`); }
  }
  if (cell === "" || cell === "—") { counts.unmapped += 1; unmappedRows.push(id); continue; }
  counts.mapped += 1;
  for (const raw of splitTopLevel(cell, ";").map((s) => s.trim()).filter(Boolean)) {
    if (/^ASVS — \(no requirement; [^()]*\)$/.test(raw)) { counts.asvsNone += 1; continue; }
    if (raw.startsWith("ASVS ")) {
      for (const tok of raw.slice(5).split(",").map((s) => s.trim())) {
        counts.asvsRefs += 1;
        if (!/^V\d+\.\d+\.\d+$/.test(tok)) { counts.invalid += 1; problems.push(`${id}: "${tok}" is not a requirement-level ASVS id`); }
        else if (!asvsIds.has(tok)) { counts.invalid += 1; problems.push(`${id}: ASVS ${tok} not in ${asvsPath}`); }
        else distinct.asvs.add(tok);
      }
      continue;
    }
    if (raw.startsWith("WSTG-")) {
      for (const tok of raw.split(",").map((s) => s.trim())) {
        counts.wstgRefs += 1;
        if (!wstgIds.has(tok)) { counts.invalid += 1; problems.push(`${id}: ${tok} not in ${wstgPath}`); }
        else distinct.wstg.add(tok);
      }
      continue;
    }
    if (raw.startsWith("CWE-")) {
      for (const tok of raw.split(",").map((s) => s.trim())) {
        counts.cweRefs += 1;
        if (!/^CWE-\d+$/.test(tok)) { counts.invalid += 1; problems.push(`${id}: "${tok}" is not a CWE id`); }
        else if (cweGloss && !cweGloss.has(tok)) { counts.invalid += 1; problems.push(`${id}: ${tok} has no entry in the mapping document CWE table`); }
        else distinct.cwe.add(tok);
      }
      continue;
    }
    counts.invalid += 1;
    problems.push(`${id}: unrecognised segment "${raw}"`);
  }
}

const ok = counts.invalid === 0 && counts.mismatch === 0 && (!requireAll || counts.unmapped === 0);
console.log(JSON.stringify({
  sources: { asvs: asvsPath, asvsRequirements: asvsIds.size, wstg: wstgPath, wstgIds: wstgIds.size, matrix: matrixPath, mapping: mappingPath || null },
  ...counts,
  distinctAsvs: distinct.asvs.size, distinctWstg: distinct.wstg.size, distinctCwe: distinct.cwe.size,
  unmappedRows, problems,
  verdict: ok ? "PASS" : "FAIL",
}, null, 2));
process.exit(ok ? 0 : 1);
