/**
 * Lane L-F shared fixtures — member portal and month-end (J49–J59).
 *
 * NOT a `.spec.ts`: Playwright must not collect it.
 *
 * Column one (member on a fresh club) is Lane A0's. This lane drives every
 * OTHER role of J49–J59 on the seeded club `totalbjj` plus every attack, so
 * everything here is about (a) minting run-stamped members / parents / kids /
 * classes / products the seeded rows cannot contaminate, and (b) signing in as
 * roles that have no storageState file.
 *
 * Nothing here touches a seeded class, a seeded member's card, the seeded
 * club's kiosk token, or a rate-limit bucket it does not reset.
 */
import bcrypt from "bcryptjs";
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { RUN_STAMP, sql, seededTenantId } from "../helpers/db";

export const CLUB_SLUG = "totalbjj";
export const OWNER_EMAIL = "owner@totalbjj.com";
export const COACH_EMAIL = "coach@totalbjj.com";
export const ADMIN_EMAIL = "admin@totalbjj.com";
/** The seeded member the `chromium-member` storageState is minted from. */
export const MEMBER_EMAIL = process.env.TEST_MEMBER_EMAIL ?? "jordan@example.com";
export const PASSWORD = process.env.TEST_PASSWORD ?? "password123";
export const THROWAWAY_PASSWORD = "Hillcrest!2026aA";

/** Per-worker scope so two workers cannot collide on @@unique([tenantId, email]). */
export const SCOPE = `${RUN_STAMP}-lf-w${process.env.TEST_PARALLEL_INDEX ?? "0"}`;

export const PHONE = { width: 390, height: 844 } as const;
export const TABLET = { width: 768, height: 1024 } as const;

// ── Sessions ─────────────────────────────────────────────────────────────────

const sessions = new Map<string, BrowserContext>();

export interface SessionOptions {
  email: string;
  password?: string;
  slug?: string;
  /** Phone roles (coach, member, parent) run at 390x844 with isMobile. */
  viewport?: { width: number; height: number };
  isMobile?: boolean;
  fresh?: boolean;
}

/**
 * Copied from tests/e2e/campaign/authorisation.spec.ts:84-106 with the
 * `waitForURL` widened per COMMON: a throwaway account of a club mid-onboarding
 * lands on /onboarding and a TOTP-enrolled account lands on /totp — both are
 * successful logins and the narrow /dashboard|member/ wait would time out.
 *
 * Keyed on slug|email|width because the same address can exist in two clubs and
 * a session handed back for the wrong club would make the refusal under test
 * pass for the wrong reason.
 */
export async function sessionFor(
  browser: Browser,
  baseURL: string,
  opts: SessionOptions,
): Promise<BrowserContext> {
  const slug = opts.slug ?? CLUB_SLUG;
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
  // run every "as a parent" assertion as the seeded owner.
  await context.clearCookies();

  const page = await context.newPage();
  await page.goto(`/login?club=${slug}`);
  await page.waitForSelector("input[type='email']", { timeout: 60_000 });
  await page.fill("input[type='email']", opts.email);
  await page.fill("input[type='password']", opts.password ?? PASSWORD);
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

// ── Request helpers ──────────────────────────────────────────────────────────

/**
 * `maxRedirects: 0` on EVERY call.
 *
 * Playwright's request context follows redirects by default and reports only
 * the FINAL status, so a route that answers an auth failure with a redirect
 * arrives as `200 text/html` — the login PAGE — and the spec reads it as
 * "allowed". Refusing to follow makes a refusal visible as a refusal.
 *
 * Round 1 fix (another lane): an unauthenticated /api/* call now answers a
 * bare `401 { ok: false, error: "Unauthorized" }` instead of the 307 to
 * /login it used to send, so this is exactly 401 and no longer a pair.
 */
export const ANON_REFUSED = [401] as const;

export interface ApiResult {
  status: number;
  body: unknown;
  text: string;
  contentType: string;
  location: string | null;
}

export async function apiCall(
  rc: APIRequestContext,
  method: "get" | "post" | "patch" | "delete" | "put",
  url: string,
  origin: string,
  data?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<ApiResult> {
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

/** A GET with no Origin header — the shape a fresh read takes. */
export function apiGet(rc: APIRequestContext, url: string) {
  return apiCall(rc, "get", url, "");
}

/**
 * `{ ok: false, error }` through lib/api-authz; a bare `{ error }` on the
 * routes that hand-roll their gate with `auth()`. The caller names which,
 * because asserting the wrong one hides a real change in the refusal contract.
 */
export function expectRefusal(
  r: ApiResult,
  flavour: "ok-false" | "bare-error",
  label: string,
): void {
  const b = r.body as Record<string, unknown>;
  if (flavour === "ok-false") {
    expect(b.ok, `${label}: refusal carries ok:false`).toBe(false);
  }
  expect(typeof b.error, `${label}: refusal carries a human error string`).toBe("string");
}

export function describeResponse(label: string, r: ApiResult): void {
  console.log(
    `[L-F probe] ${label} → status=${r.status} content-type=${r.contentType} location=${
      r.location ?? "none"
    } body[0..160]=${JSON.stringify(r.text.slice(0, 160))}`,
  );
}

// ── Counting ─────────────────────────────────────────────────────────────────

export async function countOf(table: string, where = "TRUE", params: unknown[] = []): Promise<number> {
  const rows = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}" WHERE ${where}`, params);
  return Number(rows[0].n);
}

export async function assertUnchanged(
  table: string,
  before: number,
  label: string,
  where = "TRUE",
  params: unknown[] = [],
): Promise<void> {
  const after = await countOf(table, where, params);
  expect(after, `${label}: ${table} count(*) across a refused request`).toBe(before);
}

// ── Layout (the COMMON contract, asserted on every screen) ───────────────────

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

/** A refused PAGE is a redirect — assert the final URL, never "200 iff allowed". */
export async function finalPath(page: Page, path: string): Promise<string> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  return new URL(page.url()).pathname;
}

// ── Run-stamped fixtures ─────────────────────────────────────────────────────

export interface LfMember {
  id: string;
  name: string;
  email: string;
}

/**
 * A member of the seeded club with a real password, so it can hold a session.
 * `accountType` defaults to `adult`; pass `parent` for the parent column.
 *
 * The CHECK constraint `Member_kids_must_have_parent` means a `kids` row MUST
 * carry `parentMemberId` — `mkKid` below is the only way this lane makes one.
 */
export async function mkMember(
  over: Partial<{
    name: string;
    accountType: string;
    status: string;
    paymentStatus: string;
    withPassword: boolean;
    membershipType: string | null;
    dateOfBirth: Date | null;
  }> = {},
): Promise<LfMember> {
  const tenantId = await seededTenantId();
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = over.name ?? `${RUN_STAMP} Member ${suffix}`;
  const email = `${SCOPE}-${suffix}@example.test`;
  const rows = await sql<{ id: string }>(
    `INSERT INTO "Member" ("id", "tenantId", "name", "email", "passwordHash", "status",
                           "paymentStatus", "accountType", "membershipType", "dateOfBirth",
                           "onboardingCompleted", "joinedAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, true, now(), now())
     RETURNING id`,
    [
      tenantId,
      name,
      email,
      over.withPassword === false ? null : bcrypt.hashSync(THROWAWAY_PASSWORD, 10),
      over.status ?? "active",
      over.paymentStatus ?? "paid",
      over.accountType ?? "adult",
      over.membershipType ?? null,
      over.dateOfBirth ?? null,
    ],
  );
  return { id: rows[0].id, name, email };
}

/**
 * A kids Member. `Member_kids_must_have_parent` is a CHECK constraint — a kids
 * row without `parentMemberId` is rejected by the database, so the parent id is
 * a required argument here rather than an option.
 */
export async function mkKid(parentMemberId: string, name?: string): Promise<LfMember> {
  const tenantId = await seededTenantId();
  const suffix = Math.random().toString(36).slice(2, 8);
  const kidName = name ?? `${RUN_STAMP} Kid ${suffix}`;
  // Kid accounts carry a synthesised no-inbox placeholder in production; mirror
  // that shape so the "structural email" branch of PATCH /api/member/me is the
  // one under test rather than an accident of the fixture.
  const email = `${SCOPE}-kid-${suffix}@no-login.matflow.local`;
  const dob = new Date();
  dob.setFullYear(dob.getFullYear() - 9);
  const rows = await sql<{ id: string }>(
    `INSERT INTO "Member" ("id", "tenantId", "name", "email", "status", "paymentStatus",
                           "accountType", "parentMemberId", "dateOfBirth", "joinedAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'active', 'paid', 'kids', $4, $5, now(), now())
     RETURNING id`,
    [tenantId, kidName, email, parentMemberId, dob],
  );
  return { id: rows[0].id, name: kidName, email };
}

export async function mkStaff(
  role: "owner" | "manager" | "coach" | "admin",
): Promise<{ id: string; email: string; name: string; role: string }> {
  const tenantId = await seededTenantId();
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `${SCOPE}-${role}-${suffix}@example.test`;
  const name = `Campaign ${role} ${suffix}`;
  const rows = await sql<{ id: string }>(
    `INSERT INTO "User" ("id", "tenantId", "email", "name", "passwordHash", "role",
                         "sessionVersion", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 0, now(), now())
     RETURNING id`,
    [tenantId, email, name, bcrypt.hashSync(THROWAWAY_PASSWORD, 10), role],
  );
  return { id: rows[0].id, email, name, role };
}

export async function mkClass(
  tenantId: string,
  name: string,
  over: Partial<{ duration: number; maxCapacity: number | null; isActive: boolean }> = {},
): Promise<string> {
  const rows = await sql<{ id: string }>(
    `INSERT INTO "Class" ("id", "tenantId", "name", "duration", "maxCapacity", "isActive", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, now())
     RETURNING id`,
    [tenantId, name, over.duration ?? 60, over.maxCapacity ?? null, over.isActive ?? true],
  );
  return rows[0].id;
}

export async function mkSchedule(
  classId: string,
  over: Partial<{ dayOfWeek: number; startTime: string; endTime: string }> = {},
): Promise<string> {
  const rows = await sql<{ id: string }>(
    `INSERT INTO "ClassSchedule" ("id", "classId", "dayOfWeek", "startTime", "endTime", "isActive")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, true)
     RETURNING id`,
    [classId, over.dayOfWeek ?? 3, over.startTime ?? "18:00", over.endTime ?? "19:00"],
  );
  return rows[0].id;
}

/**
 * `ClassInstance.date` is `timestamp(3)` WITHOUT a zone and Prisma round-trips
 * it as a UTC wall clock; node-pg handed a JS Date writes the LOCAL wall clock.
 * The `timestamptz AT TIME ZONE 'UTC'` cast stores exactly what Prisma would —
 * the pattern authorisation.spec.ts:205-213 documents in full.
 */
export async function mkInstance(
  classId: string,
  over: Partial<{ startTime: string; endTime: string; date: Date; isCancelled: boolean }> = {},
): Promise<string> {
  const base = over.date ?? (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d; })();
  const rows = await sql<{ id: string }>(
    `INSERT INTO "ClassInstance" ("id", "classId", "date", "startTime", "endTime", "isCancelled")
     VALUES (gen_random_uuid()::text, $1, ($2::timestamptz AT TIME ZONE 'UTC'), $3, $4, $5)
     RETURNING id`,
    [classId, base.toISOString(), over.startTime ?? "18:00", over.endTime ?? "19:00", over.isCancelled ?? false],
  );
  return rows[0].id;
}

export async function mkProduct(
  tenantId: string,
  over: Partial<{ name: string; pricePence: number; category: string; inStock: boolean }> = {},
): Promise<{ id: string; name: string; pricePence: number }> {
  const name = over.name ?? `${RUN_STAMP} Rash guard`;
  const pricePence = over.pricePence ?? 2500;
  const rows = await sql<{ id: string }>(
    `INSERT INTO "Product" ("id", "tenantId", "name", "pricePence", "currency", "category",
                            "inStock", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'GBP', $4, $5, now(), now())
     RETURNING id`,
    [tenantId, name, pricePence, over.category ?? "clothing", over.inStock ?? true],
  );
  return { id: rows[0].id, name, pricePence };
}

/** A second club this lane owns outright — the other half of every cross-tenant attack. */
export interface LfTenant {
  id: string;
  slug: string;
  classId: string;
  memberId: string;
  productId: string;
  announcementId: string;
  rankSystemId: string;
}

export async function mkTenant(): Promise<LfTenant> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const slug = `${RUN_STAMP}-lf-${suffix}`.toLowerCase();
  // `Tenant` has NO `updatedAt` column (prisma/schema.prisma) — naming it is
  // the mistake that cost Lane L-B its first round. Name only what we set.
  const rows = await sql<{ id: string }>(
    `INSERT INTO "Tenant" ("id", "name", "slug", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, now())
     RETURNING id`,
    [`Campaign LF Club ${suffix}`, slug],
  );
  const tenantId = rows[0].id;

  const classId = await mkClass(tenantId, `${RUN_STAMP} Foreign class`);
  const members = await sql<{ id: string }>(
    `INSERT INTO "Member" ("id", "tenantId", "name", "email", "status", "paymentStatus",
                           "accountType", "joinedAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'active', 'paid', 'adult', now(), now())
     RETURNING id`,
    [tenantId, `${RUN_STAMP} Foreign member`, `${SCOPE}-foreign-${suffix}@example.test`],
  );
  const products = await sql<{ id: string }>(
    `INSERT INTO "Product" ("id", "tenantId", "name", "pricePence", "currency", "category",
                            "inStock", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, 1500, 'GBP', 'other', true, now(), now())
     RETURNING id`,
    [tenantId, `${RUN_STAMP} Foreign product`],
  );
  const anns = await sql<{ id: string }>(
    `INSERT INTO "Announcement" ("id", "tenantId", "title", "body", "pinned", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, false, now())
     RETURNING id`,
    [tenantId, `${RUN_STAMP} Foreign notice`, "Do not read this from another club."],
  );
  const ranks = await sql<{ id: string }>(
    `INSERT INTO "RankSystem" ("id", "tenantId", "discipline", "name", "order", "stripes")
     VALUES (gen_random_uuid()::text, $1, 'bjj', $2, 900, 0)
     RETURNING id`,
    [tenantId, `${RUN_STAMP} Foreign belt`],
  );

  return {
    id: tenantId,
    slug,
    classId,
    memberId: members[0].id,
    productId: products[0].id,
    announcementId: anns[0].id,
    rankSystemId: ranks[0].id,
  };
}

export async function teardownTenant(t: LfTenant): Promise<void> {
  await sql('DELETE FROM "ClassSubscription" WHERE "classId" IN (SELECT id FROM "Class" WHERE "tenantId" = $1)', [t.id]).catch(() => {});
  await sql('DELETE FROM "ClassWaitlist" WHERE "classInstanceId" IN (SELECT i.id FROM "ClassInstance" i JOIN "Class" c ON c.id = i."classId" WHERE c."tenantId" = $1)', [t.id]).catch(() => {});
  await sql('DELETE FROM "ClassInstance" WHERE "classId" IN (SELECT id FROM "Class" WHERE "tenantId" = $1)', [t.id]).catch(() => {});
  await sql('DELETE FROM "ClassSchedule" WHERE "classId" IN (SELECT id FROM "Class" WHERE "tenantId" = $1)', [t.id]).catch(() => {});
  await sql('DELETE FROM "ClassRoster" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  await sql('DELETE FROM "Class" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  await sql('DELETE FROM "Announcement" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  await sql('DELETE FROM "Product" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  await sql('DELETE FROM "Order" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  await sql('DELETE FROM "Payment" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  await sql('DELETE FROM "Task" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  await sql('DELETE FROM "AuditLog" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  await sql('DELETE FROM "PushSubscription" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  // RankHistory → MemberRank → Member: tables without tenantId reached by parent.
  await sql('DELETE FROM "RankHistory" WHERE "memberRankId" IN (SELECT mr.id FROM "MemberRank" mr JOIN "Member" m ON m.id = mr."memberId" WHERE m."tenantId" = $1)', [t.id]).catch(() => {});
  await sql('DELETE FROM "MemberRank" WHERE "memberId" IN (SELECT id FROM "Member" WHERE "tenantId" = $1)', [t.id]).catch(() => {});
  await sql('DELETE FROM "RankSystem" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  await sql('DELETE FROM "Member" WHERE "tenantId" = $1 AND "parentMemberId" IS NOT NULL', [t.id]).catch(() => {});
  await sql('DELETE FROM "Member" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  await sql('DELETE FROM "User" WHERE "tenantId" = $1', [t.id]).catch(() => {});
  await sql('DELETE FROM "Tenant" WHERE id = $1', [t.id]);
  // Verified by a post-delete SELECT, not by the absence of an error (rule 5).
  const left = await sql<{ id: string }>('SELECT id FROM "Tenant" WHERE id = $1', [t.id]);
  expect(left, "L-F throwaway tenant is gone").toEqual([]);
}

/**
 * Everything THIS lane stamped in the seeded club, children before parents.
 *
 * Scoped to `SCOPE` (`${RUN_STAMP}-lf-w<n>`) and not the bare RUN_STAMP, so a
 * lane running beside us never has its rows swept by our teardown.
 */
export async function teardownSeededClub(): Promise<void> {
  const tenantId = await seededTenantId();
  const classIds = (
    await sql<{ id: string }>('SELECT id FROM "Class" WHERE "tenantId" = $1 AND name LIKE $2', [tenantId, `${RUN_STAMP}%`])
  ).map((r) => r.id);
  const memberIds = (
    await sql<{ id: string }>('SELECT id FROM "Member" WHERE "tenantId" = $1 AND email LIKE $2', [tenantId, `${SCOPE}-%`])
  ).map((r) => r.id);
  const userIds = (
    await sql<{ id: string }>('SELECT id FROM "User" WHERE "tenantId" = $1 AND email LIKE $2', [tenantId, `${SCOPE}-%`])
  ).map((r) => r.id);

  if (classIds.length) {
    await sql('DELETE FROM "ClassPackRedemption" WHERE "attendanceRecordId" IN (SELECT a.id FROM "AttendanceRecord" a JOIN "ClassInstance" i ON i.id = a."classInstanceId" WHERE i."classId" = ANY($1))', [classIds]).catch(() => {});
    await sql('DELETE FROM "AttendanceRecord" WHERE "classInstanceId" IN (SELECT id FROM "ClassInstance" WHERE "classId" = ANY($1))', [classIds]).catch(() => {});
    await sql('DELETE FROM "ClassWaitlist" WHERE "classInstanceId" IN (SELECT id FROM "ClassInstance" WHERE "classId" = ANY($1))', [classIds]).catch(() => {});
    await sql('DELETE FROM "ClassSubscription" WHERE "classId" = ANY($1)', [classIds]).catch(() => {});
    await sql('DELETE FROM "ClassRoster" WHERE "classId" = ANY($1)', [classIds]).catch(() => {});
    await sql('DELETE FROM "ClassInstance" WHERE "classId" = ANY($1)', [classIds]).catch(() => {});
    await sql('DELETE FROM "ClassSchedule" WHERE "classId" = ANY($1)', [classIds]).catch(() => {});
    await sql('DELETE FROM "Class" WHERE id = ANY($1)', [classIds]);
  }

  if (memberIds.length) {
    await sql('DELETE FROM "ClassSubscription" WHERE "memberId" = ANY($1)', [memberIds]).catch(() => {});
    await sql('DELETE FROM "ClassWaitlist" WHERE "memberId" = ANY($1)', [memberIds]).catch(() => {});
    await sql('DELETE FROM "PushSubscription" WHERE "memberId" = ANY($1)', [memberIds]).catch(() => {});
    await sql('DELETE FROM "Task" WHERE "assigneeMemberId" = ANY($1)', [memberIds]).catch(() => {});
    await sql('DELETE FROM "Order" WHERE "memberId" = ANY($1)', [memberIds]).catch(() => {});
    await sql('DELETE FROM "Payment" WHERE "memberId" = ANY($1)', [memberIds]).catch(() => {});
    await sql('DELETE FROM "SignedWaiver" WHERE "memberId" = ANY($1)', [memberIds]).catch(() => {});
    await sql('DELETE FROM "RankHistory" WHERE "memberRankId" IN (SELECT id FROM "MemberRank" WHERE "memberId" = ANY($1))', [memberIds]).catch(() => {});
    await sql('DELETE FROM "MemberRank" WHERE "memberId" = ANY($1)', [memberIds]).catch(() => {});
    // Children before parents — Member.parentMemberId is a self FK.
    await sql('DELETE FROM "Member" WHERE id = ANY($1) AND "parentMemberId" IS NOT NULL', [memberIds]);
    await sql('DELETE FROM "Member" WHERE id = ANY($1)', [memberIds]);
  }

  if (userIds.length) {
    await sql('DELETE FROM "PasswordHistory" WHERE "userId" = ANY($1)', [userIds]).catch(() => {});
    await sql('DELETE FROM "Task" WHERE "createdById" = ANY($1) OR "assignedToId" = ANY($1) OR "completedById" = ANY($1)', [userIds]).catch(() => {});
    await sql('DELETE FROM "AuditLog" WHERE "userId" = ANY($1)', [userIds]).catch(() => {});
    await sql('DELETE FROM "LoginEvent" WHERE "userId" = ANY($1)', [userIds]).catch(() => {});
    await sql('DELETE FROM "User" WHERE id = ANY($1)', [userIds]);
  }

  await sql('DELETE FROM "Product" WHERE "tenantId" = $1 AND name LIKE $2', [tenantId, `${RUN_STAMP}%`]).catch(() => {});
  await sql('DELETE FROM "Announcement" WHERE "tenantId" = $1 AND title LIKE $2', [tenantId, `${RUN_STAMP}%`]).catch(() => {});
  await sql('DELETE FROM "Task" WHERE "tenantId" = $1 AND title LIKE $2', [tenantId, `${RUN_STAMP}%`]).catch(() => {});
  // MonthlyReport has no `createdAt` — the stamp is `generatedAt`
  // (prisma/schema.prisma). Compared in SQL against the database's own clock.
  await sql(
    `DELETE FROM "MonthlyReport"
     WHERE "tenantId" = $1 AND "generatedAt" > (now() AT TIME ZONE 'UTC') - interval '2 hours'`,
    [tenantId],
  ).catch(() => {});
  await sql('DELETE FROM "RankSystem" WHERE "tenantId" = $1 AND name LIKE $2', [tenantId, `${RUN_STAMP}%`]).catch(() => {});

  // Rule 5: verify by a post-delete SELECT, not by the absence of an error.
  const leftMembers = await countOf("Member", 'email LIKE $1', [`${SCOPE}-%`]);
  expect(leftMembers, "L-F run-stamped members are gone from the seeded club").toBe(0);
  const leftUsers = await countOf("User", 'email LIKE $1', [`${SCOPE}-%`]);
  expect(leftUsers, "L-F run-stamped staff are gone from the seeded club").toBe(0);
}

/** Buckets are shared rows keyed on an IP every lane shares — clear what you exhaust. */
export async function clearBucket(prefix: string): Promise<void> {
  await sql('DELETE FROM "RateLimitHit" WHERE bucket LIKE $1', [`${prefix}%`]).catch(() => {});
}

export { sql, RUN_STAMP, seededTenantId };
