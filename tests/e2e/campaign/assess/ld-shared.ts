/**
 * Lane L-D shared fixtures — timetable and attendance (J31–J41).
 *
 * Column one (owner on a fresh club) is Lane A0's. This lane drives every OTHER
 * role of J31–J41 on the seeded club plus every attack, so everything here is
 * about (a) minting run-stamped classes/instances that the seeded classes'
 * counters cannot contaminate, and (b) signing in as roles that have no
 * storageState file.
 *
 * Nothing in this file touches a seeded class, a seeded member's card, the
 * seeded club's kiosk token, or a rate-limit bucket it does not reset.
 */
import bcrypt from "bcryptjs";
import { createHmac } from "node:crypto";
import type { APIRequestContext, Browser, BrowserContext } from "@playwright/test";
import { RUN_STAMP, sql, seededTenantId } from "../helpers/db";

export const CLUB_SLUG = "totalbjj";
export const OWNER_EMAIL = "owner@totalbjj.com";
export const COACH_EMAIL = "coach@totalbjj.com";
export const ADMIN_EMAIL = "admin@totalbjj.com";
/**
 * The seeded member is `jordan@example.com` (prisma/seed.ts; the same address
 * `tests/e2e/member-auth.setup.ts` mints the member storageState from). Round 2
 * ran against `member@totalbjj.com`, which is not seeded at all — and with
 * TESTING_MODE + E2E_BYPASS_TOKEN set, `auth.ts:454-481` answers an unmatched
 * email with **the club's owner**, so every "member is refused" cell in this
 * lane was silently driven as the owner and read 200/201. See `sessionFor`.
 */
export const MEMBER_EMAIL = "jordan@example.com";
export const PASSWORD = process.env.E2E_BYPASS_TOKEN ?? process.env.TEST_PASSWORD ?? "password123";
export const THROWAWAY_PASSWORD = "Ashgrove!2026aA";

/**
 * Anything hashed with `lib/token-hash.ts` (the kiosk token) is unusable unless
 * this process and the server resolve the SAME secret. With neither set, both
 * sides HMAC with "" — but only if the server also has none, and a mismatch
 * shows up as a bare 404 from every kiosk route, which reads exactly like a
 * product defect. Fail with the reason instead.
 */
export function tokenSecretOrThrow(): string {
  const secret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "Neither NEXTAUTH_SECRET nor AUTH_SECRET is in this process's env. " +
        "Kiosk tokens hashed here cannot match the server's, and every kiosk cell would 404. " +
        "Add a test-only secret to .env.test and restart the guarded server.",
    );
  }
  return secret;
}

/** Per-worker scope so two workers cannot collide on @@unique([tenantId, email]). */
export const SCOPE = `${RUN_STAMP}-w${process.env.TEST_PARALLEL_INDEX ?? "0"}`;

/** Mirrors lib/token-hash.ts, including its secret resolution order. */
export function hashToken(raw: string): string {
  const secret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "";
  return createHmac("sha256", secret).update(raw).digest("hex");
}

// ── Sessions ─────────────────────────────────────────────────────────────────

const sessions = new Map<string, BrowserContext>();

/**
 * Copied from authorisation.spec.ts:84-106, with the waitForURL widened per
 * COMMON: a throwaway staff user of a club mid-onboarding lands on /onboarding,
 * and a member with TOTP lands on /totp — both are successful logins.
 *
 * `landing` is the round-2 hardening. `auth.ts:454-481` escalates ANY unmatched
 * email presented with E2E_BYPASS_TOKEN to the club's owner, so a wrong address
 * does not fail — it silently hands back an owner session and every refusal
 * cell driven with it reads as a success. A member session must land inside
 * /member; pass `MEMBER_LANDING` for it and the escalation fails loudly here
 * rather than six assertions later. (Same guard member-auth.setup.ts:31-34
 * already carries for the storageState it mints.)
 */
export const MEMBER_LANDING = /\/member/;
export const STAFF_LANDING = /dashboard|onboarding|totp/;

export type Device = { viewport: { width: number; height: number }; isMobile: boolean; hasTouch: boolean };

/** COMMON's phone: coach, member and parent cells are driven at 390 x 844. */
export const PHONE: Device = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

export async function sessionFor(
  browser: Browser,
  baseURL: string,
  email: string,
  password: string = PASSWORD,
  slug: string = CLUB_SLUG,
  landing: RegExp = /dashboard|member|onboarding|totp/,
  device?: Device,
): Promise<BrowserContext> {
  // The device is part of the identity of the cached context. `test.use({
  // viewport })` configures the TEST's `page`/`context` fixtures and reaches
  // nothing built here, so a context minted without one takes Playwright's
  // 1280x720 default — which is how the J41 layout cell measured
  // [1280, 1280] at "390" and asserted nothing at all (round 3, ld-1:430).
  const key = `${slug}:${email}:${device ? `${device.viewport.width}x${device.viewport.height}` : "desktop"}`;
  const cached = sessions.get(key);
  if (cached) return cached;

  const context = await browser.newContext({ baseURL, storageState: undefined, ...(device ?? {}) });
  await context.clearCookies();
  const page = await context.newPage();
  await page.goto(`/login?club=${slug}`);
  await page.waitForSelector("input[type='email']", { timeout: 45_000 });
  await page.fill("input[type='email']", email);
  await page.fill("input[type='password']", password);
  await page.click("button[type='submit']");
  await page.waitForURL(landing, { timeout: 45_000 });
  await page.close();

  sessions.set(key, context);
  return context;
}

/** A member session, guarded against the owner-escalation above. */
export function memberSession(browser: Browser, baseURL: string) {
  return sessionFor(browser, baseURL, MEMBER_EMAIL, PASSWORD, CLUB_SLUG, MEMBER_LANDING);
}

/**
 * A context with NO session at all. The `request` fixture is NOT anonymous: the
 * `chromium` project sets `storageState: tests/e2e/.auth/owner.json`
 * (playwright.config.ts:100-103), so every `{ request }` in this project carries
 * the seeded owner's cookie. Round 2 proved it — an "anonymous" POST /api/classes
 * answered 201. Anonymous cells must use this.
 */
export async function anonContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL, storageState: undefined });
  await context.clearCookies();
  return context;
}

export async function closeSessions(): Promise<void> {
  for (const c of sessions.values()) await c.close().catch(() => {});
  sessions.clear();
}

// ── Request helpers ──────────────────────────────────────────────────────────

/**
 * `maxRedirects: 0` on every call. An unauthenticated /api/* request is
 * 307-redirected to /login by the middleware, and Playwright otherwise follows
 * it and reports the login page's 200 — a refusal that reads as a success.
 */
export const NO_REDIRECT = { maxRedirects: 0 } as const;

export function post(rc: APIRequestContext, url: string, origin: string, data: unknown = {}) {
  return rc.post(url, { headers: { Origin: origin }, data, maxRedirects: 0 });
}
export function patch(rc: APIRequestContext, url: string, origin: string, data: unknown = {}) {
  return rc.patch(url, { headers: { Origin: origin }, data, maxRedirects: 0 });
}
export function del(rc: APIRequestContext, url: string, origin: string) {
  return rc.delete(url, { headers: { Origin: origin }, maxRedirects: 0 });
}
export function get(rc: APIRequestContext, url: string) {
  return rc.get(url, { maxRedirects: 0 });
}

/** `lib/api-authz.ts` refusal copy. Routes gating with a raw auth() call answer a bare { error }. */
export const FORBIDDEN_BODY = "You do not have permission to do this.";
export const CSRF_BODY = "Forbidden: cross-origin request rejected";

// ── Run-stamped timetable fixtures ───────────────────────────────────────────

export async function mkClass(
  tenantId: string,
  name: string,
  over: Partial<{ duration: number; coachUserId: string | null; requiredRankId: string | null; maxRankId: string | null }> = {},
): Promise<string> {
  const rows = await sql<{ id: string }>(
    `INSERT INTO "Class" ("id", "tenantId", "name", "duration", "coachUserId", "requiredRankId", "maxRankId", "isActive", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, true, now())
     RETURNING id`,
    [tenantId, name, over.duration ?? 60, over.coachUserId ?? null, over.requiredRankId ?? null, over.maxRankId ?? null],
  );
  return rows[0].id;
}

/**
 * `ClassInstance.date` is `timestamp(3)` WITHOUT a zone and Prisma round-trips
 * it as a UTC wall clock; node-pg handed a JS Date writes the LOCAL wall clock.
 * The `timestamptz AT TIME ZONE 'UTC'` cast stores exactly what Prisma would —
 * the pattern authorisation.spec.ts:205-213 documents in full.
 *
 * `endTime` is NOT NULL and (classId, date, startTime) is unique.
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

/**
 * An instance whose window is open right now in the club's zone, so the self
 * and kiosk paths (which enforce the window) can reach a 201 rather than a 409.
 * Times are the club's wall clock, which for the seeded London club on a UTC+1
 * host is the host's clock — asserted by the caller, never assumed.
 */
export function nowWindow(): { startTime: string; endTime: string } {
  const now = new Date();
  const hh = (n: number) => String(n).padStart(2, "0");
  const start = new Date(now.getTime() - 5 * 60_000);
  const end = new Date(now.getTime() + 55 * 60_000);
  return {
    startTime: `${hh(start.getHours())}:${hh(start.getMinutes())}`,
    endTime: `${hh(end.getHours())}:${hh(end.getMinutes())}`,
  };
}

export async function mkStaff(
  tenantId: string,
  role: "owner" | "manager" | "coach" | "admin",
  seededPasswordHash?: string,
): Promise<{ id: string; email: string }> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `${SCOPE}-${role}-${suffix}@example.test`;
  const rows = await sql<{ id: string }>(
    `INSERT INTO "User" ("id", "tenantId", "email", "name", "passwordHash", "role", "sessionVersion", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 0, now(), now())
     RETURNING id`,
    [tenantId, email, `Campaign ${role} ${suffix}`, seededPasswordHash ?? bcrypt.hashSync(THROWAWAY_PASSWORD, 10), role],
  );
  return { id: rows[0].id, email };
}

export async function mkTenant(): Promise<{ id: string; slug: string }> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const slug = `${RUN_STAMP}-${suffix}`.toLowerCase();
  const rows = await sql<{ id: string }>(
    `INSERT INTO "Tenant" ("id", "slug", "name", "subscriptionStatus", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, 'trial', now())
     RETURNING id`,
    [slug, `${RUN_STAMP} Ashgrove Academy`],
  );
  return { id: rows[0].id, slug };
}

/**
 * Teardown in the order the brief names: AttendanceRecord → ClassPackRedemption
 * → MemberClassPack → ClassSubscription → ClassRoster → ClassInstance →
 * ClassSchedule → Class. Everything is reached by the run-stamped class name,
 * so nothing seeded is in range.
 */
export async function teardownClasses(tenantId: string, namePrefix: string): Promise<void> {
  const ids = (
    await sql<{ id: string }>('SELECT id FROM "Class" WHERE "tenantId" = $1 AND name LIKE $2', [tenantId, `${namePrefix}%`])
  ).map((r) => r.id);
  if (ids.length === 0) return;
  await sql('DELETE FROM "ClassPackRedemption" WHERE "attendanceRecordId" IN (SELECT a.id FROM "AttendanceRecord" a JOIN "ClassInstance" i ON i.id = a."classInstanceId" WHERE i."classId" = ANY($1))', [ids]);
  await sql('DELETE FROM "AttendanceRecord" WHERE "classInstanceId" IN (SELECT id FROM "ClassInstance" WHERE "classId" = ANY($1))', [ids]);
  await sql('DELETE FROM "ClassWaitlist" WHERE "classInstanceId" IN (SELECT id FROM "ClassInstance" WHERE "classId" = ANY($1))', [ids]);
  await sql('DELETE FROM "ClassSubscription" WHERE "classId" = ANY($1)', [ids]);
  await sql('DELETE FROM "ClassRoster" WHERE "classId" = ANY($1)', [ids]);
  await sql('DELETE FROM "ClassInstance" WHERE "classId" = ANY($1)', [ids]);
  await sql('DELETE FROM "ClassSchedule" WHERE "classId" = ANY($1)', [ids]);
  await sql('DELETE FROM "Class" WHERE id = ANY($1)', [ids]);
}

export async function teardownTenant(tenantId: string): Promise<void> {
  await teardownClasses(tenantId, RUN_STAMP);
  await sql('DELETE FROM "AttendanceRecord" WHERE "tenantId" = $1', [tenantId]).catch(() => {});
  await sql('DELETE FROM "AuditLog" WHERE "tenantId" = $1', [tenantId]).catch(() => {});
  await sql('DELETE FROM "EmailLog" WHERE "tenantId" = $1', [tenantId]).catch(() => {});
  await sql('DELETE FROM "Member" WHERE "tenantId" = $1', [tenantId]);
  await sql('DELETE FROM "User" WHERE "tenantId" = $1', [tenantId]);
  await sql('DELETE FROM "Tenant" WHERE id = $1', [tenantId]);
}

/** Buckets this lane exhausts are reset by name; every lane shares the IP. */
export async function resetBucketsLike(pattern: string): Promise<void> {
  await sql('DELETE FROM "RateLimitHit" WHERE bucket LIKE $1', [pattern]).catch(() => {});
}

export async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
  const rows = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}" WHERE ${where}`, params);
  return Number(rows[0].n);
}

export { seededTenantId, sql, RUN_STAMP };
