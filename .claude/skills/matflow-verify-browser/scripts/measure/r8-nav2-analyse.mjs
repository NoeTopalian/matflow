// Round 8: summarise r8-nav v2 output — per scenario × mode: median [min–max] of shell / content / usable, counts;
// plus the request timelines of the first navigation per mode (to test whether a click waits for a prefetch).
import { readFileSync } from "node:fs";
const [file, showTimelines] = process.argv.slice(2);
const d = JSON.parse(readFileSync(file, "utf8"));
const S = d.samples;
const med = (a) => { const v = a.filter((x) => x != null).sort((x, y) => x - y); if (!v.length) return "–"; const m = v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2); return `${m} [${v[0]}–${v[v.length - 1]}]`; };
const mean = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : "–");
const label = { A: "desktop mouse+300 → Settings (first nav; not prefetched in 'one')", A2: "desktop mouse+300 → My account (SUBSEQUENT nav)", B: "desktop mouse+300 → Home (first nav; prefetched in 'one')", C: "desktop keyboard → My account (first nav; focus+Enter at once)", D: "phone tap → Timetable (first nav; not prefetched in 'one')", E: "phone tap → Home (first nav; prefetched in 'one')" };
console.log("size", JSON.stringify(d.seed.size), "rounds", d.rounds, "modes", d.modes.join(","));
console.log("\n# Initial loads (one per scenario context)");
for (const dev of ["desktop", "phone"]) for (const mode of d.modes) {
  const ss = S.filter((s) => s.kind === "load" && s.device === dev && s.mode === mode);
  console.log(`  ${dev.padEnd(7)} ${mode.padEnd(6)} usable ${med(ss.map((s) => s.usableMs))} quiet ${med(ss.map((s) => s.quietMs))} n=${ss.length} | fg ${mean(ss.map((s) => s.server.fg.requests))} req/${mean(ss.map((s) => s.server.fg.queries))} q ${mean(ss.map((s) => Math.round(s.client.fgBytes / 1024)))} kB | bg ${mean(ss.map((s) => s.server.bg.requests))} req/${mean(ss.map((s) => s.server.bg.queries))} q ${mean(ss.map((s) => Math.round(s.client.bgBytes / 1024)))} kB | conns+${mean(ss.map((s) => s.server.connsCreated))}`);
}
console.log("\n# Navigations: ms from click/Enter/tap");
for (const sc of Object.keys(label)) {
  console.log(`\n## ${sc}: ${label[sc]}`);
  for (const mode of d.modes) {
    const ss = S.filter((s) => s.kind === "nav" && s.scenario === sc && s.mode === mode);
    if (!ss.length) continue;
    console.log(`  ${mode.padEnd(6)} shell ${med(ss.map((s) => s.shellMs))} | content ${med(ss.map((s) => s.contentMs))} | usable ${med(ss.map((s) => s.usableMs))} n=${ss.length}${ss.some((s) => s.err) ? " ERR" : ""} | fg ${mean(ss.map((s) => s.server.fg.requests))} req/${mean(ss.map((s) => s.server.fg.queries))} q | bg ${mean(ss.map((s) => s.server.bg.requests))} req/${mean(ss.map((s) => s.server.bg.queries))} q`);
  }
}
const all = S.flatMap((s) => s.server.rawConns ?? []);
const rm = all.filter((c) => c.ev === "remove"); const reasons = {}; for (const r of rm) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
const idle = rm.map((r) => r.idleMs).filter((x) => x != null).sort((a, b) => a - b);
console.log(`\n# Connections: created ${all.filter((c) => c.ev === "create").length}, failed ${all.filter((c) => c.ev === "create-failed").length}, removes ${rm.length} ${JSON.stringify(reasons)}, idle at removal ${idle[0]}–${idle[idle.length - 1]} ms; pool errors ${all.filter((c) => c.ev === "pool-error").length}`);
if (showTimelines) {
  console.log("\n# Request timelines (ms relative to the click; negative = before it)");
  for (const sc of showTimelines.split(",")) for (const mode of d.modes) {
    for (const s of S.filter((x) => x.kind === "nav" && x.scenario === sc && x.mode === mode)) {
      console.log(`\n  [${sc} ${mode} r${s.round}] hover→click ${s.hoverToClickMs} ms, shell ${s.shellMs}, content ${s.contentMs}`);
      for (const t of s.timeline.filter((t) => t.kind !== "Document")) console.log(`    ${String(t.start).padStart(6)} → ${String(t.end).padStart(6)}  ${t.kind.padEnd(18)} ${t.path} ${t.kB}kB`);
    }
  }
}
