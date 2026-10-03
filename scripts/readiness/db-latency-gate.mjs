import { config } from "dotenv";
import { Client } from "pg";
config({ path: ".env.test", override: true });
const url = process.env.DATABASE_URL ?? "";
if (!url.includes("ep-hidden-salad") || url.includes("ep-bold-wave")) {
  console.error("REFUSING: DATABASE_URL is not the test branch"); process.exit(2);
}
const s = [];
for (let i = 0; i < 6; i++) {
  const t = Date.now(); const c = new Client({ connectionString: url });
  try { await c.connect(); await c.query("select 1"); s.push(Date.now() - t); }
  catch (e) { console.error(`sample ${i + 1}: FAIL ${e.message}`); s.push(Infinity); }
  finally { try { await c.end(); } catch {} }
}
s.sort((a, b) => a - b);
const median = s[Math.floor(s.length / 2)];
console.log(`samples(ms): ${s.join(", ")}`);
console.log(`median: ${median}ms`);
if (!(median < 700)) { console.error("GATE FAILED"); process.exit(1); }
console.log("GATE PASSED"); 
