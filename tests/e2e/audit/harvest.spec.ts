/**
 * MatFlow screenshot + accessibility harvester.
 * =============================================
 *
 * This is NOT a correctness test. It walks every page of the app and emits
 * artefacts that later UI-judge agents read as image files:
 *
 *   <out>/shots/<surface>/<page-slug>--<viewport>.png   full-page PNGs
 *   <out>/axe/<surface>/<page-slug>--<viewport>.json    raw axe results
 *   <out>/manifest.json                                 one row per capture
 *
 * `<out>` is `process.env.AUDIT_OUT`, defaulting to
 * `.omc/state/assess-loop/artifacts`.
 *
 * The manifest is how a judge tells "ugly page" from "page that 500ed": every
 * row carries the requested URL, the URL it actually landed on, the HTTP
 * status, console errors, page errors and the axe summary. Nothing is skipped
 * silently — a route that cannot be reached still produces a row carrying the
 * reason.
 *
 * ---------------------------------------------------------------------------
 * HOW TO RUN (it is excluded from the normal 82-test matrix)
 * ---------------------------------------------------------------------------
 * The `audit-harvest` project only exists when AUDIT_HARVEST=1, and
 * `tests/e2e/audit/**` is in the `chromium` project's testIgnore, so a bare
 * `npx playwright test` never picks this file up.
 *
 * Because another worktree may already own port 3847, start your OWN dev
 * server on a private port first and point Playwright at it. When
 * PLAYWRIGHT_BASE_URL answers, `reuseExistingServer` means Playwright will not
 * spawn a second `next dev` (and playwright.config.ts derives the dev port
 * from PLAYWRIGHT_BASE_URL, so it can never land on 3847 by accident).
 *
 *   # terminal 1 — private dev server
 *   npx next dev --port 3999
 *
 *   # terminal 2 — PowerShell
 *   $env:AUDIT_HARVEST="1"; $env:PLAYWRIGHT_BASE_URL="http://localhost:3999"
 *   npx playwright test --project=audit-harvest
 *
 *   # terminal 2 — bash
 *   AUDIT_HARVEST=1 PLAYWRIGHT_BASE_URL=http://localhost:3999 \
 *     npx playwright test --project=audit-harvest
 *
 * Optional environment:
 *   AUDIT_OUT=<dir>        output root (default .omc/state/assess-loop/artifacts)
 *   AUDIT_SURFACES=a,b     only harvest these surfaces
 *                          (public|auth|staff|member|admin|kiosk)
 *   AUDIT_VIEWPORTS=a,b    only these viewports (desktop|mobile)
 *   AUDIT_KEEP=1           do not wipe previous artefacts before the run
 *   MATFLOW_ADMIN_SECRET=… authenticates the /admin surface (see below)
 *
 * ---------------------------------------------------------------------------
 * KNOWN LIMITATIONS (deliberate, recorded rather than hidden)
 * ---------------------------------------------------------------------------
 * - axe: `@axe-core/playwright` is NOT a dependency of this repo and this spec
 *   does not install it. `axe-core` IS present in node_modules (4.11.x, a
 *   transitive dep), so we inject `axe-core/axe.min.js` into each page — which
 *   is exactly what @axe-core/playwright does internally. If axe-core ever
 *   disappears, every row records `axe.available: false` with the reason
 *   "axe: unavailable" and the run still completes.
 * - /admin/*: there is no seeded operator account and no MATFLOW_ADMIN_SECRET
 *   in .env / .env.test, so by default the admin surface is harvested
 *   ANONYMOUSLY and every protected admin page will redirect to /admin/login.
 *   The manifest records role "anonymous" and the redirect in `finalUrl`, so a
 *   judge can see the pages were not reachable rather than assuming they are
 *   ugly. Export MATFLOW_ADMIN_SECRET (matching the running server's value) to
 *   harvest the real admin pages.
 * - Dynamic routes ([id], [token], …) are resolved live: member ids are
 *   scraped from the staff roster (API fallback), a kiosk token is minted via
 *   POST /api/settings/kiosk, and an open-waiver token via
 *   POST /api/members/[id]/waiver-link. Minting a kiosk token INVALIDATES the
 *   tenant's previous kiosk URL — acceptable on the .env.test branch, never
 *   run this against production.
 * - The member first-run wizard is suppressed (the /api/member/home payload is
 *   rewritten to report the member as onboarded) so the underlying pages are
 *   visible; each member row notes this.
 */

import { test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { suppressOnboardingWizard } from "../onboarding-gate";
import fs from "node:fs";
import path from "node:path";

// A full walk of ~50 routes at two viewports, with axe on each, is minutes of
// work — not a 30s test.
test.describe.configure({ mode: "serial", timeout: 30 * 60_000 });

// ---------------------------------------------------------------------------
// Output layout
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();
const OUT_ROOT = path.resolve(
  REPO_ROOT,
  process.env.AUDIT_OUT ?? ".omc/state/assess-loop/artifacts",
);
const SHOTS_DIR = path.join(OUT_ROOT, "shots");
const AXE_DIR = path.join(OUT_ROOT, "axe");
const PARTS_DIR = path.join(OUT_ROOT, ".manifest-parts");
const MANIFEST_PATH = path.join(OUT_ROOT, "manifest.json");

// ---------------------------------------------------------------------------
// axe-core — injected from node_modules, never installed by this spec
// ---------------------------------------------------------------------------

const AXE_PATH = path.join(REPO_ROOT, "node_modules", "axe-core", "axe.min.js");
const AXE_SOURCE: string | null = fs.existsSync(AXE_PATH)
  ? fs.readFileSync(AXE_PATH, "utf8")
  : null;
const AXE_VERSION: string | null = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "node_modules", "axe-core", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
})();
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Surface = "public" | "auth" | "staff" | "member" | "admin" | "kiosk";
type Role = "anonymous" | "owner" | "member" | "admin";
type ViewportName = "desktop" | "mobile";

interface Viewport {
  name: ViewportName;
  width: number;
  height: number;
  isMobile: boolean;
}

interface Target {
  /** Filesystem route pattern, e.g. `/dashboard/members/[id]`. */
  route: string;
  /** Concrete path to visit; undefined until a dynamic route is resolved. */
  url?: string;
  surface: Surface;
  role: Role;
  slug: string;
  notes: string[];
}

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  tags: string[];
  nodes: number;
  sampleTargets: string[];
}

interface AxeSummary {
  available: boolean;
  reason?: string;
  source?: string;
  violationCount?: number;
  seriousOrCritical?: number;
  violations?: AxeViolation[];
  /** Path (relative to the output root) of the full axe JSON dump. */
  file?: string;
}

interface CaptureRow {
  surface: Surface;
  slug: string;
  route: string;
  url: string | null;
  fullUrl: string | null;
  finalUrl: string | null;
  viewport: ViewportName;
  viewportSize: string;
  role: Role;
  authenticated: boolean;
  status: number | null;
  ok: boolean;
  title: string | null;
  screenshot: string | null;
  screenshotFullPage: boolean;
  consoleErrors: string[];
  pageErrors: string[];
  navigationError: string | null;
  skipped: string | null;
  axe: AxeSummary;
  notes: string[];
  capturedAt: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Route discovery — derived from the filesystem, not a hand-kept list
// ---------------------------------------------------------------------------

const APP_DIR = path.join(REPO_ROOT, "app");

function discoverRoutes(dir: string, segments: string[] = []): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  if (entries.some((e) => e.isFile() && /^page\.(tsx|jsx|ts|js)$/.test(e.name))) {
    found.push(segments.length === 0 ? "/" : `/${segments.join("/")}`);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    // Not routable: API handlers, private folders, parallel/intercepting routes.
    if (name === "api" || name.startsWith("_") || name.startsWith("@") || name.startsWith(".")) {
      continue;
    }
    if (name.startsWith("(")) {
      // Route group — contributes no URL segment.
      found.push(...discoverRoutes(path.join(dir, name), segments));
      continue;
    }
    found.push(...discoverRoutes(path.join(dir, name), [...segments, name]));
  }

  return found;
}

function surfaceOf(route: string): Surface {
  if (route === "/dashboard" || route.startsWith("/dashboard/")) return "staff";
  if (route === "/member" || route.startsWith("/member/")) return "member";
  if (route === "/admin" || route.startsWith("/admin/")) return "admin";
  if (route === "/kiosk" || route.startsWith("/kiosk/")) return "kiosk";
  if (
    route === "/login" ||
    route.startsWith("/login/") ||
    route === "/apply" ||
    route === "/onboarding" ||
    route === "/waiver/open"
  ) {
    return "auth";
  }
  return "public";
}

function defaultRoleFor(surface: Surface): Role {
  switch (surface) {
    case "staff":
      return "owner";
    case "member":
      return "member";
    case "admin":
      return "admin";
    default:
      return "anonymous";
  }
}

/** Routes whose sensible visitor differs from their surface default. */
const ROLE_OVERRIDES: Record<string, Role> = {
  // The operator sign-in page must be seen logged OUT or it just redirects.
  "/admin/login": "anonymous",
  // The setup wizard is an owner surface even though it lives outside /dashboard.
  "/onboarding": "owner",
};

/** Routes that need query parameters to render anything meaningful. */
const URL_OVERRIDES: Record<string, string> = {
  // Without ?resume=1 a completed tenant is redirected straight to /dashboard.
  "/onboarding": "/onboarding?resume=1",
};

function slugify(route: string): string {
  const cleaned = route
    .replace(/^\//, "")
    .replace(/[[\]]/g, "")
    .replace(/\.{3}/g, "splat-")
    .replace(/\//g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned === "" ? "index" : cleaned;
}

const DISCOVERED = Array.from(new Set(discoverRoutes(APP_DIR))).sort();

const FILESYSTEM_TARGETS: Target[] = DISCOVERED.map((route) => {
  const surface = surfaceOf(route);
  return {
    route,
    url: URL_OVERRIDES[route] ?? (route.includes("[") ? undefined : route),
    surface,
    role: ROLE_OVERRIDES[route] ?? defaultRoleFor(surface),
    slug: slugify(route),
    notes: [],
  };
});

/**
 * Extra captures that are not distinct files on disk but ARE distinct screens.
 * `components/layout/routes.ts` (STAFF_NAV) is the nav registry and every href
 * in it is already covered by the filesystem walk above — these are the states
 * the walk alone would miss.
 */
const EXTRA_TARGETS: Target[] = [
  {
    route: "/login?club=totalbjj",
    url: "/login?club=totalbjj",
    surface: "auth",
    role: "anonymous",
    slug: "login--club-preselected",
    notes: ["email/password step (bare /login shows the club-code step instead)"],
  },
  {
    // Resolved at runtime to /waiver/open?token=… — the signable state.
    route: "/waiver/open?token=[token]",
    surface: "auth",
    role: "anonymous",
    slug: "waiver-open--tokenised",
    notes: ["open-waiver link minted via POST /api/members/[id]/waiver-link"],
  },
];

const ALL_TARGETS: Target[] = [...FILESYSTEM_TARGETS, ...EXTRA_TARGETS];

// ---------------------------------------------------------------------------
// Viewports
// ---------------------------------------------------------------------------

const ALL_VIEWPORTS: Viewport[] = [
  { name: "desktop", width: 1440, height: 900, isMobile: false },
  { name: "mobile", width: 390, height: 844, isMobile: true },
];

function envList(name: string): string[] | null {
  const raw = process.env[name];
  if (!raw) return null;
  const items = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

const SURFACE_FILTER = envList("AUDIT_SURFACES");
const VIEWPORT_FILTER = envList("AUDIT_VIEWPORTS");

const SURFACES: Surface[] = (["public", "auth", "staff", "member", "admin", "kiosk"] as Surface[])
  .filter((s) => ALL_TARGETS.some((t) => t.surface === s))
  .filter((s) => !SURFACE_FILTER || SURFACE_FILTER.includes(s));

const VIEWPORTS = ALL_VIEWPORTS.filter((v) => !VIEWPORT_FILTER || VIEWPORT_FILTER.includes(v.name));

// ---------------------------------------------------------------------------
// Auth material
// ---------------------------------------------------------------------------

const OWNER_STATE = path.join(REPO_ROOT, "tests", "e2e", ".auth", "owner.json");
const MEMBER_STATE = path.join(REPO_ROOT, "tests", "e2e", ".auth", "member.json");
const ADMIN_SECRET = process.env.MATFLOW_ADMIN_SECRET ?? null;

function storageStateFor(role: Role): string | undefined {
  if (role === "owner" && fs.existsSync(OWNER_STATE)) return OWNER_STATE;
  if (role === "member" && fs.existsSync(MEMBER_STATE)) return MEMBER_STATE;
  return undefined;
}

function authNotesFor(role: Role): string[] {
  const notes: string[] = [];
  if (role === "owner" && !fs.existsSync(OWNER_STATE)) {
    notes.push("owner storageState missing (tests/e2e/.auth/owner.json) — visited anonymously");
  }
  if (role === "member" && !fs.existsSync(MEMBER_STATE)) {
    notes.push("member storageState missing (tests/e2e/.auth/member.json) — visited anonymously");
  }
  if (role === "admin" && !ADMIN_SECRET) {
    notes.push(
      "MATFLOW_ADMIN_SECRET not set — admin pages visited anonymously and will redirect to /admin/login",
    );
  }
  return notes;
}

function isAuthenticated(role: Role): boolean {
  if (role === "anonymous") return false;
  if (role === "admin") return !!ADMIN_SECRET;
  return !!storageStateFor(role);
}

async function makeContext(browser: Browser, role: Role, viewport: Viewport): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.isMobile ? 2 : 1,
    isMobile: viewport.isMobile,
    hasTouch: viewport.isMobile,
    reducedMotion: "reduce",
    storageState: storageStateFor(role),
    // Keep captures free of the browser's own locale noise.
    locale: "en-GB",
    timezoneId: "Europe/London",
  });

  if (role === "admin" && ADMIN_SECRET) {
    const origin = new URL(baseURL()).origin;
    await ctx.addCookies([
      { name: "matflow_admin", value: ADMIN_SECRET, url: origin, httpOnly: true, sameSite: "Strict" },
    ]);
  }

  if (role === "member") {
    // The first-run wizard correctly blocks everything behind it; suppress it
    // so the harvester photographs the real pages (noted on every member row).
    // Seeding localStorage used to do this and no longer does anything — the
    // wizard is gated on the server's Member.onboardingCompleted now.
    await suppressOnboardingWizard(ctx);
  }

  return ctx;
}

function baseURL(): string {
  return process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3847";
}

// ---------------------------------------------------------------------------
// Dynamic-route resolution
// ---------------------------------------------------------------------------

const resolvedDynamic = new Map<string, { url: string | null; reason?: string }>();
let cachedMemberId: string | null | undefined;

async function withRolePage<T>(
  browser: Browser,
  role: Role,
  fn: (page: Page) => Promise<T>,
): Promise<T | null> {
  const ctx = await makeContext(browser, role, ALL_VIEWPORTS[0]);
  const page = await ctx.newPage();
  try {
    return await fn(page);
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }
}

async function firstHrefMatching(page: Page, listUrl: string, re: RegExp): Promise<string | null> {
  const res = await page.goto(listUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
  if (!res) return null;
  await page.waitForLoadState("networkidle").catch(() => {});
  const hrefs = await page
    .$$eval("a[href]", (anchors) => anchors.map((a) => a.getAttribute("href") ?? ""))
    .catch(() => [] as string[]);
  return hrefs.find((h) => re.test(h)) ?? null;
}

async function resolveMemberId(browser: Browser): Promise<string | null> {
  if (cachedMemberId !== undefined) return cachedMemberId;
  cachedMemberId = await withRolePage(browser, "owner", async (page) => {
    const href = await firstHrefMatching(
      page,
      "/dashboard/members",
      /^\/dashboard\/members\/[^/?#]+$/,
    );
    if (href) return href.split("/").filter(Boolean).pop() ?? null;

    // Fallback: the staff roster API. Same cookies as the page context.
    const res = await page.request.get("/api/members?limit=5").catch(() => null);
    if (res?.ok()) {
      const json = (await res.json().catch(() => null)) as { members?: Array<{ id?: string }> } | null;
      return json?.members?.[0]?.id ?? null;
    }
    return null;
  });
  return cachedMemberId;
}

/** POSTs from inside a page so the browser supplies a same-origin Origin header. */
async function postFromPage(
  page: Page,
  url: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return page.evaluate(
    async ({ url: u, body: b }) => {
      const res = await fetch(u, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, json };
    },
    { url, body },
  );
}

async function resolveDynamic(route: string, browser: Browser): Promise<{ url: string | null; reason?: string }> {
  const cached = resolvedDynamic.get(route);
  if (cached) return cached;

  let result: { url: string | null; reason?: string } = {
    url: null,
    reason: `no resolver for dynamic route ${route}`,
  };

  if (route === "/dashboard/members/[id]") {
    const id = await resolveMemberId(browser);
    result = id
      ? { url: `/dashboard/members/${id}` }
      : { url: null, reason: "could not resolve a member id from /dashboard/members or /api/members" };
  } else if (route === "/dashboard/members/[id]/waiver" || route === "/dashboard/members/[id]/dsar") {
    const id = await resolveMemberId(browser);
    const tail = route.endsWith("/waiver") ? "waiver" : "dsar";
    result = id
      ? { url: `/dashboard/members/${id}/${tail}` }
      : { url: null, reason: "could not resolve a member id" };
  } else if (route === "/member/family/[childId]") {
    const childId = await withRolePage(browser, "member", async (page) => {
      for (const listUrl of ["/member/profile", "/member/home"]) {
        const href = await firstHrefMatching(page, listUrl, /^\/member\/family\/[^/?#]+/);
        if (href) return href.split("/").filter(Boolean)[2] ?? null;
      }
      const res = await page.request.get("/api/member/home").catch(() => null);
      if (res?.ok()) {
        const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        const kids = (json?.children ?? json?.family) as Array<{ id?: string }> | undefined;
        return kids?.[0]?.id ?? null;
      }
      return null;
    });
    result = childId
      ? { url: `/member/family/${childId}` }
      : {
          url: null,
          reason: "seeded member has no linked child account — family detail page not reachable",
        };
  } else if (route === "/member/purchase/pack/[id]") {
    const packId = await withRolePage(browser, "member", async (page) => {
      const href = await firstHrefMatching(page, "/member/shop", /^\/member\/purchase\/pack\/[^/?#]+/);
      if (href) return href.split("/").filter(Boolean).pop() ?? null;
      const res = await page.request.get("/api/member/class-packs").catch(() => null);
      if (res?.ok()) {
        const json = (await res.json().catch(() => null)) as { available?: Array<{ id?: string }> } | null;
        return json?.available?.[0]?.id ?? null;
      }
      return null;
    });
    result = packId
      ? { url: `/member/purchase/pack/${packId}` }
      : { url: null, reason: "no active class pack on the tenant — purchase page not reachable" };
  } else if (route === "/kiosk/[token]") {
    const token = await withRolePage(browser, "owner", async (page) => {
      await page.goto("/dashboard/settings", { waitUntil: "domcontentloaded" }).catch(() => {});
      // enable → 409 when already enabled → regenerate. Regenerating
      // INVALIDATES the tenant's previous kiosk URL (test branch only).
      let res = await postFromPage(page, "/api/settings/kiosk", { action: "enable" });
      if (res.status === 409) {
        res = await postFromPage(page, "/api/settings/kiosk", { action: "regenerate" });
      }
      const raw = res.json.rawToken;
      return typeof raw === "string" ? raw : null;
    });
    result = token
      ? { url: `/kiosk/${token}` }
      : { url: null, reason: "could not mint a kiosk token via POST /api/settings/kiosk" };
  } else if (route === "/waiver/open?token=[token]") {
    const link = await withRolePage(browser, "owner", async (page) => {
      const id = await resolveMemberId(browser);
      if (!id) return null;
      await page.goto(`/dashboard/members/${id}`, { waitUntil: "domcontentloaded" }).catch(() => {});
      const res = await postFromPage(page, `/api/members/${id}/waiver-link`, {});
      const url = res.json.url;
      if (typeof url !== "string") return null;
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    });
    result = link
      ? { url: link }
      : {
          url: null,
          reason:
            "could not mint an open-waiver link (member may have already signed, or no member id resolved)",
        };
  }

  resolvedDynamic.set(route, result);
  return result;
}

// ---------------------------------------------------------------------------
// axe
// ---------------------------------------------------------------------------

interface RawAxeResults {
  violations: Array<{
    id: string;
    impact: string | null;
    help: string;
    tags: string[];
    nodes: Array<{ target: string[] }>;
  }>;
}

async function runAxe(page: Page, relFile: string): Promise<AxeSummary> {
  if (!AXE_SOURCE) {
    return {
      available: false,
      reason:
        "axe: unavailable — @axe-core/playwright is not a dependency and node_modules/axe-core/axe.min.js was not found",
    };
  }

  // addScriptTag first; fall back to evaluate() which bypasses any page CSP.
  try {
    await page.addScriptTag({ content: AXE_SOURCE });
  } catch {
    try {
      await page.evaluate(AXE_SOURCE);
    } catch (err) {
      return { available: false, reason: `axe: injection failed — ${(err as Error).message}` };
    }
  }

  try {
    const raw = await page.evaluate(async (tags: string[]) => {
      const w = window as unknown as {
        axe?: { run: (ctx: Document, opts: unknown) => Promise<RawAxeResults> };
      };
      if (!w.axe) return null;
      return await w.axe.run(document, {
        resultTypes: ["violations"],
        runOnly: { type: "tag", values: tags },
      });
    }, AXE_TAGS);

    if (!raw) {
      return { available: false, reason: "axe: injected but window.axe was not defined" };
    }

    const violations: AxeViolation[] = raw.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? null,
      help: v.help,
      tags: v.tags,
      nodes: v.nodes.length,
      sampleTargets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
    }));

    const fullPath = path.join(OUT_ROOT, relFile);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, JSON.stringify(raw, null, 2), "utf8");

    return {
      available: true,
      source: `node_modules/axe-core${AXE_VERSION ? `@${AXE_VERSION}` : ""} (injected)`,
      violationCount: violations.length,
      seriousOrCritical: violations.filter((v) => v.impact === "serious" || v.impact === "critical").length,
      violations,
      file: relFile.replace(/\\/g, "/"),
    };
  } catch (err) {
    return { available: false, reason: `axe: run failed — ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

const FREEZE_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;}html{scroll-behavior:auto!important;}`;

async function capture(
  ctx: BrowserContext,
  target: Target,
  viewport: Viewport,
): Promise<CaptureRow> {
  const started = Date.now();
  const notes = [...target.notes, ...authNotesFor(target.role)];
  if (target.surface === "member") {
    notes.push("member first-run wizard suppressed: /api/member/home rewritten to onboardingCompleted=true");
  }

  const row: CaptureRow = {
    surface: target.surface,
    slug: target.slug,
    route: target.route,
    url: target.url ?? null,
    fullUrl: target.url ? new URL(target.url, baseURL()).toString() : null,
    finalUrl: null,
    viewport: viewport.name,
    viewportSize: `${viewport.width}x${viewport.height}`,
    role: target.role,
    authenticated: isAuthenticated(target.role),
    status: null,
    ok: false,
    title: null,
    screenshot: null,
    screenshotFullPage: false,
    consoleErrors: [],
    pageErrors: [],
    navigationError: null,
    skipped: null,
    axe: { available: false, reason: "not attempted" },
    notes,
    capturedAt: new Date().toISOString(),
    durationMs: 0,
  };

  if (!target.url) {
    row.skipped = "no concrete URL — dynamic route could not be resolved";
    row.axe = { available: false, reason: "page never loaded" };
    row.durationMs = Date.now() - started;
    return row;
  }

  const page = await ctx.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") row.consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => row.pageErrors.push(err.message));

  try {
    const res = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    row.status = res?.status() ?? null;
    row.ok = res !== null && res.status() < 400;
  } catch (err) {
    row.navigationError = (err as Error).message;
  }

  // Let client-side data land, then freeze motion so shots are deterministic.
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});
  await page.waitForTimeout(500);

  row.finalUrl = page.url();
  row.title = await page.title().catch(() => null);

  const relShot = path.join("shots", target.surface, `${target.slug}--${viewport.name}.png`);
  const shotPath = path.join(OUT_ROOT, relShot);
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  try {
    await page.screenshot({ path: shotPath, fullPage: true, animations: "disabled", caret: "hide" });
    row.screenshot = relShot.replace(/\\/g, "/");
    row.screenshotFullPage = true;
  } catch (err) {
    // Chromium refuses full-page captures beyond ~16384px; a viewport shot is
    // still worth having, and the fallback is recorded rather than hidden.
    try {
      await page.screenshot({ path: shotPath, fullPage: false, animations: "disabled", caret: "hide" });
      row.screenshot = relShot.replace(/\\/g, "/");
      row.screenshotFullPage = false;
      row.notes.push(`full-page screenshot failed, captured viewport only — ${(err as Error).message}`);
    } catch (err2) {
      row.notes.push(`screenshot failed entirely — ${(err2 as Error).message}`);
    }
  }

  row.axe = await runAxe(page, path.join("axe", target.surface, `${target.slug}--${viewport.name}.json`));

  await page.close().catch(() => {});
  row.durationMs = Date.now() - started;
  return row;
}

// ---------------------------------------------------------------------------
// Manifest shards + merge
// ---------------------------------------------------------------------------

function partPath(surface: Surface, viewport: ViewportName): string {
  return path.join(PARTS_DIR, `${surface}--${viewport}.json`);
}

function writePart(surface: Surface, viewport: ViewportName, rows: CaptureRow[]): void {
  fs.mkdirSync(PARTS_DIR, { recursive: true });
  fs.writeFileSync(partPath(surface, viewport), JSON.stringify(rows, null, 2), "utf8");
}

function mergeManifest(): void {
  let rows: CaptureRow[] = [];
  try {
    for (const file of fs.readdirSync(PARTS_DIR)) {
      if (!file.endsWith(".json")) continue;
      const parsed = JSON.parse(fs.readFileSync(path.join(PARTS_DIR, file), "utf8")) as CaptureRow[];
      rows = rows.concat(parsed);
    }
  } catch {
    /* no shards yet */
  }

  rows.sort(
    (a, b) =>
      a.surface.localeCompare(b.surface) ||
      a.slug.localeCompare(b.slug) ||
      a.viewport.localeCompare(b.viewport),
  );

  const manifest = {
    meta: {
      generatedAt: new Date().toISOString(),
      generator: "tests/e2e/audit/harvest.spec.ts",
      baseURL: baseURL(),
      outputRoot: OUT_ROOT.replace(/\\/g, "/"),
      viewports: VIEWPORTS.map((v) => ({ name: v.name, size: `${v.width}x${v.height}` })),
      surfaces: SURFACES,
      routesDiscovered: DISCOVERED.length,
      extraCaptures: EXTRA_TARGETS.length,
      axe: AXE_SOURCE
        ? { available: true, source: `node_modules/axe-core${AXE_VERSION ? `@${AXE_VERSION}` : ""}`, tags: AXE_TAGS }
        : { available: false, reason: "axe: unavailable" },
      auth: {
        owner: fs.existsSync(OWNER_STATE) ? "storageState" : "missing",
        member: fs.existsSync(MEMBER_STATE) ? "storageState" : "missing",
        admin: ADMIN_SECRET ? "MATFLOW_ADMIN_SECRET cookie" : "unauthenticated (no MATFLOW_ADMIN_SECRET)",
      },
      totals: {
        captures: rows.length,
        loaded: rows.filter((r) => r.ok).length,
        failedOrErrored: rows.filter((r) => !r.ok && !r.skipped).length,
        unreachable: rows.filter((r) => r.skipped).length,
        withConsoleErrors: rows.filter((r) => r.consoleErrors.length > 0).length,
        withPageErrors: rows.filter((r) => r.pageErrors.length > 0).length,
      },
    },
    captures: rows,
  };

  fs.mkdirSync(OUT_ROOT, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.beforeAll(() => {
  // Never harvest production — screenshots would contain real member PII and
  // the kiosk-token mint would invalidate a live kiosk URL.
  const db = process.env.DATABASE_URL ?? "";
  if (db.includes("ep-bold-wave")) {
    throw new Error(
      "harvest refused to run: DATABASE_URL points at the PROD Neon branch (ep-bold-wave). Use the .env.test branch.",
    );
  }

  if (process.env.AUDIT_KEEP !== "1") {
    for (const dir of [SHOTS_DIR, AXE_DIR, PARTS_DIR]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const dir of [OUT_ROOT, SHOTS_DIR, AXE_DIR, PARTS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

for (const viewport of VIEWPORTS) {
  for (const surface of SURFACES) {
    const targets = ALL_TARGETS.filter((t) => t.surface === surface);
    if (targets.length === 0) continue;

    test(`harvest ${surface} @ ${viewport.name} (${targets.length} pages)`, async ({ browser }) => {
      // Resolve dynamic routes once (cached across viewports).
      const resolved: Target[] = [];
      for (const t of targets) {
        if (t.url) {
          resolved.push(t);
          continue;
        }
        const dyn = await resolveDynamic(t.route, browser);
        resolved.push({
          ...t,
          url: dyn.url ?? undefined,
          notes: dyn.reason ? [...t.notes, dyn.reason] : t.notes,
        });
      }

      // One context per role in this surface, reused across its pages; a fresh
      // PAGE per capture keeps console/page-error collection isolated.
      const contexts = new Map<Role, BrowserContext>();
      const rows: CaptureRow[] = [];

      try {
        for (const target of resolved) {
          let ctx = contexts.get(target.role);
          if (!ctx) {
            ctx = await makeContext(browser, target.role, viewport);
            contexts.set(target.role, ctx);
          }
          try {
            rows.push(await capture(ctx, target, viewport));
          } catch (err) {
            // A harvester must never lose a route to an exception.
            rows.push({
              surface: target.surface,
              slug: target.slug,
              route: target.route,
              url: target.url ?? null,
              fullUrl: target.url ? new URL(target.url, baseURL()).toString() : null,
              finalUrl: null,
              viewport: viewport.name,
              viewportSize: `${viewport.width}x${viewport.height}`,
              role: target.role,
              authenticated: isAuthenticated(target.role),
              status: null,
              ok: false,
              title: null,
              screenshot: null,
              screenshotFullPage: false,
              consoleErrors: [],
              pageErrors: [],
              navigationError: `harvester threw: ${(err as Error).message}`,
              skipped: null,
              axe: { available: false, reason: "capture threw before axe ran" },
              notes: target.notes,
              capturedAt: new Date().toISOString(),
              durationMs: 0,
            });
          }
          // Write after every page so a killed run still leaves usable data.
          writePart(surface, viewport.name, rows);
          mergeManifest();
        }
      } finally {
        for (const ctx of contexts.values()) await ctx.close().catch(() => {});
      }

      writePart(surface, viewport.name, rows);
      mergeManifest();
    });
  }
}

test.afterAll(() => {
  mergeManifest();
});
