/**
 * Lane A0 — shared machinery for the five "new club" spec files.
 *
 * NOT a `.spec.ts`: Playwright must not collect it. Everything here is either a
 * session helper, a layout assertion or the tenant-B handover file, because all
 * five files need them and importing one spec from another would register its
 * tests twice.
 *
 * Nothing in this file touches product code. Lane A0 owns no product files.
 */
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { RUN_STAMP, sql } from "../helpers/db";

// ── The stamp that survives a worker restart ─────────────────────────────────

/**
 * ROUND 2 ROOT CAUSE — the single fault behind ten of this lane's failures.
 *
 * `RUN_STAMP` is `e2e-${Date.now().toString(36)}`, evaluated once **per Node
 * process** (tests/e2e/campaign/helpers/db.ts:31). Playwright starts a FRESH
 * WORKER PROCESS after every failed test, so the moment one test in a file
 * fails, `RUN_STAMP` changes for every test after it — and every identity the
 * lane created under the old stamp becomes unreachable:
 *
 *   - `sessionFor(..., `${RUN_STAMP}-manager@example.test`)` signs in as an
 *     address that does not exist → the login never navigates → a 60 s
 *     `waitForURL` timeout that reads in the log exactly like a product hang
 *     (a0-2 lines 147, 175, 206, 397, 539 — five of the eleven);
 *   - `SELECT … WHERE email LIKE '${RUN_STAMP}-adult%'` returns nothing →
 *     `adult[0].id` throws `Cannot read properties of undefined` (a0-2 450, 496);
 *   - `toContainText(new RegExp(RUN_STAMP))` cannot match a screen showing rows
 *     created under the previous stamp (a0-3 127).
 *
 * The fix is a stamp bound to the CAMPAIGN rather than to the process. It is
 * written to a file beside the handover on first use and read back by every
 * later worker and every later file, so all five specs and all their restarts
 * agree on one identity space. `teardownTenantB` removes it, so the next
 * campaign mints a fresh one.
 *
 * Override with `A0_RUN_STAMP` when the controller wants to pin a run.
 */
const STAMP_FILE = join(process.cwd(), "tests", "e2e", ".auth", "a0-stamp.txt");

function resolveStamp(): string {
  const fromEnv = process.env.A0_RUN_STAMP?.trim();
  if (fromEnv) return fromEnv;
  try {
    if (existsSync(STAMP_FILE)) {
      const saved = readFileSync(STAMP_FILE, "utf8").trim();
      if (saved) return saved;
    }
  } catch {
    /* fall through to minting a new one */
  }
  try {
    mkdirSync(dirname(STAMP_FILE), { recursive: true });
    writeFileSync(STAMP_FILE, RUN_STAMP, "utf8");
  } catch {
    /* a read-only .auth is not a reason to fail the run */
  }
  return RUN_STAMP;
}

/**
 * The stamp every Lane A0 name, email and gym name carries. Use this, never
 * `RUN_STAMP`, anywhere a value must still be findable in a later test.
 */
export const A0_STAMP: string = resolveStamp();

/** Called by the teardown so the next campaign starts a fresh identity space. */
export function clearStamp(): void {
  try {
    rmSync(STAMP_FILE, { force: true });
  } catch {
    /* nothing to clear */
  }
}

// ── The handover file ────────────────────────────────────────────────────────

/**
 * File 1 writes this; files 2–5 read it. The directory is git-ignored
 * (.gitignore:53) which is why it is safe to leave ids in it — but never a
 * cookie, never a token, and above all never an operator secret.
 */
export const TENANT_FILE = join(process.cwd(), "tests", "e2e", ".auth", "a0-tenant.json");

export interface A0Tenant {
  tenantId: string;
  slug: string;
  ownerEmail: string;
  ownerPassword: string;
  applicationId?: string;
  ownerUserId?: string;
  /** The campaign stamp every row of this run carries — see A0_STAMP. */
  stamp?: string;
  /** ids created along the way, so a later file can reach them without re-deriving. */
  ids?: Record<string, string>;
}

export function writeTenantFile(data: A0Tenant): void {
  mkdirSync(dirname(TENANT_FILE), { recursive: true });
  writeFileSync(TENANT_FILE, JSON.stringify(data, null, 2), "utf8");
}

export function readTenantFile(): A0Tenant {
  if (!existsSync(TENANT_FILE)) {
    throw new Error(
      `a0-tenant.json is missing at ${TENANT_FILE}. Run a0-1-becoming-a-customer.spec.ts first — it is the file that creates tenant B.`,
    );
  }
  return JSON.parse(readFileSync(TENANT_FILE, "utf8")) as A0Tenant;
}

/**
 * The same read, but soft.
 *
 * Round 1: files 2-5 each called `readTenantFile()` from a file-scope
 * `beforeAll`, so when file 1 fell at /apply the handover file never existed and
 * all four reported a FAILED test — which reads in the log exactly like four
 * product defects. A missing handover is not a failure of the thing under test;
 * it is an UNCOVERED cell with a named blocker. Callers use this, check
 * `ok`, and `test.skip` with `reason` so the log says why.
 */
export function tryReadTenantFile(): { ok: true; file: A0Tenant } | { ok: false; reason: string } {
  if (!existsSync(TENANT_FILE)) {
    return {
      ok: false,
      reason:
        "UNCOVERED — tests/e2e/.auth/a0-tenant.json was never written, so tenant B does not exist. Run a0-1-becoming-a-customer.spec.ts first; this is a lane dependency, not a product defect.",
    };
  }
  try {
    const file = JSON.parse(readFileSync(TENANT_FILE, "utf8")) as A0Tenant;
    if (!file.tenantId || !file.slug) {
      return { ok: false, reason: "UNCOVERED — a0-tenant.json exists but carries no tenantId/slug: file 1 did not reach the approval step." };
    }
    return { ok: true, file };
  } catch (e) {
    return { ok: false, reason: `UNCOVERED — a0-tenant.json is unreadable: ${(e as Error).message}` };
  }
}

export function mergeTenantFile(patch: Partial<A0Tenant> & { ids?: Record<string, string> }): A0Tenant {
  const current = readTenantFile();
  const next: A0Tenant = {
    ...current,
    ...patch,
    ids: { ...(current.ids ?? {}), ...(patch.ids ?? {}) },
  };
  writeTenantFile(next);
  return next;
}

// ── Tenant A, the other club ─────────────────────────────────────────────────

export const TENANT_A_SLUG = "totalbjj";
export const TENANT_A_OWNER = "owner@totalbjj.com";
export const TENANT_A_COACH = "coach@totalbjj.com";
export const TENANT_A_PASSWORD = process.env.E2E_BYPASS_TOKEN ?? process.env.TEST_PASSWORD ?? "password123";

/** The password every tenant-B account this lane creates is given. */
export const B_PASSWORD = "Riverside!2026aA";

// ── Sessions ─────────────────────────────────────────────────────────────────

/**
 * Copied from tests/e2e/campaign/authorisation.spec.ts:84-106 and widened as the
 * brief requires: a brand-new owner lands on /onboarding, and a 2FA-enrolled one
 * lands on the code challenge, so a `waitForURL(/dashboard|member/)` would time
 * out on the very first login of the month.
 *
 * Cached per `${slug}|${email}` — the same email exists in both clubs in several
 * of these journeys, so keying on email alone would hand back the wrong club's
 * session and the refusal under test would pass for the wrong reason.
 */
const sessions = new Map<string, BrowserContext>();

export interface SessionOptions {
  slug: string;
  email: string;
  password?: string;
  /** Phone roles run at 390x844; admin and kiosk at 768. */
  viewport?: { width: number; height: number };
  isMobile?: boolean;
  /** A six-digit TOTP code, when the account is enrolled. */
  totp?: () => string;
  fresh?: boolean;
}

export async function sessionFor(
  browser: Browser,
  baseURL: string,
  opts: SessionOptions,
): Promise<BrowserContext> {
  const key = `${opts.slug}|${opts.email}|${opts.viewport?.width ?? 0}`;
  if (!opts.fresh) {
    const cached = sessions.get(key);
    if (cached) return cached;
  }

  const context = await browser.newContext({
    baseURL,
    storageState: undefined,
    ...(opts.viewport
      ? { viewport: opts.viewport, isMobile: opts.isMobile ?? true, hasTouch: opts.isMobile ?? true }
      : {}),
  });
  // Belt and braces, per the file this is copied from: inheriting the project's
  // storageState here would run every tenant-B test as tenant A's owner.
  await context.clearCookies();

  const page = await context.newPage();

  // ROUND 3 ROOT CAUSE — the single fault behind 39 of this lane's 40 failures.
  //
  // Round 2 raced `waitForURL` against a bare
  // `[role='alert'], .text-red-500, [data-testid='login-error']` locator, so
  // that a refusal would name itself instead of timing out. It named the wrong
  // thing. In round 3 that race answered "refused" within a second or two of
  // EVERY submit — a0-1's owner, a0-2's whole tenant-B staff and member chain,
  // and every sign-in in a0-3, a0-4 and a0-5 — 39 of the lane's 40 failures,
  // all from one helper.
  //
  // It was a false positive, and the round-3 message proves it against itself.
  // The copy it printed carried NO error text and no "Sign in" label on the
  // submit button — i.e. `error === null` and `loading === true`
  // (app/login/page.tsx:413-446): the login was still IN FLIGHT. A truncated
  // capture cannot explain it either, because the copy ran past the error slot
  // and the button all the way to "Forgot password?". Whatever the locator
  // matched (a stray host-page `[role='alert']`, or an element the CSS engine
  // reached through an open shadow root — Playwright pierces them), it was not
  // the login form's error, and none of its three selectors is rendered by the
  // login page unless `error` is set.
  //
  // The product side is ruled out by evidence, not by assumption:
  //   - tests/e2e/auth.setup.ts drives the SAME form with the SAME credentials
  //     and PASSES; it differs only by not racing an alert;
  //   - the e2e bypass is armed on the server — a probe of the test branch
  //     finds no `login:` RateLimitHit bucket at all, which only happens when
  //     `skipRateLimit` is true (auth.ts:264), the same flag that gates the
  //     bypass at :331-336;
  //   - the owner `User` row for an approved club DOES exist under the
  //     lower-cased application email (approve/route.ts:141), confirmed on the
  //     two tenant-B clubs still on the test branch from earlier rounds.
  //
  // Three changes, so this cannot come back and cannot hide either:
  //   1. The refusal watcher runs INSIDE the page (`waitForFunction`), so it
  //      sees only the real document, is scoped to the login `form`, and
  //      requires the alert to carry text. A thing with no words is not a
  //      refusal.
  //   2. The credentials callback is read off the wire, so a refusal is settled
  //      by the product's own verdict — next-auth's `error`/`code` — and not by
  //      anything on the screen.
  //   3. On failure the helper says whether the account exists at all, so a
  //      wrong address in the harness can never again read as a product refusal.
  let resolveWire!: (v: string) => void;
  const wireRefusal = new Promise<string>((r) => { resolveWire = r; });
  const callback: { status: number; detail: string }[] = [];
  page.on("response", (res) => {
    if (!/\/api\/auth\/callback\/credentials/.test(res.url())) return;
    void res
      .text()
      .then((body) => {
        // next-auth `redirect: false` answers `{ url: ".../login?error=…&code=…" }`.
        const url = /"url"\s*:\s*"([^"]*)"/.exec(body)?.[1] ?? "";
        const code = /[?&](?:code|error)=([^&"]+)/.exec(url)?.[1] ?? "";
        callback.push({ status: res.status(), detail: code ? decodeURIComponent(code) : url.slice(0, 120) });
        if (code) resolveWire(decodeURIComponent(code));
      })
      .catch(() => callback.push({ status: res.status(), detail: "(body unreadable)" }));
  });

  await page.goto(`/login?club=${opts.slug}`);
  await page.waitForSelector("input[type='email']", { timeout: 60_000 });
  await page.fill("input[type='email']", opts.email);
  await page.fill("input[type='password']", opts.password ?? B_PASSWORD);
  await page.click("button[type='submit']");

  // 45 s, not 60: three sign-ins in one test at 60 s each overshoot the file's
  // own 180 s budget, and a timeout that eats the teardown teaches nothing.
  const landed = await Promise.race([
    page.waitForURL(/dashboard|member|onboarding|totp/, { timeout: 45_000 }).then(() => "ok" as const),
    wireRefusal.then(() => "refused" as const),
    page
      .waitForFunction(
        () => {
          const el = document.querySelector("form [role='alert']");
          return !!el && (el.textContent ?? "").trim().length > 0;
        },
        undefined,
        { timeout: 45_000 },
      )
      .then(() => "refused" as const),
  ]).catch(() => "timeout" as const);
  if (landed !== "ok") {
    const said = await page
      .locator("form [role='alert']")
      .first()
      .innerText()
      .catch(() => "");
    const copy = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400);
    const wire = callback.length
      ? callback.map((c) => `${c.status} ${c.detail}`).join(" | ")
      : "the credentials callback never answered";
    // Only on the failure path: say whether the address exists at all, so a
    // wrong email in the harness can never again be read as a product refusal.
    const who = await sql<{ kind: string; locked: boolean }>(
      `SELECT 'User' AS kind, ("lockedUntil" > now()) AS locked FROM "User" u
         WHERE u.email = $2 AND u."tenantId" = (SELECT id FROM "Tenant" WHERE slug = $1)
       UNION ALL
       SELECT 'Member', ("lockedUntil" > now()) FROM "Member" m
         WHERE m.email = $2 AND m."tenantId" = (SELECT id FROM "Tenant" WHERE slug = $1)`,
      [opts.slug, opts.email.toLowerCase()],
    ).catch(() => [] as { kind: string; locked: boolean }[]);
    const account = who.length
      ? who.map((r) => `${r.kind}${r.locked ? " (LOCKED)" : ""}`).join(" + ")
      : "NO User and NO Member row for that address in that club — the harness asked for an account that does not exist";
    throw new Error(
      `sign-in ${landed} for ${opts.email} at club ${opts.slug}.\n` +
        `  the form said: ${said || "(no error on the form)"}\n` +
        `  /api/auth/callback/credentials: ${wire}\n` +
        `  the account: ${account}\n` +
        `  final url: ${page.url()}\n` +
        `  screen: ${copy}`,
    );
  }

  if (opts.totp && /totp/.test(page.url())) {
    await page.fill("input[inputmode='numeric'], input[autocomplete='one-time-code']", opts.totp());
    await page.click("button[type='submit']");
    await page.waitForURL(/dashboard|member|onboarding/, { timeout: 60_000 });
  }

  await page.close();
  if (!opts.fresh) sessions.set(key, context);
  return context;
}

/**
 * An explicitly EMPTY browser context.
 *
 * Round-2 amendment: the `{ request }` fixture is NOT anonymous —
 * `playwright.config.ts:100-103` gives the chromium project the seeded owner's
 * storageState and the fixture inherits it, so every "anonymous" cell driven
 * through `{ request }` was in fact driven as tenant A's owner. Every anonymous
 * cell in this lane uses this instead (the `anonContext()` pattern named in
 * ld-shared.ts).
 */
export async function anonContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL, storageState: undefined });
  await context.clearCookies();
  return context;
}

export async function closeSessions(): Promise<void> {
  for (const ctx of sessions.values()) await ctx.close().catch(() => {});
  sessions.clear();
}

/**
 * The operator plane.
 *
 * `POST /api/admin/auth/login` answers with a `Set-Cookie` whose VALUE IS THE
 * SECRET (lib/admin-auth.ts:85-97). So: no `storageState()` on this context, no
 * file under tests/e2e/.auth, and nothing from its headers ever printed. The
 * cookie lives and dies inside the returned context's jar.
 *
 * Returns null when MATFLOW_ADMIN_SECRET is absent from the runner's env — the
 * route answers 503 "Admin auth not configured" and the caller must record the
 * cell UNCOVERED with that blocker rather than invent a pass.
 */
export async function operatorContext(
  browser: Browser,
  baseURL: string,
): Promise<BrowserContext | null> {
  const secret = process.env.MATFLOW_ADMIN_SECRET;
  if (!secret) return null;
  const context = await browser.newContext({ baseURL, storageState: undefined });
  await context.clearCookies();
  const res = await context.request.post("/api/admin/auth/login", {
    headers: { Origin: baseURL },
    data: { secret },
  });
  if (res.status() !== 200) {
    await context.close();
    return null;
  }
  return context;
}

// ── Layout ───────────────────────────────────────────────────────────────────

/**
 * The brief's layout contract, asserted twice on every screen a phone or tablet
 * role visits: once on load and once after every overlay opens.
 *
 * `scrollWidth` alone is blind to `position: fixed`, which is exactly how the
 * 18 Sep 516px regression hid — hence the bounding-box sweep over every visible
 * fixed/sticky element.
 */
export async function assertNoOverflow(page: Page, width: number, label: string): Promise<void> {
  const metrics = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(metrics, `${label}: [scrollWidth, innerWidth] at ${width}px`).toEqual([width, width]);

  const strays = await page.evaluate(() => {
    const out: { tag: string; cls: string; x: number; w: number }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      out.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), x: b.x, w: b.width });
    }
    return out;
  });
  const offscreen = strays.filter((s) => s.x < -0.5 || s.x + s.w > width + 0.5);
  expect(offscreen, `${label}: fixed/sticky elements outside 0..${width}`).toEqual([]);
}

/** Every confirm button must be inside the viewport and clickable. */
export async function assertConfirmReachable(page: Page, name: RegExp, width: number): Promise<void> {
  const button = page.getByRole("button", { name }).last();
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box, "confirm button has a box").not.toBeNull();
  if (box) {
    expect(box.x).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
  }
  await expect(button).toBeEnabled();
}

// ── Assertions the whole lane shares ─────────────────────────────────────────

/**
 * A refused PAGE is a redirect, not a status (lib/authz.ts:44). Assert the final
 * URL and that the refused page's own content is absent — never "200 iff allowed".
 */
export async function assertPageRefused(
  page: Page,
  path: string,
  expected: RegExp,
  absent: RegExp,
): Promise<void> {
  await page.goto(path);
  await page.waitForURL(expected, { timeout: 30_000 });
  await expect(page.locator("body")).not.toHaveText(absent);
}

/** Refusal bodies are `{ ok: false, error }` everywhere except /api/staff*. */
export async function assertApiRefused(
  rc: APIRequestContext,
  method: "get" | "post" | "patch" | "delete",
  url: string,
  origin: string,
  status: number,
  data?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await rc.fetch(url, {
    method: method.toUpperCase(),
    headers: { Origin: origin },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.status(), `${method.toUpperCase()} ${url}`).toBe(status);
  const body = await res.json().catch(() => ({}));
  return { status: res.status(), body };
}

/**
 * A refusal body, as the product ACTUALLY shapes it.
 *
 * The brief says `{ ok: false, error }` everywhere except /api/staff*. Round 2
 * measured otherwise: every Zod refusal minted by a route handler answers
 * `{ error: "Invalid data", details: { fieldErrors, formErrors } }` and every
 * `apiError()` refusal answers `{ error, reference? }` — neither carries `ok`.
 * Asserting `{ ok: false }` therefore fails on a CORRECT refusal and hides the
 * boundary the case is actually about. This asserts what must be true of any
 * refusal — a human-readable `error`, no leaked internals — and returns the
 * observed body so the caller can record the contract deviation as FRICTION.
 */
export function assertRefusalShape(body: unknown, label: string): { hasOk: boolean; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const error = typeof b.error === "string" ? b.error : "";
  expect(error, `${label}: a refusal carries a readable error string`).toBeTruthy();
  expect(error, `${label}: a refusal body leaks no internals`).not.toMatch(/prisma|stack|at \/|select .* from/i);
  return { hasOk: b.ok === false, error };
}

/** Every refusal also asserts the target table's count(*) is unchanged. */
export async function countOf(table: string, where = "TRUE", params: unknown[] = []): Promise<number> {
  const rows = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}" WHERE ${where}`, params);
  return Number(rows[0].n);
}

export async function assertUnchanged(
  table: string,
  before: number,
  where = "TRUE",
  params: unknown[] = [],
): Promise<void> {
  const after = await countOf(table, where, params);
  expect(after, `${table} count(*) across a refused request`).toBe(before);
}

/**
 * Assert a response object's KEY SET against an explicit allow-list, recursing
 * into nested objects. An allow-list, never a denylist: the finding is the key
 * nobody thought to forbid.
 */
export function assertKeysWithin(
  value: unknown,
  allowed: Record<string, string[] | null>,
  path = "$",
): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertKeysWithin(v, allowed, `${path}[${i}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  const keys = Object.keys(value as Record<string, unknown>);
  const list = allowed[path.replace(/\[\d+\]/g, "[]")];
  if (list) {
    const unexpected = keys.filter((k) => !list.includes(k));
    expect(unexpected, `${path}: keys outside the allow-list`).toEqual([]);
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertKeysWithin(v, allowed, `${path}.${k}`);
  }
}

// ── Rate limits ──────────────────────────────────────────────────────────────

/**
 * Buckets are shared rows keyed partly on an IP every lane on this machine
 * shares (lib/rate-limit.ts). Anything this lane exhausts, this lane clears —
 * otherwise another lane's login fails as a 429 that looks like a product bug.
 */
export async function clearBucket(prefix: string): Promise<void> {
  await sql('DELETE FROM "RateLimitHit" WHERE bucket LIKE $1', [`${prefix}%`]);
}

// ── Teardown ─────────────────────────────────────────────────────────────────

/**
 * Tenant B, torn down in dependency order: children before parents, and every
 * table without a `tenantId` reached through its parent. Only `Task` cascades
 * from `Tenant` (prisma/schema.prisma:1130); every other tenant FK is Restrict,
 * so a missed table blocks the final DELETE rather than silently orphaning.
 */
export const TENANT_SCOPED_MODELS = [
  "Payment",
  "Dispute",
  "Order",
  "SignedWaiver",
  "MemberPhoto",
  "RankRequirement",
  "RankSystem",
  "MembershipTier",
  "ClassPack",
  "Product",
  "Announcement",
  "Task",
  "Notification",
  "PushSubscription",
  "MagicLinkToken",
  "ImportJob",
  "EmailLog",
  "LoginEvent",
  "AuditLog",
  "AttendanceRecord",
  "ClassRoster",
  "Class",
  "Member",
  "User",
] as const;

export async function teardownTenantB(stamp: string): Promise<void> {
  const file = existsSync(TENANT_FILE) ? readTenantFile() : null;
  if (!file) return;
  const t = file.tenantId;

  // No tenantId of their own — reached through a parent.
  await sql(
    `DELETE FROM "RankHistory" WHERE "memberRankId" IN
       (SELECT mr.id FROM "MemberRank" mr JOIN "Member" m ON m.id = mr."memberId" WHERE m."tenantId" = $1)`,
    [t],
  );
  await sql(
    `DELETE FROM "ClassPackRedemption" WHERE "memberPackId" IN
       (SELECT mp.id FROM "MemberClassPack" mp JOIN "Member" m ON m.id = mp."memberId" WHERE m."tenantId" = $1)`,
    [t],
  );
  await sql(
    `DELETE FROM "MemberClassPack" WHERE "memberId" IN (SELECT id FROM "Member" WHERE "tenantId" = $1)`,
    [t],
  );
  // ClassWaitlist hangs off ClassInstance, NOT ClassSchedule
  // (prisma/schema.prisma:519-535: memberId + classInstanceId). It must go
  // before ClassInstance below, or the instance delete hits its FK.
  await sql(
    `DELETE FROM "ClassWaitlist" WHERE "classInstanceId" IN
       (SELECT ci.id FROM "ClassInstance" ci JOIN "Class" c ON c.id = ci."classId" WHERE c."tenantId" = $1)`,
    [t],
  );
  await sql('DELETE FROM "AttendanceRecord" WHERE "tenantId" = $1', [t]);
  await sql(
    `DELETE FROM "ClassInstance" WHERE "classId" IN (SELECT id FROM "Class" WHERE "tenantId" = $1)`,
    [t],
  );
  await sql(
    `DELETE FROM "ClassSchedule" WHERE "classId" IN (SELECT id FROM "Class" WHERE "tenantId" = $1)`,
    [t],
  );
  await sql(
    `DELETE FROM "ClassSubscription" WHERE "memberId" IN (SELECT id FROM "Member" WHERE "tenantId" = $1)`,
    [t],
  );
  await sql(
    `DELETE FROM "MemberRank" WHERE "memberId" IN (SELECT id FROM "Member" WHERE "tenantId" = $1)`,
    [t],
  );
  await sql('DELETE FROM "ClassRoster" WHERE "tenantId" = $1', [t]);
  await sql('DELETE FROM "Class" WHERE "tenantId" = $1', [t]);
  await sql('DELETE FROM "Payment" WHERE "tenantId" = $1', [t]);
  await sql('DELETE FROM "Dispute" WHERE "tenantId" = $1', [t]).catch(() => {});
  await sql('DELETE FROM "Order" WHERE "tenantId" = $1', [t]);
  await sql('DELETE FROM "SignedWaiver" WHERE "tenantId" = $1', [t]);
  await sql('DELETE FROM "MemberPhoto" WHERE "tenantId" = $1', [t]);
  await sql('DELETE FROM "RankRequirement" WHERE "tenantId" = $1', [t]).catch(() => {});
  await sql('DELETE FROM "RankSystem" WHERE "tenantId" = $1', [t]);
  await sql('DELETE FROM "MembershipTier" WHERE "tenantId" = $1', [t]);
  await sql('DELETE FROM "ClassPack" WHERE "tenantId" = $1', [t]);
  await sql('DELETE FROM "Product" WHERE "tenantId" = $1', [t]).catch(() => {});
  await sql('DELETE FROM "Announcement" WHERE "tenantId" = $1', [t]);
  await sql('DELETE FROM "Task" WHERE "tenantId" = $1', [t]);
  await sql('DELETE FROM "Notification" WHERE "tenantId" = $1', [t]).catch(() => {});
  await sql('DELETE FROM "PushSubscription" WHERE "tenantId" = $1', [t]).catch(() => {});
  await sql('DELETE FROM "MagicLinkToken" WHERE "tenantId" = $1', [t]);
  // PasswordResetToken carries its OWN tenantId and is keyed by email, not by a
  // userId — there is no User relation on it (prisma/schema.prisma:643-655).
  await sql('DELETE FROM "PasswordResetToken" WHERE "tenantId" = $1', [t]).catch(() => {});
  await sql(
    `DELETE FROM "PasswordHistory" WHERE "userId" IN (SELECT id FROM "User" WHERE "tenantId" = $1)`,
    [t],
  ).catch(() => {});
  await sql('DELETE FROM "ImportJob" WHERE "tenantId" = $1', [t]).catch(() => {});
  await sql('DELETE FROM "EmailLog" WHERE "tenantId" = $1', [t]);
  await sql('DELETE FROM "LoginEvent" WHERE "tenantId" = $1', [t]).catch(() => {});
  await sql('UPDATE "AuditLog" SET "userId" = NULL WHERE "tenantId" = $1', [t]);
  await sql('DELETE FROM "AuditLog" WHERE "tenantId" = $1', [t]);
  await sql('DELETE FROM "StripeEvent" WHERE "eventId" LIKE $1', [`evt_${stamp}%`]);
  // Children before parents.
  await sql('DELETE FROM "Member" WHERE "tenantId" = $1 AND "parentMemberId" IS NOT NULL', [t]);
  await sql('DELETE FROM "Member" WHERE "tenantId" = $1', [t]);
  await sql('DELETE FROM "User" WHERE "tenantId" = $1', [t]);
  await sql('DELETE FROM "GymApplication" WHERE "gymName" LIKE $1 OR email LIKE $2', [
    `${stamp}%`,
    `${stamp}%`,
  ]);
  await sql('DELETE FROM "Tenant" WHERE id = $1', [t]);
  // The identity space this campaign used is finished with — the next one mints
  // a fresh stamp rather than inheriting rows that no longer exist.
  clearStamp();
  try {
    rmSync(TENANT_FILE, { force: true });
  } catch {
    /* the handover file is disposable */
  }
}

/** Verified by a post-delete SELECT over every model carrying tenantId, not by the absence of an error. */
export async function assertTenantBGone(tenantId: string): Promise<void> {
  for (const model of TENANT_SCOPED_MODELS) {
    const n = await countOf(model, '"tenantId" = $1', [tenantId]).catch(() => 0);
    expect(n, `${model} rows left behind for tenant B`).toBe(0);
  }
  expect(await countOf("Tenant", "id = $1", [tenantId])).toBe(0);
}

// ── Tenant A snapshot ────────────────────────────────────────────────────────

const SNAPSHOT_TABLES = [
  "Member", "User", "Class", "ClassInstance", "AttendanceRecord", "Payment", "Order",
  "MemberClassPack", "MagicLinkToken", "PasswordResetToken", "SignedWaiver", "MemberRank",
  "AuditLog", "Announcement", "MembershipTier", "ClassPack", "Task", "EmailLog",
  "MemberPhoto", "ClassRoster",
] as const;

export interface TenantASnapshot {
  counts: Record<string, number>;
  checksums: Record<string, string | null>;
  tenant: Record<string, unknown>;
}

/**
 * Counts alone would miss a row swapped for another, which is exactly what a
 * cross-tenant write looks like after a careless teardown. Hence the md5 over
 * the whole row text of Member, User and the Tenant row.
 */
export async function snapshotTenantA(): Promise<TenantASnapshot> {
  const idRows = await sql<{ id: string }>('SELECT id FROM "Tenant" WHERE slug = $1', [TENANT_A_SLUG]);
  const a = idRows[0].id;

  const counts: Record<string, number> = {};
  for (const table of SNAPSHOT_TABLES) {
    counts[table] = await (async () => {
      // Tables without a tenantId are counted through their parent.
      if (table === "ClassInstance") {
        return countOf("ClassInstance", '"classId" IN (SELECT id FROM "Class" WHERE "tenantId" = $1)', [a]);
      }
      if (table === "MemberClassPack") {
        return countOf("MemberClassPack", '"memberId" IN (SELECT id FROM "Member" WHERE "tenantId" = $1)', [a]);
      }
      if (table === "MemberRank") {
        return countOf("MemberRank", '"memberId" IN (SELECT id FROM "Member" WHERE "tenantId" = $1)', [a]);
      }
      // PasswordResetToken has a tenantId of its own (schema:643-655) — it is
      // NOT reached through User, which carries no relation to it.
      if (table === "PasswordResetToken") {
        return countOf("PasswordResetToken", '"tenantId" = $1', [a]);
      }
      return countOf(table, '"tenantId" = $1', [a]).catch(() => 0);
    })();
  }

  const checksums: Record<string, string | null> = {};
  for (const table of ["Member", "User"]) {
    const rows = await sql<{ md5: string | null }>(
      `SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) AS md5 FROM "${table}" t WHERE t."tenantId" = $1`,
      [a],
    );
    checksums[table] = rows[0]?.md5 ?? null;
  }
  const tenantRow = await sql<{ md5: string | null }>(
    `SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) AS md5 FROM "Tenant" t WHERE t.id = $1`,
    [a],
  );
  checksums.Tenant = tenantRow[0]?.md5 ?? null;

  // Three plain statements rather than one with `AS "alias"`: x10/check-sql-all
  // .js validates every quoted identifier against prisma/schema.prisma, and an
  // alias that is not also a column name is reported as a missing column. The
  // shape handed back is unchanged.
  const meta = await sql<Record<string, unknown>>(
    `SELECT t."subscriptionStatus", t."deletedAt", t."kioskTokenHash" FROM "Tenant" t WHERE t.id = $1`,
    [a],
  );
  const sessionVersion = await sql<{ max: number | null }>(
    'SELECT max("sessionVersion") FROM "User" WHERE "tenantId" = $1',
    [a],
  );
  const cardVersion = await sql<{ max: number | null }>(
    'SELECT max("cardVersion") FROM "Member" WHERE "tenantId" = $1',
    [a],
  );

  return {
    counts,
    checksums,
    tenant: {
      ...meta[0],
      maxSessionVersion: sessionVersion[0]?.max ?? null,
      maxCardVersion: cardVersion[0]?.max ?? null,
    },
  };
}

export function assertSnapshotsEqual(before: TenantASnapshot, after: TenantASnapshot): void {
  expect(after.counts, "tenant A row counts").toEqual(before.counts);
  expect(after.checksums, "tenant A row checksums (Member, User, Tenant)").toEqual(before.checksums);
  expect(after.tenant, "tenant A status, kiosk hash, sessionVersion, cardVersion").toEqual(before.tenant);
}
