// Lane C2 (9 Oct 2026): headless-Chromium CSP pass over a LOCAL production-mode server on the TEST branch.
// For every page: document CSP headers (which header, nonce present), every <script> carries the nonce,
// `securitypolicyviolation` events (init script, registered before any page script), console CSP
// messages, and requests to /api/csp-report. Signs in through the real login form with lane C2's own
// synthetic accounts (credentials read from a private scratch file; never printed).
// Usage: node csp-browser-probe.mjs <base> <private-c2.json> <out.json> <label>
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/NoeTo/Desktop/matflow/node_modules/@playwright/test");

const [BASE, STATE_FILE, OUT, LABEL = "run"] = process.argv.slice(2);
const S = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
const results = { label: LABEL, base: BASE, at: new Date().toISOString(), pages: [], controls: {} };

const INIT = () => {
  window.__cspViolations = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__cspViolations.push({ directive: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 40), disposition: e.disposition, sample: String(e.sample || "").slice(0, 40) });
  });
};

async function probe(page, path, note = "") {
  const consoleCsp = [];
  const onConsole = (m) => { if (/Content Security Policy|Content-Security-Policy/i.test(m.text())) consoleCsp.push(m.text().slice(0, 160)); };
  const reportReqs = [];
  const onReq = (r) => { if (r.url().includes("/api/csp-report")) reportReqs.push(r.method()); };
  page.on("console", onConsole);
  page.on("request", onReq);
  let res = null;
  let err = null;
  try {
    res = await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 90000 });
  } catch (e) {
    err = String(e.message).slice(0, 120);
  }
  await page.waitForTimeout(1500);
  const h = res ? await res.allHeaders() : {};
  const ro = h["content-security-policy-report-only"] ?? null;
  const enf = h["content-security-policy"] ?? null;
  const nonceRo = ro?.match(/'nonce-([^']+)'/)?.[1] ?? null;
  const nonceEnf = enf?.match(/'nonce-([^']+)'/)?.[1] ?? null;
  const dom = await page.evaluate(() => {
    const scripts = [...document.scripts];
    return {
      scripts: scripts.length,
      withoutNonce: scripts.filter((s) => !s.nonce).length,
      violations: window.__cspViolations ?? [],
      title: document.title.slice(0, 60),
    };
  }).catch((e) => ({ scripts: -1, withoutNonce: -1, violations: [], title: `eval failed ${String(e).slice(0, 60)}` }));
  page.off("console", onConsole);
  page.off("request", onReq);
  const row = {
    path,
    note,
    status: res?.status() ?? null,
    finalPath: new URL(page.url()).pathname,
    error: err,
    reportOnlyHeader: !!ro,
    enforcingHeaders: enf ? enf.split(",").length : 0,
    nonceInHeader: !!(nonceRo || nonceEnf),
    staticPolicyHasUnsafeInline: !!(enf && /script-src[^;]*'unsafe-inline'/.test(enf)),
    scripts: dom.scripts,
    scriptsWithoutNonce: dom.withoutNonce,
    violations: dom.violations.length,
    violationKinds: [...new Set(dom.violations.map((v) => `${v.directive}|${v.blocked}|${v.disposition}`))],
    consoleCspMessages: consoleCsp.length,
    reportRequests: reportReqs.length,
    title: dom.title,
  };
  results.pages.push(row);
  console.log(`${row.status} ${path} -> ${row.finalPath} scripts=${row.scripts} noNonce=${row.scriptsWithoutNonce} viol=${row.violations} console=${row.consoleCspMessages} reports=${row.reportRequests} ${row.violationKinds.join(" ")}`);
  return row;
}

async function signIn(page, email) {
  await page.goto(`${BASE}/login?club=${S.slug}`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForSelector("input[type='email']", { timeout: 60000 });
  await page.fill("input[type='email']", email);
  await page.fill("input[type='password']", S.pw);
  await page.click("button[type='submit']");
  await page.waitForURL((u) => !/^\/login\/?$/.test(u.pathname), { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return new URL(page.url()).pathname;
}

const browser = await chromium.launch();
try {
  // ── anonymous pages ────────────────────────────────────────────────────────
  const anon = await browser.newContext();
  await anon.addInitScript(INIT);
  const p = await anon.newPage();
  for (const path of ["/", "/login", `/login?club=${S.slug}`, `/${S.slug}`, "/apply", "/legal/privacy", "/legal/terms", "/admin/login", "/waiver/secC2-not-a-token", "/kiosk/secC2-not-a-token", "/leaderboard/secC2-not-a-token", "/set-password"]) {
    await probe(p, path);
  }

  // Detector positive control: an injected inline script with no nonce must raise a violation
  // (report-only: reported AND still runs under the static 'unsafe-inline'; enforcing: blocked).
  await p.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  results.controls.injectedInlineScript = await p.evaluate(async () => {
    const before = window.__cspViolations.length;
    window.__secC2ran = false;
    const s = document.createElement("script");
    s.textContent = "window.__secC2ran = true";
    document.body.appendChild(s);
    await new Promise((r) => setTimeout(r, 300));
    return { violationsRaised: window.__cspViolations.length - before, ran: window.__secC2ran, kinds: window.__cspViolations.slice(before).map((v) => `${v.directive}|${v.blocked}|${v.disposition}`) };
  });
  console.log("control injectedInlineScript", JSON.stringify(results.controls.injectedInlineScript));
  results.controls.injectedHandler = await p.evaluate(async () => {
    const before = window.__cspViolations.length;
    window.__secC2h = false;
    const d = document.createElement("div");
    d.innerHTML = '<img src="data:," onerror="window.__secC2h=true">';
    document.body.appendChild(d);
    await new Promise((r) => setTimeout(r, 300));
    return { violationsRaised: window.__cspViolations.length - before, ran: window.__secC2h };
  });
  console.log("control injectedHandler", JSON.stringify(results.controls.injectedHandler));

  // Server-side injection model (stored/reflected XSS): the real /login response, headers kept, with a
  // parser-inserted <script> and an inline handler spliced into the HTML. This is what the nonce policy
  // exists to stop. (A script created by createElement is NOT a valid model under 'strict-dynamic': the
  // policy trusts non-parser-inserted scripts by design — recorded as a residual.)
  const inj = await anon.newPage();
  await inj.route("**/login?secC2inject=1", async (route) => {
    const resp = await route.fetch();
    const body = (await resp.text()).replace("<body", '<body data-x="1"').replace(/<\/body>/, '<script>window.__secC2p=true</script><img src="data:," onerror="window.__secC2q=true"></body>');
    await route.fulfill({ response: resp, body });
  });
  await inj.goto(`${BASE}/login?secC2inject=1`, { waitUntil: "networkidle" });
  await inj.waitForTimeout(800);
  results.controls.serverInjected = await inj.evaluate(() => ({
    scriptRan: window.__secC2p === true,
    handlerRan: window.__secC2q === true,
    violations: (window.__cspViolations ?? []).map((v) => `${v.directive}|${v.blocked}|${v.disposition}`),
  }));
  console.log("control serverInjected", JSON.stringify(results.controls.serverInjected));
  // Report delivery: the Reporting API batches; keep this page alive long enough for the browser to post.
  await inj.waitForTimeout(65000);
  await inj.close();
  await anon.close();

  // ── staff (owner) ──────────────────────────────────────────────────────────
  const staff = await browser.newContext();
  await staff.addInitScript(INIT);
  const sp = await staff.newPage();
  results.controls.ownerLanding = await signIn(sp, S.ownerEmail);
  console.log("owner landed on", results.controls.ownerLanding);
  for (const path of ["/dashboard", "/dashboard/members", "/dashboard/timetable", "/dashboard/settings", "/dashboard/reports", "/dashboard/payments", "/dashboard/scan"]) {
    await probe(sp, path, "owner");
  }
  // Client-side navigation after load (chunks loaded by the runtime under strict-dynamic).
  await sp.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
  const link = sp.locator("a[href='/dashboard/members']").first();
  if (await link.count()) {
    await link.click();
    await sp.waitForTimeout(3000);
  }
  results.controls.clientNavViolations = await sp.evaluate(() => window.__cspViolations.length);
  console.log("client navigation violations", results.controls.clientNavViolations);
  await staff.close();

  // ── member portal + checkout page ─────────────────────────────────────────
  const mem = await browser.newContext();
  await mem.addInitScript(INIT);
  const mp = await mem.newPage();
  results.controls.memberLanding = await signIn(mp, S.memberEmail);
  console.log("member landed on", results.controls.memberLanding);
  for (const path of ["/member/home", "/member/schedule", "/member/shop", "/member/profile", "/member/progress"]) {
    await probe(mp, path, "member");
  }
  await mem.close();
} finally {
  await browser.close();
}
const t = results.pages;
results.summary = {
  pages: t.length,
  pagesWithPolicy: t.filter((r) => r.reportOnlyHeader || r.nonceInHeader).length,
  pagesWithScriptsMissingNonce: t.filter((r) => r.scriptsWithoutNonce > 0).length,
  totalViolations: t.reduce((a, r) => a + r.violations, 0),
  totalConsoleCsp: t.reduce((a, r) => a + r.consoleCspMessages, 0),
  totalReportRequests: t.reduce((a, r) => a + r.reportRequests, 0),
};
console.log("SUMMARY", JSON.stringify(results.summary));
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
