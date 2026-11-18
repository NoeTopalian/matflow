// Round 8: summarise r8-nav output — per mode × scenario: median [min–max] of timings, mean counts, connection events.
import { readFileSync } from "node:fs";
const files = process.argv.slice(2);
const samples = files.flatMap((f) => JSON.parse(readFileSync(f, "utf8")).samples);
const med = (a) => { const v = a.filter((x) => x != null).sort((x, y) => x - y); if (!v.length) return "–"; const m = v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2); return `${m} [${v[0]}–${v[v.length - 1]}] n=${v.length}`; };
const mean = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : "–");
const key = (s) => s.kind === "load" ? `${s.device} load ${s.url}` : `${s.device} ${s.how}${s.dwell ? "+" + s.dwell : ""} → ${s.dest}`;
const scen = [...new Set(samples.map(key))];
const modes = [...new Set(samples.map((s) => s.mode))];
for (const sc of scen) {
  console.log(`\n## ${sc}`);
  for (const mode of modes) {
    const ss = samples.filter((s) => s.mode === mode && key(s) === sc);
    if (!ss.length) continue;
    const t = ss[0].kind === "load"
      ? `usable ${med(ss.map((s) => s.usableMs))} | quiet ${med(ss.map((s) => s.quietMs))}`
      : `url ${med(ss.map((s) => s.urlMs))} | feedback ${med(ss.map((s) => s.feedbackMs))} | usable ${med(ss.map((s) => s.usableMs))}`;
    const c = `fg req ${mean(ss.map((s) => s.client.fgRequests))} (${mean(ss.map((s) => Math.round(s.client.fgBytes / 1024)))} kB) srv ${mean(ss.map((s) => s.server.fg.requests))} req/${mean(ss.map((s) => s.server.fg.queries))} q | bg req ${mean(ss.map((s) => s.client.bgRequests))} (${mean(ss.map((s) => Math.round(s.client.bgBytes / 1024)))} kB) srv ${mean(ss.map((s) => s.server.bg.requests))} req/${mean(ss.map((s) => s.server.bg.queries))} q | unattributed q ${mean(ss.map((s) => s.server.unattributedQueries))} | conns created ${mean(ss.map((s) => s.server.conns.created))}`;
    console.log(`  ${mode.padEnd(6)} ${t}\n         ${c}`);
  }
}
// Connection lifecycle across everything
const all = samples.flatMap((s) => s.server.rawConns);
const removes = all.filter((c) => c.ev === "remove");
const reasons = {}; for (const r of removes) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
const idle = removes.map((r) => r.idleMs).filter((x) => x != null).sort((a, b) => a - b);
const acq = all.filter((c) => c.ev === "acquire");
console.log(`\n## Connections (all windows): created ${all.filter((c) => c.ev === "create").length}, failed ${all.filter((c) => c.ev === "create-failed").length}, acquires ${acq.length} (reused ${acq.filter((a) => a.reused).length}), removes ${removes.length} ${JSON.stringify(reasons)}, idle ms at removal min ${idle[0]} median ${idle[Math.floor(idle.length / 2)]} max ${idle[idle.length - 1]}; pool errors ${all.filter((c) => c.ev === "pool-error").length}`);
const connectMs = all.filter((c) => c.ev === "create").map((c) => c.connectMs).sort((a, b) => a - b);
console.log(`   connect ms median ${connectMs[Math.floor(connectMs.length / 2)]} [${connectMs[0]}–${connectMs[connectMs.length - 1]}]`);
// One auto desktop load: background paths with segment headers
const one = samples.find((s) => s.mode === "auto" && s.kind === "load" && s.device === "desktop");
if (one) console.log(`\n## auto desktop load background requests (${one.server.bgPaths.length}):\n  ${one.server.bgPaths.join("\n  ")}\n## foreground:\n  ${one.server.fgPaths.join("\n  ")}`);
