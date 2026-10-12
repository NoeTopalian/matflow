// Lane C bounded browser probe (SEC-041 reflected/DOM XSS, SEC-043 CORS, SEC-044 clickjacking)
// against a LOCAL production-mode server. Headless Chromium, no sign-in, ~10 navigations.
// Usage: node browser-probe.mjs http://127.0.0.1:3963
import { chromium } from "playwright";
import http from "node:http";

const BASE = process.argv[2] ?? "http://127.0.0.1:3963";
const results = {};
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const dialogs = [];
page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });

// A separate origin (different port) acting as the hostile site.
const evil = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><title>evil</title><iframe id=f src="${BASE}/login" width=400 height=300></iframe>`);
});
await new Promise((r) => evil.listen(4613, "127.0.0.1", r));
const EVIL = "http://127.0.0.1:4613";

const PAYLOADS = [
  `/login?error=${encodeURIComponent('<img src=x onerror=alert("secC1")>')}`,
  `/login?error=${encodeURIComponent('"><script>alert("secC2")</script>')}`,
  `/login?callbackUrl=${encodeURIComponent('javascript:alert("secC3")')}`,
  `/login#${encodeURIComponent('<img src=x onerror=alert("secC4")>')}`,
  `/secc${encodeURIComponent('<svg onload=alert("secC5")>')}`,
  `/waiver/open?token=${encodeURIComponent('"><img src=x onerror=alert("secC6")>')}`,
  `/kiosk/${encodeURIComponent('<img src=x onerror=alert("secC7")>')}`,
];
for (const p of PAYLOADS) {
  const before = dialogs.length;
  let status = null;
  try {
    const r = await page.goto(BASE + p, { waitUntil: "load", timeout: 30000 });
    status = r?.status() ?? null;
    await page.waitForTimeout(800);
  } catch (e) {
    status = `error: ${String(e.message).slice(0, 80)}`;
  }
  results[`xss ${p.slice(0, 60)}`] = { status, finalPath: new URL(page.url()).pathname, dialogs: dialogs.slice(before) };
}

// SEC-044: framing from another origin.
await page.goto(EVIL, { waitUntil: "load" });
await page.waitForTimeout(1500);
const frame = page.frames().find((f) => f !== page.mainFrame());
let framedContent = null;
try { framedContent = frame ? await frame.evaluate(() => document.body?.innerText?.slice(0, 40) ?? "") : null; } catch (e) { framedContent = `inaccessible: ${String(e.message).slice(0, 60)}`; }
results["clickjacking iframe from other origin"] = { frameUrl: frame?.url() ?? null, framedContent };

// SEC-043: credentialed cross-origin reads from the hostile origin.
results["cors credentialed fetch /api/health"] = await page.evaluate(async (b) => {
  try { const r = await fetch(`${b}/api/health`, { credentials: "include" }); return { readable: true, status: r.status }; }
  catch (e) { return { readable: false, error: String(e).slice(0, 80) }; }
}, BASE);
results["cors credentialed fetch /api/me/gym"] = await page.evaluate(async (b) => {
  try { const r = await fetch(`${b}/api/me/gym`, { credentials: "include" }); return { readable: true, status: r.status }; }
  catch (e) { return { readable: false, error: String(e).slice(0, 80) }; }
}, BASE);

await browser.close();
evil.close();
console.log(JSON.stringify({ base: BASE, at: new Date().toISOString(), totalDialogs: dialogs.length, results }, null, 1));
