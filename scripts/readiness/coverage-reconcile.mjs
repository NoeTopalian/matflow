// Reconciles docs/security/COVERAGE-MATRIX.md: every SEC-001..096 present exactly once, applicability and
// verification counted as separate dimensions from the row text (iteration 2 of the security campaign, 9 Oct 2026).
// Exit 1 on a missing or duplicated id or an unclassifiable verification cell. Prints one JSON line.
import fs from "node:fs";

const src = fs.readFileSync(new URL("../../docs/security/COVERAGE-MATRIX.md", import.meta.url), "utf8");
const rows = src.split(/\r?\n/).filter((l) => l.startsWith("| SEC-"));
const cells = rows.map((l) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
const ids = cells.map((c) => c[0]);
const expected = Array.from({ length: 96 }, (_, i) => `SEC-${String(i + 1).padStart(3, "0")}`);
const missing = expected.filter((id) => !ids.includes(id));
const dups = ids.filter((id, i) => ids.indexOf(id) !== i);

function applicability(a) {
  if (a.startsWith("NOT APPLICABLE")) return "NOT APPLICABLE WITH EVIDENCE";
  if (a.startsWith("UNKNOWN")) return "UNKNOWN";
  if (a.startsWith("APPLICABLE")) return "APPLICABLE";
  return "UNPARSED";
}
function verification(v) {
  const V = v.toUpperCase();
  if (V.includes("BLOCKED")) return "BLOCKED";
  if (V.startsWith("PASS")) return "PASS";
  if (V.includes("APPROVED")) return "FIXED-APPROVED";
  if (V.startsWith("FIXED") || (V.startsWith("CONFIRMED") && V.includes("FIXED"))) return "FIXED-AWAITING-REVIEW";
  if (V.startsWith("FAIL") || V.startsWith("OPEN")) return "FAIL/OPEN";
  if (V.includes("NOT RUN")) return "NOT RUN";
  if (V.includes("GUARD TEST")) return "N/A-GUARD-TEST";
  if (V.includes("UNKNOWN")) return "UNKNOWN";
  if (V.includes("PARTIAL") || V.includes("DOCUMENTED") || V.includes("PROPOSAL")) return "PARTIAL/DOCUMENTED";
  return "UNPARSED";
}
const app = {}, ver = {}, unparsed = [];
for (const c of cells) {
  const a = applicability(c[6] ?? ""), v = verification(c[7] ?? "");
  app[a] = (app[a] ?? 0) + 1; ver[v] = (ver[v] ?? 0) + 1;
  if (a === "UNPARSED" || v === "UNPARSED") unparsed.push(c[0]);
}
const ok = missing.length === 0 && dups.length === 0 && unparsed.length === 0;
console.log(JSON.stringify({ rows: rows.length, missing, dups, unparsed, applicability: app, verification: ver, verdict: ok ? "RECONCILED" : "FAIL" }));
process.exit(ok ? 0 : 1);
