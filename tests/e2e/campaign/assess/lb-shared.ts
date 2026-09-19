/**
 * Lane L-B — shared machinery for the club-setup-and-staff spec files.
 *
 * NOT a `.spec.ts`: Playwright must not collect it. Everything here is a
 * session/fixture helper the three lb-*.spec.ts files share; importing one
 * spec from another would register its tests twice.
 *
 * Nothing here touches product code.
 */
import { expect, type APIRequestContext, type Browser, type BrowserContext } from "@playwright/test";
import bcrypt from "bcryptjs";
import { sql, RUN_STAMP, seededTenantId } from "../helpers/db";

export const SLUG_A = "totalbjj";
export const OWNER_A = "owner@totalbjj.com";
export const COACH_A = "coach@totalbjj.com";
export const ADMIN_A = "admin@totalbjj.com";
export const MEMBER_A = process.env.TEST_MEMBER_EMAIL ?? "jordan@example.com";
export const PASSWORD_A = process.env.TEST_PASSWORD ?? "password123";

/** The password every throwaway account this lane mints is given. */
export const THROWAWAY_PASSWORD = "Riverside!2026aA";

export type StaffRole = "owner" | "manager" | "coach" | "admin";

// ── Sessions ─────────────────────────────────────────────────────────────────

const sessions = new Map<string, BrowserContext>();

export interface SessionOptions {
  slug?: string;
  email: string;
  password?: string;
  /** Phone roles run at 390x844; admin and kiosk at 768. */
  viewport?: { width: number; height: number };
  isMobile?: boolean;
  fresh?: boolean;
}

/**
 * Copied from tests/e2e/campaign/authorisation.spec.ts:84-106 with the
 * `waitForURL` widened per the brief: a brand-new owner lands on /onboarding
 * and a 2FA-enrolled account lands on the code challenge, so the narrow
 * /dashboard|member/ wait would time out on the first login of the month.
 *
 * Keyed on `${slug}|${email}|${width}` because the same address can exist in
 * two clubs and a session handed back for the wrong club would make the
 * refusal under test pass for the wrong reason.
 */
export async function sessionFor(
  browser: Browser,
  baseURL: string,
  opts: SessionOptions,
): Promise<BrowserContext> {
  const slug = opts.slug ?? SLUG_A;
  const key = `${slug}|${opts.email}|${opts.viewport?.width ?? 0}`;
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
  // Belt and braces: inheriting the chromium project's storageState here would
  // run every "as a coach" assertion as the seeded owner.
  await context.clearCookies();

  const page = await context.newPage();
  await page.goto(`/login?club=${slug}`);
  await page.waitForSelector("input[type='email']", { timeout: 60_000 });
  await page.fill("input[type='email']", opts.email);
  await page.fill("input[type='password']", opts.password ?? PASSWORD_A);
  await page.click("button[type='submit']");
  await page.waitForURL(/dashboard|member|onboarding|totp/, { timeout: 60_000 });
  await page.close();

  if (!opts.fresh) sessions.set(key, context);
  return context;
}

/** A context with no cookies at all — the anonymous column. */
export async function anonContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL, storageState: undefined });
  await context.clearCookies();
  return context;
}

export async function closeSessions(): Promise<void> {
  for (const ctx of sessions.values()) await ctx.close().catch(() => {});
  sessions.clear();
}

// ── Throwaway rows ───────────────────────────────────────────────────────────

export interface ThrowawayStaff {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
}

/**
 * A staff row belonging to this run, in the seeded club.
 *
 * The seed ships owner / coach / admin but NO manager, and J17–J19 need a real
 * manager session. Minting one here rather than promoting a seeded user keeps
 * rule 6 (never damage the seeded club) intact.
 */
export async function createThrowawayStaff(role: StaffRole = "coach"): Promise<ThrowawayStaff> {
  const tenantId = await seededTenantId();
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `${RUN_STAMP}-${role}-${suffix}@example.test`;
  const name = `Campaign ${role} ${suffix}`;
  const rows = await sql<{ id: string }>(
    `INSERT INTO "User" ("id", "tenantId", "email", "name", "passwordHash", "role", "sessionVersion", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 0, now(), now())
     RETURNING id`,
    [tenantId, email, name, bcrypt.hashSync(THROWAWAY_PASSWORD, 10), role],
  );
  return { id: rows[0].id, email, name, role };
}

export interface ThrowawayTenant {
  id: string;
  slug: string;
  ownerEmail: string;
  ownerId: string;
}

/**
 * A second club this lane owns outright — the only place a kiosk token may be
 * rotated (rule 6) and the other half of every cross-tenant attack when Lane
 * A0's handover file is absent. Column-named INSERT so a schema addition with
 * a default cannot break it.
 */
export async function createThrowawayTenant(): Promise<ThrowawayTenant> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const slug = `${RUN_STAMP}-lb-${suffix}`;
  // HARNESS FIX (round 1): `Tenant` has NO `updatedAt` column — the model
  // carries `createdAt` and `deletedAt` only (prisma/schema.prisma:86-87).
  // Naming it made every one of this lane's three files fall at its first
  // case with `column "updatedAt" of relation "Tenant" does not exist`.
  // Every other column is either nullable or defaulted, and the three CHECK
  // constraints on this table (`currency` GBP|EUR|USD, `country`,
  // `checkinWindow*` 0-180 — migration 20260503000001) are all satisfied by
  // their defaults, so name only what this lane actually sets.
  const rows = await sql<{ id: string }>(
    `INSERT INTO "Tenant" ("id", "name", "slug", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, now())
     RETURNING id`,
    [`Campaign Club ${suffix}`, slug],
  );
  const tenantId = rows[0].id;
  const ownerEmail = `${RUN_STAMP}-btowner-${suffix}@example.test`;
  const owners = await sql<{ id: string }>(
    `INSERT INTO "User" ("id", "tenantId", "email", "name", "passwordHash", "role", "sessionVersion", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'owner', 0, now(), now())
     RETURNING id`,
    [tenantId, ownerEmail, `Campaign Owner ${suffix}`, bcrypt.hashSync(THROWAWAY_PASSWORD, 10)],
  );
  return { id: tenantId, slug, ownerEmail, ownerId: owners[0].id };
}

/** Dependency order: every child of this lane's throwaway tenant, then the tenant. */
export async function teardownThrowawayTenant(t: ThrowawayTenant): Promise<void> {
  await sql('DELETE FROM "AuditLog" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  await sql('DELETE FROM "EmailLog" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  await sql('DELETE FROM "LoginEvent" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  await sql('DELETE FROM "MagicLinkToken" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  // InitiativeAttachment has no tenantId — reach it through its parent, and
  // before the parent, or the Initiative delete blocks on the FK.
  await sql(
    `DELETE FROM "InitiativeAttachment" WHERE "initiativeId" IN (SELECT id FROM "Initiative" WHERE "tenantId" = $1)`,
    [t.id],
  ).catch(() => {});
  await sql('DELETE FROM "Initiative" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  await sql(
    `DELETE FROM "PasswordHistory" WHERE "userId" IN (SELECT id FROM "User" WHERE "tenantId" = $1)`,
    [t.id],
  ).catch(() => {});
  await sql(
    `DELETE FROM "PasswordResetToken" WHERE "tenantId" = $1`,
    [t.id],
  ).catch(() => {});
  await sql('DELETE FROM "Member" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  await sql('DELETE FROM "User" WHERE "tenantId" = $1', [t.id]);
  await sql('DELETE FROM "Tenant" WHERE id = $1', [t.id]);
  // Verified by a post-delete SELECT, not by the absence of an error (rule 5).
  const left = await sql<{ id: string }>('SELECT id FROM "Tenant" WHERE id = $1', [t.id]);
  expect(left, "throwaway tenant is gone").toEqual([]);
}

/** Every staff row this run minted in the seeded club, children first. */
export async function teardownThrowawayStaff(): Promise<void> {
  const ids = (
    await sql<{ id: string }>('SELECT id FROM "User" WHERE email LIKE $1', [`${RUN_STAMP}-%@example.test`])
  ).map((r) => r.id);
  if (ids.length === 0) return;
  await sql('DELETE FROM "PasswordHistory" WHERE "userId" = ANY($1)', [ids]).catch(() => {});
  await sql('DELETE FROM "PasswordResetToken" WHERE email IN (SELECT email FROM "User" WHERE id = ANY($1))', [ids]).catch(() => {});
  await sql('DELETE FROM "AuditLog" WHERE "userId" = ANY($1)', [ids]).catch(() => {});
  await sql('DELETE FROM "LoginEvent" WHERE "userId" = ANY($1)', [ids]).catch(() => {});
  await sql('DELETE FROM "User" WHERE id = ANY($1)', [ids]);
  const left = await sql<{ id: string }>('SELECT id FROM "User" WHERE id = ANY($1)', [ids]);
  expect(left, "throwaway staff are gone").toEqual([]);
}

// ── Counting and refusal ─────────────────────────────────────────────────────

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
 * Drive a refused cell at the API and record what came back.
 *
 * Never asserts "200 iff allowed": the caller states the status it expects and
 * the body shape, because `/api/staff` and `/api/staff/[id]` answer `{ error }`
 * while everything else answers `{ ok: false, error }`.
 *
 * HARNESS FIX (round 1): `maxRedirects: 0`. Playwright's request context
 * follows redirects by default and reports only the FINAL status, so a route
 * that answers an auth failure with Next's `NEXT_REDIRECT` (307 → /login)
 * arrives here as `200 text/html` — the login PAGE — and the spec reads it as
 * "allowed". That is precisely the failure `lib/api-authz.ts:1-40` exists to
 * prevent, and it is the shape of the unexplained `anonymous POST /api/staff →
 * 200` in run 1. Refusing to follow makes the redirect visible as a redirect.
 * `contentType` is returned so a non-JSON answer is evidence, not a mystery.
 */
export async function apiCall(
  rc: APIRequestContext,
  method: "get" | "post" | "patch" | "delete" | "put",
  url: string,
  origin: string,
  data?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown; text: string; contentType: string; location: string | null }> {
  const res = await rc.fetch(url, {
    method: method.toUpperCase(),
    headers: { Origin: origin, ...extraHeaders },
    maxRedirects: 0,
    ...(data === undefined ? {} : { data: data as Record<string, unknown> }),
  });
  const headers = res.headers();
  const contentType = headers["content-type"] ?? "";
  const location = headers["location"] ?? null;
  const text = await res.text();
  let body: unknown = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { __nonJson: text.slice(0, 200) };
  }
  return { status: res.status(), body, text, contentType, location };
}

/**
 * Print what a response actually was, for a cell whose status surprised us.
 *
 * Round 1 left one fact unexplained — `POST /api/staff` with no session
 * answered 200, which that handler cannot emit (it returns 201/400/401/403/
 * 409/500 and nothing else). Either the context was not anonymous or a
 * redirect was silently followed. This prints the three facts that separate
 * those hypotheses, so run 2's log settles it without another round trip.
 */
export function describeResponse(
  label: string,
  r: { status: number; contentType: string; location: string | null; text: string },
): void {
  console.log(
    `[L-B probe] ${label} → status=${r.status} content-type=${r.contentType} location=${
      r.location ?? "none"
    } body[0..120]=${JSON.stringify(r.text.slice(0, 120))}`,
  );
}

/** `{ ok: false, error }` everywhere except /api/staff and /api/staff/[id]. */
export function expectRefusalShape(body: unknown, flavour: "ok-false" | "bare-error"): void {
  const b = body as Record<string, unknown>;
  if (flavour === "ok-false") {
    expect(b.ok, "refusal body carries ok:false").toBe(false);
  }
  expect(typeof b.error, "refusal body carries a human error string").toBe("string");
}

// ── Layout (the brief's contract, asserted on every screen) ──────────────────

export async function assertNoOverflow(
  page: import("@playwright/test").Page,
  width: number,
  label: string,
): Promise<void> {
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

/** A refused PAGE is a redirect (lib/authz.ts:44) — assert the final URL. */
export async function finalUrlAfterGoto(
  page: import("@playwright/test").Page,
  path: string,
): Promise<string> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  // The gate redirect is a server 307 the browser has already followed by the
  // time domcontentloaded fires; a short settle covers a client-side push.
  await page.waitForLoadState("networkidle").catch(() => {});
  return new URL(page.url()).pathname;
}

/** Buckets are shared rows keyed on an IP every lane shares — clear what you exhaust. */
export async function clearBucket(prefix: string): Promise<void> {
  await sql('DELETE FROM "RateLimitHit" WHERE bucket LIKE $1', [`${prefix}%`]);
}
