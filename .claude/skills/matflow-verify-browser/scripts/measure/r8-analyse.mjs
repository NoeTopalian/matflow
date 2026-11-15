// Round 8: summarise a samples file — per surface: request paths (counts, server ms), duplicates, top query shapes.
import { readFileSync } from "node:fs";
const [file, only] = process.argv.slice(2);
const d = JSON.parse(readFileSync(file, "utf8"));
console.log("size", JSON.stringify(d.size));
const by = {};
for (const s of d.samples) (by[s.surface] ??= []).push(s);
for (const [surface, ss] of Object.entries(by)) {
  if (only && surface !== only) continue;
  const s = ss.find((x) => x.mode === "warm") ?? ss[0];
  console.log(`\n=== ${surface} (${ss.length} samples; showing ${s.mode}#${s.i})`);
  if (s.api) {
    const groups = {};
    for (const a of s.api) { const k = `${a.method} ${a.path.replace(/\/c[a-z0-9]{20,}|\/r8m-[0-9a-f]+/g, "/:id")}`; const g = (groups[k] ??= { n: 0, ms: [], bytes: 0, first: a.startMs }); g.n++; g.ms.push(a.serverMs); g.bytes += a.bytes || 0; }
    for (const [k, g] of Object.entries(groups).sort((a, b) => a[1].first - b[1].first)) console.log(`  ${String(g.n).padStart(2)}× ${k}  start ${g.first}ms  server ${g.ms.join(",")}ms  ${Math.round(g.bytes / 1024)}kB`);
    console.log(`  requests ${s.requests}, bytes ${Math.round(s.bytes / 1024)}kB, js ${Math.round((s.jsBytes || 0) / 1024)}kB, duplicates: ${s.duplicates?.join(" | ")}`);
  }
  if (s.db) {
    console.log(`  db: ${s.db.queries} queries, ${s.db.queryMs}ms summed, tx ${s.db.tx}, new conns ${s.db.newConnections} (${s.db.connectMs}ms), acquires ${s.db.acquires}, queued ${s.db.queuedAcquires} (${s.db.queueMs}ms), max concurrent ${s.db.maxConcurrent}`);
    for (const [n, ms, k] of s.db.topShapes) console.log(`   ${String(n).padStart(3)}× ${String(ms).padStart(6)}ms  ${k}`);
  }
}
