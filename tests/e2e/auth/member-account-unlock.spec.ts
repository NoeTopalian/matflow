/**
 * E2E — Member account unlock flow.
 *
 * Tests:
 *   1. 10 failed login attempts lock the member account.
 *   2. Staff (owner) POSTs to /api/members/[id]/unlock → member can sign in again.
 *   3. Cross-tenant unlock is blocked: staff in tenant A cannot unlock a member
 *      whose ID belongs to tenant B.
 *
 * Requires: dev server running at PLAYWRIGHT_BASE_URL (default: http://localhost:3847).
 * DATABASE_URL must point at the test branch, not production, before running.
 *
 * Pattern mirrors tests/e2e/auth/totp-enrolment-flow.spec.ts.
 * The unlock route requires assertSameOrigin — pass Origin header on POST.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Env bootstrap
// ---------------------------------------------------------------------------
// Mirrors Next.js load order: .env.local overrides .env.
// .env.local values are applied with forced override (Next.js semantics).
// .env values are fallback-only (only set if not already present).
// Handles: UTF-8 BOM, Windows CRLF line endings, quoted values.
function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.replace(/\r$/, "");
  const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (!m) return null;
  let v = m[2].trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  return [m[1], v];
}
function loadEnvOverride(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8").replace(/^﻿/, "");
  for (const line of raw.split("\n")) {
    const kv = parseEnvLine(line);
    if (kv) process.env[kv[0]] = kv[1];
  }
}
function loadEnvFallback(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8").replace(/^﻿/, "");
  for (const line of raw.split("\n")) {
    const kv = parseEnvLine(line);
    if (kv && !process.env[kv[0]]) process.env[kv[0]] = kv[1];
  }
}
loadEnvOverride(path.resolve(".env.local"));
loadEnvFallback(path.resolve(".env"));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3847";
const TENANT_SLUG = "totalbjj";
const OWNER_EMAIL = "owner@totalbjj.com";
const MEMBER_EMAIL = "sam@example.com"; // different member from password-reset spec
// Audit C-1 / GitGuardian: no hardcoded credentials in source. Both seed
// accounts in the test branch use the same password sourced from TEST_PASSWORD.
// Audit iter-1-tests (Area 9): convert hard top-level throw to a
// describe-level skip. The throw broke `npx playwright test --list`
// for the entire suite because env was unset in dev. Tests that
// require the real credential skip cleanly; collection still works.
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? "";
const OWNER_PASSWORD = TEST_PASSWORD;
const MEMBER_PASSWORD = TEST_PASSWORD;

// Cross-tenant test: we create a second tenant + member to verify isolation.
const TENANT_B_SLUG = "unlock-test-tenant-b";

// ---------------------------------------------------------------------------
// Prisma helper
//
// IMPORTANT: This DB uses FORCE ROW LEVEL SECURITY on all tenant-scoped tables
// (Member, Tenant, etc.). A bare PrismaClient with no GUC set sees 0 rows on
// every query against those tables. All tenant-scoped helpers below wrap their
// queries in a $transaction that sets app.bypass_rls = 'on', mirroring what
// withRlsBypass() does in lib/prisma-tenant.ts.
// RateLimitHit has no RLS (global table) — direct queries are fine there.
// ---------------------------------------------------------------------------
function makePrisma() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

/** Run fn inside a bypass-RLS transaction so tenant-scoped tables are visible. */
async function withBypass<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return fn(tx);
  });
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
async function getMemberId(email: string, tenantSlug: string): Promise<string> {
  const prisma = makePrisma();
  try {
    return await withBypass(prisma, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { slug: tenantSlug },
      });
      const member = await tx.member.findFirstOrThrow({
        where: { email, tenantId: tenant.id },
        select: { id: true },
      });
      return member.id;
    });
  } finally {
    await prisma.$disconnect();
  }
}

/** Clear login rate-limit DB buckets so repeated test runs don't hit the 5/15min cap.
 *  Also clears shared IP buckets — Next.js dev server sees ::1 (IPv6 loopback)
 *  for local Playwright requests; "unknown" is the fallback. Both are cleared. */
async function clearLoginRateLimit(email: string, tenantSlug: string) {
  const prisma = makePrisma();
  try {
    const buckets = [
      "login:ip:::1",
      "login:ip:127.0.0.1",
      "login:ip:unknown",
      `login:${tenantSlug}:${email.toLowerCase().trim()}`,
    ];
    await prisma.rateLimitHit.deleteMany({ where: { bucket: { in: buckets } } });
  } finally {
    await prisma.$disconnect();
  }
}

async function resetMemberLockState(email: string, tenantSlug: string) {
  const prisma = makePrisma();
  try {
    await withBypass(prisma, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { slug: tenantSlug },
      });
      await tx.member.updateMany({
        where: { email, tenantId: tenant.id },
        data: { failedLoginCount: 0, lockedUntil: null },
      });
    });
  } finally {
    await prisma.$disconnect();
  }
}

/** Force-lock a member by setting failedLoginCount + lockedUntil directly. */
async function forceLockMember(email: string, tenantSlug: string) {
  const prisma = makePrisma();
  try {
    await withBypass(prisma, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { slug: tenantSlug },
      });
      await tx.member.updateMany({
        where: { email, tenantId: tenant.id },
        data: {
          failedLoginCount: 0, // auth.ts resets count on lock
          lockedUntil: new Date(Date.now() + 60 * 60 * 1000), // 1h from now
        },
      });
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function isMemberLocked(
  email: string,
  tenantSlug: string,
): Promise<boolean> {
  const prisma = makePrisma();
  try {
    return await withBypass(prisma, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { slug: tenantSlug },
      });
      const member = await tx.member.findFirst({
        where: { email, tenantId: tenant.id },
        select: { lockedUntil: true },
      });
      return !!(member?.lockedUntil && member.lockedUntil > new Date());
    });
  } finally {
    await prisma.$disconnect();
  }
}

/** Provision a second tenant + one member for cross-tenant isolation tests. */
async function ensureTenantBWithMember(): Promise<{
  tenantId: string;
  memberId: string;
}> {
  const prisma = makePrisma();
  try {
    return await withBypass(prisma, async (tx) => {
      const tenantB = await tx.tenant.upsert({
        where: { slug: TENANT_B_SLUG },
        update: {},
        create: {
          name: "Unlock Test Tenant B",
          slug: TENANT_B_SLUG,
          primaryColor: "#000000",
          secondaryColor: "#111111",
          textColor: "#ffffff",
          subscriptionStatus: "active",
          subscriptionTier: "pro",
        },
      });
      const member = await tx.member.upsert({
        where: {
          tenantId_email: {
            tenantId: tenantB.id,
            email: "cross-tenant-member@example.com",
          },
        },
        update: {},
        create: {
          tenantId: tenantB.id,
          email: "cross-tenant-member@example.com",
          name: "Cross Tenant Member",
          membershipType: "Monthly Unlimited",
          joinedAt: new Date(),
          passwordHash: null,
        },
      });
      return { tenantId: tenantB.id, memberId: member.id };
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function cleanupTenantB() {
  const prisma = makePrisma();
  try {
    await withBypass(prisma, async (tx) => {
      const tenantB = await tx.tenant.findUnique({
        where: { slug: TENANT_B_SLUG },
      });
      if (!tenantB) return;
      await tx.member.deleteMany({ where: { tenantId: tenantB.id } });
      await tx.tenant.delete({ where: { id: tenantB.id } });
    });
  } finally {
    await prisma.$disconnect();
  }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
async function signInAs(
  request: APIRequestContext,
  email: string,
  password: string,
  tenantSlug: string,
) {
  const { csrfToken } = await (await request.get("/api/auth/csrf")).json();
  const res = await request.post("/api/auth/callback/credentials", {
    form: {
      csrfToken,
      email,
      password,
      tenantSlug,
      json: "true",
    },
    maxRedirects: 0,
  });
  return res;
}

/** Attempt login n times with a wrong password — drives up failedLoginCount. */
async function triggerNFailedLogins(
  request: APIRequestContext,
  n: number,
  email: string,
  tenantSlug: string,
) {
  for (let i = 0; i < n; i++) {
    await signInAs(request, email, "definitely-wrong-password-xyz", tenantSlug);
  }
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------
// Serial: beforeEach resets lock state; parallel execution lets one test's
// resetMemberLockState undo another test's forceLockMember mid-flight.
test.describe.serial("Member account unlock", () => {
  // Audit iter-1-tests (Area 9): skip whole suite if TEST_PASSWORD missing.
  test.skip(!TEST_PASSWORD, "TEST_PASSWORD env var required (audit C-1) — set it in .env.test to run.");
  test.beforeEach(async () => {
    await clearLoginRateLimit(MEMBER_EMAIL, TENANT_SLUG);
    await clearLoginRateLimit(OWNER_EMAIL, TENANT_SLUG);
    await resetMemberLockState(MEMBER_EMAIL, TENANT_SLUG);
  });

  test("reaching ACCOUNT_LOCKOUT_THRESHOLD failed logins locks the member account", async ({
    request,
  }) => {
    expect(await isMemberLocked(MEMBER_EMAIL, TENANT_SLUG)).toBe(false);

    // auth.ts LOGIN_RATE_MAX = 5 per 15 min blocks attempts via the API rate
    // limiter before the account-lockout counter (threshold 10) is reached via
    // purely API-driven calls. Set failedLoginCount to 9 directly in the DB
    // so one more failed API attempt trips the lockout threshold.
    const prisma = makePrisma();
    try {
      await withBypass(prisma, async (tx) => {
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { slug: TENANT_SLUG },
        });
        await tx.member.updateMany({
          where: { email: MEMBER_EMAIL, tenantId: tenant.id },
          data: { failedLoginCount: 9 },
        });
      });
    } finally {
      await prisma.$disconnect();
    }

    // One more wrong-password attempt increments to 10 → shouldLock = true.
    await triggerNFailedLogins(request, 1, MEMBER_EMAIL, TENANT_SLUG);

    expect(
      await isMemberLocked(MEMBER_EMAIL, TENANT_SLUG),
      "member should be locked after failedLoginCount reaches threshold",
    ).toBe(true);
  });

  test("staff (owner) can unlock a locked member via POST /api/members/[id]/unlock", async ({
    request,
  }) => {
    // Force-lock the member directly so this test doesn't depend on 10 API calls.
    await forceLockMember(MEMBER_EMAIL, TENANT_SLUG);
    expect(await isMemberLocked(MEMBER_EMAIL, TENANT_SLUG)).toBe(true);

    // Sign in as owner.
    const ownerLogin = await signInAs(
      request,
      OWNER_EMAIL,
      OWNER_PASSWORD,
      TENANT_SLUG,
    );
    expect(
      ownerLogin.status(),
      `owner login failed: ${ownerLogin.status()}`,
    ).toBeLessThan(400);

    const memberId = await getMemberId(MEMBER_EMAIL, TENANT_SLUG);

    // Unlock via staff route — must send Origin header (assertSameOrigin guard).
    const unlockRes = await request.post(`/api/members/${memberId}/unlock`, {
      headers: { Origin: BASE },
    });
    expect(
      unlockRes.status(),
      `unlock failed: ${unlockRes.status()} body=${(await unlockRes.text()).slice(0, 300)}`,
    ).toBe(200);
    const body = await unlockRes.json();
    expect(body.ok).toBe(true);
    expect(body.wasLocked).toBe(true);

    // Verify lock is cleared in DB.
    expect(
      await isMemberLocked(MEMBER_EMAIL, TENANT_SLUG),
      "member should be unlocked after staff action",
    ).toBe(false);

    // Member can now sign in with their password.
    const memberLogin = await signInAs(
      request,
      MEMBER_EMAIL,
      MEMBER_PASSWORD,
      TENANT_SLUG,
    );
    expect(
      memberLogin.status(),
      `member login after unlock failed: ${memberLogin.status()}`,
    ).toBeLessThan(400);
  });

  test("unlock without auth returns 401", async () => {
    // Use native fetch with no Cookie header to guarantee no session.
    // playwright.request.newContext() may still share storage in some
    // Playwright versions; fetch() with credentials:'omit' is unambiguous.
    const memberId = await getMemberId(MEMBER_EMAIL, TENANT_SLUG);
    const res = await fetch(`${BASE}/api/members/${memberId}/unlock`, {
      method: "POST",
      headers: { Origin: BASE },
      credentials: "omit",
    });
    expect(res.status).toBe(401);
  });

  test("cross-tenant unlock is blocked — staff in tenant A cannot unlock member in tenant B", async ({
    request,
  }) => {
    const { memberId: tenantBMemberId } = await ensureTenantBWithMember();

    // Sign in as owner of tenant A (totalbjj).
    const ownerLogin = await signInAs(
      request,
      OWNER_EMAIL,
      OWNER_PASSWORD,
      TENANT_SLUG,
    );
    expect(ownerLogin.status()).toBeLessThan(400);

    // Attempt to unlock a member from tenant B using tenant A's session.
    const unlockRes = await request.post(
      `/api/members/${tenantBMemberId}/unlock`,
      { headers: { Origin: BASE } },
    );
    // The route filters by session tenantId — tenant B member not found in tenant A.
    expect(
      unlockRes.status(),
      `cross-tenant unlock should fail but got: ${unlockRes.status()}`,
    ).toBe(404);
    const body = await unlockRes.json();
    expect(body.error).toMatch(/not found/i);

    await cleanupTenantB();
  });

  test("unlocking an already-unlocked member returns ok:true with wasLocked:false", async ({
    request,
  }) => {
    // Member is already in clean state (no lock).
    const ownerLogin = await signInAs(
      request,
      OWNER_EMAIL,
      OWNER_PASSWORD,
      TENANT_SLUG,
    );
    expect(ownerLogin.status()).toBeLessThan(400);

    const memberId = await getMemberId(MEMBER_EMAIL, TENANT_SLUG);
    const unlockRes = await request.post(`/api/members/${memberId}/unlock`, {
      headers: { Origin: BASE },
    });
    expect(unlockRes.status()).toBe(200);
    const body = await unlockRes.json();
    expect(body.ok).toBe(true);
    expect(body.wasLocked).toBe(false);
    expect(body.message).toMatch(/not locked/i);
  });
});
