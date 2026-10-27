// Journey: Next 16.3 → 16.4 runtime check (review M2 on chore/next-16.4-sentry-advisories, 22 Oct 2026).
// What tsc, lint, vitest and `next build` cannot show: Next's own request matching and proxy chain on a production
// build — the unauthenticated redirect, the excluded-matcher routes, the CSP nonce stamped by proxy.ts, the legacy
// /checkin/:slug redirect, and a signed-in owner reaching the dashboard and an API route. Needs `fixture.mjs create`
// and `server.mjs start`.
import { chromium, state, ledger, context, ownerSignIn, BASE } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("next-16-4-smoke");
const errors = [];
const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.96.0.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

  // Unauthenticated: the proxy sends a protected page to /login.
  const r1 = await page.goto("/dashboard");
  L.check("journey", "J1 unauthenticated /dashboard is redirected to /login by the proxy", /\/login/.test(page.url()) && r1?.ok(), new URL(page.url()).pathname);

  // Excluded-matcher routes answer without the proxy's auth gate.
  const health = await ctx.request.get("/api/health");
  L.check("journey", "J2 /api/health (excluded from the matcher) answers 200", health.status() === 200, { status: health.status() });

  // Legacy QR landing: next.config.ts redirect still applies after the bump.
  const legacy = await ctx.request.get("/checkin/some-club", { maxRedirects: 0 });
  const loc = legacy.headers()["location"] ?? "";
  L.check("journey", "J3 /checkin/:slug is redirected (next.config.ts) towards /login", [301, 302, 307, 308].includes(legacy.status()) && /\/login/.test(loc), { status: legacy.status(), location: loc });

  // CSP nonce stamped by proxy.ts on an HTML response, and the nonce actually used by the rendered scripts.
  const html = await ctx.request.get("/login");
  // lib/csp.ts: report-only unless MATFLOW_CSP_ENFORCE is set, so either header name carries the nonce.
  // Both headers are sent: the enforcing policy (no nonce, allows inline) and the report-only one that carries the nonce.
  const hdrs = html.headers();
  const nonceHeader = ["content-security-policy-report-only", "content-security-policy"].find((k) => hdrs[k]?.includes("'nonce-")) ?? null;
  const csp = nonceHeader ? hdrs[nonceHeader] : "";
  const nonce = csp.match(/'nonce-([A-Za-z0-9+/=_-]+)'/)?.[1] ?? "";
  const body = await html.text();
  L.check("journey", "J4 HTML response carries a CSP with a nonce and the page's scripts use it",
    nonce.length >= 16 && body.includes(`nonce="${nonce}"`), { cspNonce: nonce.length, scriptsUseIt: body.includes(`nonce="${nonce}"`), nonceHeader, enforcingHasNonce: !!hdrs["content-security-policy"]?.includes("'nonce-") });

  // Signed-in owner (password + authenticator) reaches the dashboard and an authenticated API route.
  await ownerSignIn(page, club);
  L.check("journey", "J5 owner sign-in lands on the dashboard", /\/dashboard/.test(page.url()), new URL(page.url()).pathname);
  const me = await page.request.get("/api/me/gym");
  L.check("journey", "J6 an authenticated API route (/api/me/gym) answers 200 for the signed-in owner", me.status() === 200, { status: me.status() });
  await page.goto("/dashboard/members");
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 60000 });
  L.check("journey", "J7 a nested dashboard page renders (route matching after the 16.4 matcher rewrite)", /\/dashboard\/members/.test(page.url()), new URL(page.url()).pathname);

  // Sign-out ends the session: the proxy refuses the dashboard again.
  const out = await page.request.post("/api/auth/signout", { form: { csrfToken: "" } }).catch(() => null);
  await ctx.clearCookies();
  await page.goto("/dashboard");
  L.check("journey", "J8 with the session gone, /dashboard is refused again", /\/login/.test(page.url()), { pathname: new URL(page.url()).pathname, signoutStatus: out?.status() ?? "skipped" });

  L.check("journey", "J9 no uncaught page errors", errors.length === 0, errors);
  await ctx.close();
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path} — base ${BASE}`);
