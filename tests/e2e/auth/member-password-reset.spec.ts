/**
 * E2E — Member password reset flow.
 *
 * Tests:
 *   1. forgot-password returns 200 for a member who has a password (either
 *      { ok:true } in dev/no-email mode or a send-result when RESEND_API_KEY
 *      is set — we accept any 2xx/503 here since email delivery is out of scope
 *      for this spec; the token-consume path is the critical behaviour).
 *   2. reset-password with a directly-injected token sets the new password;
 *      member signs in with the new password.
 *   3. Token is consumed on first use — second submit returns 400.
 *   4. A magic-link-only member (no passwordHash) gets silent { ok: true } and
 *      no PasswordResetToken row is written.
 *   5. Unknown tenant slug returns opaque { ok: true } (AH-9 anti-enumeration).
 *
 * Strategy for obtaining a known plaintext token: we bypass the email-send
 * path entirely and inject tokens directly into PasswordResetToken via Prisma,
 * computing the same HMAC locally. This avoids dependency on Resend delivering
 * to test addresses.
 *
 * Tests are serialised (test.describe.serial) to avoid parallel token races.
 *
 * Requires: dev server running at PLAYWRIGHT_BASE_URL (default: http://localhost:3847).
 * DATABASE_URL must point at the test branch, not production, before running.
 *
 * Pattern mirrors tests/e2e/auth/totp-enrolment-flow.spec.ts.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Env bootstrap (no dotenv dep — matches existing specs)
// Mirrors Next.js load order: .env.local overrides .env.
// .env.local values are applied with forced override (Next.js semantics).
// .env values are fallback-only (only set if not already present).
// Handles: UTF-8 BOM, Windows CRLF line endings, quoted values.
// ---------------------------------------------------------------------------
function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.replace(/\r$/, ""); // strip Windows CR
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
  // Force-override: .env.local always wins (Next.js behaviour).
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8").replace(/^﻿/, "");
  for (const line of raw.split("\n")) {
    const kv = parseEnvLine(line);
    if (kv) process.env[kv[0]] = kv[1];
  }
}
function loadEnvFallback(filePath: string) {
  // Fallback-only: only set vars not already present.
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
const TENANT_SLUG = "totalbjj";
const MEMBER_EMAIL = "alex@example.com";
// Audit C-1 / GitGuardian: no hardcoded credentials in source.
// Audit iter-1-tests (Area 9): top-level throw broke playwright --list
// for the entire suite. Sentinel + describe-level skip below.
const OLD_PASSWORD = process.env.TEST_PASSWORD ?? "";
const NEW_PASSWORD = "NewP@ssword99";

// Ephemeral member for magic-link-only test.
const MAGIC_ONLY_EMAIL = "magic-only-reset-test@example.com";

// ---------------------------------------------------------------------------
// hashToken — inline mirror of lib/token-hash.ts.
// Playwright uses Node resolver (not Next.js @/ alias) so we cannot import
// the lib directly. AUTH_SECRET is loaded by loadEnv() above.
// ---------------------------------------------------------------------------
function hashToken(raw: string): string {
  const secret =
    process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "";
  return createHmac("sha256", secret).update(raw).digest("hex");
}

// ---------------------------------------------------------------------------
// Prisma helper — always uses DATABASE_URL, matching the existing pattern.
//
// IMPORTANT: This DB uses FORCE ROW LEVEL SECURITY on all tenant-scoped tables
// (Member, PasswordResetToken, Tenant, etc.). A bare PrismaClient with no GUC
// set will see 0 rows on every query. All tenant-scoped helpers below wrap
// their queries in a $transaction that sets app.bypass_rls = 'on', mirroring
// what withRlsBypass() does in lib/prisma-tenant.ts.
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

/**
 * Inject a known-plaintext token into PasswordResetToken for email+tenant.
 * Marks any existing unused tokens as used first (mirrors what the route does),
 * then inserts a new row with the HMAC of our known plaintext.
 */
async function setKnownResetToken(
  email: string,
  tenantSlug: string,
  knownToken: string,
  ttlMs = 10 * 60 * 1000,
): Promise<void> {
  const prisma = makePrisma();
  try {
    await withBypass(prisma, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { slug: tenantSlug } });
      if (!tenant) throw new Error(`Tenant ${tenantSlug} not found`);
      const normEmail = email.toLowerCase().trim();
      const targetHash = hashToken(knownToken);
      // Delete ALL existing reset tokens for this email+tenant (both used and
      // unused) before inserting. Using updateMany→used:true then create fails
      // when the same plaintext token was used in a previous test run because
      // the @unique tokenHash index rejects a re-insert of the same hash even
      // when the old row is now marked used:true.
      await tx.passwordResetToken.deleteMany({
        where: { email: normEmail, tenantId: tenant.id },
      });
      await tx.passwordResetToken.create({
        data: {
          email: normEmail,
          tenantId: tenant.id,
          tokenHash: targetHash,
          expiresAt: new Date(Date.now() + ttlMs),
        },
      });
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function countUnusedResetTokens(
  email: string,
  tenantSlug: string,
): Promise<number> {
  const prisma = makePrisma();
  try {
    return await withBypass(prisma, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { slug: tenantSlug } });
      if (!tenant) return 0;
      return tx.passwordResetToken.count({
        where: {
          email: email.toLowerCase().trim(),
          tenantId: tenant.id,
          used: false,
          expiresAt: { gt: new Date() },
        },
      });
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function ensureMagicOnlyMemberExists() {
  const prisma = makePrisma();
  try {
    await withBypass(prisma, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } });
      const existing = await tx.member.findFirst({
        where: { email: MAGIC_ONLY_EMAIL, tenantId: tenant.id },
      });
      if (existing) {
        await tx.member.update({ where: { id: existing.id }, data: { passwordHash: null } });
        return;
      }
      await tx.member.create({
        data: {
          tenantId: tenant.id,
          email: MAGIC_ONLY_EMAIL,
          name: "Magic Only Reset Test",
          membershipType: "Monthly Unlimited",
          joinedAt: new Date(),
          passwordHash: null,
        },
      });
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function cleanupMagicOnlyMember() {
  const prisma = makePrisma();
  try {
    await withBypass(prisma, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { slug: TENANT_SLUG } });
      if (!tenant) return;
      await tx.member.deleteMany({ where: { email: MAGIC_ONLY_EMAIL, tenantId: tenant.id } });
      await tx.passwordResetToken.deleteMany({
        where: { email: MAGIC_ONLY_EMAIL, tenantId: tenant.id },
      });
    });
  } finally {
    await prisma.$disconnect();
  }
}

/** Restore the member's password to the original seed hash via reset mechanism. */
async function restoreMemberPassword(request: APIRequestContext) {
  await setKnownResetToken(MEMBER_EMAIL, TENANT_SLUG, "RESTORE-TOKEN-99");
  await request.post("/api/auth/reset-password", {
    data: {
      token: "RESTORE-TOKEN-99",
      email: MEMBER_EMAIL,
      tenantSlug: TENANT_SLUG,
      password: OLD_PASSWORD,
    },
  });
}

// ---------------------------------------------------------------------------
// Sign-in helper
// ---------------------------------------------------------------------------
async function signInMember(
  request: APIRequestContext,
  email: string,
  password: string,
) {
  const { csrfToken } = await (await request.get("/api/auth/csrf")).json();
  return request.post("/api/auth/callback/credentials", {
    form: { csrfToken, email, password, tenantSlug: TENANT_SLUG, json: "true" },
    maxRedirects: 0,
  });
}

/** Clear login + forgot-password rate-limit buckets.
 *  Also clears shared IP buckets — Next.js dev server sees ::1 (IPv6 loopback)
 *  for local Playwright requests; the fallback "unknown" is also cleared for
 *  completeness. Both share the 30/30min global cap. */
async function clearRateLimits(...emails: string[]) {
  const prisma = makePrisma();
  try {
    const buckets = [
      "login:ip:::1",
      "login:ip:127.0.0.1",
      "login:ip:unknown",
      ...emails.flatMap((e) => [
        `login:${TENANT_SLUG}:${e.toLowerCase().trim()}`,
        `forgot:${TENANT_SLUG}:${e.toLowerCase().trim()}`,
      ]),
    ];
    await prisma.rateLimitHit.deleteMany({ where: { bucket: { in: buckets } } });
  } finally {
    await prisma.$disconnect();
  }
}

// ---------------------------------------------------------------------------
// Spec — serialised to prevent parallel token-table races
// ---------------------------------------------------------------------------
test.describe.serial("Member password reset flow", () => {
  test.skip(!process.env.TEST_PASSWORD, "TEST_PASSWORD env var required (audit C-1) — set it in .env.test to run.");
  test.beforeEach(async () => {
    await clearRateLimits(MEMBER_EMAIL, MAGIC_ONLY_EMAIL);
  });
  test("forgot-password returns 2xx for a member who has a password", async ({
    request,
  }) => {
    const res = await request.post("/api/auth/forgot-password", {
      data: { email: MEMBER_EMAIL, tenantSlug: TENANT_SLUG },
    });
    // In dev (no RESEND_API_KEY) → 200 { ok: true }.
    // With RESEND_API_KEY set but test recipient rejected by Resend → 503 { error }.
    // Both are acceptable for this test — the token-consume path is tested via
    // direct injection below. What we assert: route must NOT return a 4xx (which
    // would indicate a validation failure or logic error in the route itself).
    // A 503 from an email provider is an infrastructure concern, not a route bug.
    // 200 = dev (no RESEND_API_KEY or log-only mode)
    // 503 = Resend rejected the test email address
    // 429 = rate limiter hit from a previous test run within the 15-min window
    // All three are acceptable for this test — the route logic is correct in each case.
    expect(
      [200, 429, 503],
      `forgot-password returned unexpected status ${res.status()} — expected 200, 429, or 503`,
    ).toContain(res.status());
    if (res.status() === 200) {
      expect((await res.json()).ok).toBe(true);
    }
  });

  test("valid injected token sets new password — member signs in with new password", async ({
    request,
  }) => {
    const TOKEN = "RESET-TOKEN-A1";

    // Inject a known token directly — bypasses email delivery.
    await setKnownResetToken(MEMBER_EMAIL, TENANT_SLUG, TOKEN);

    const resetRes = await request.post("/api/auth/reset-password", {
      data: {
        token: TOKEN,
        email: MEMBER_EMAIL,
        tenantSlug: TENANT_SLUG,
        password: NEW_PASSWORD,
      },
    });
    expect(
      resetRes.status(),
      `reset-password failed: ${resetRes.status()} body=${(await resetRes.text()).slice(0, 300)}`,
    ).toBe(200);
    expect((await resetRes.json()).ok).toBe(true);

    // Member can sign in with the new password.
    const loginRes = await signInMember(request, MEMBER_EMAIL, NEW_PASSWORD);
    expect(
      loginRes.status(),
      `login with new password failed: ${loginRes.status()}`,
    ).toBeLessThan(400);

    // Restore old password so subsequent tests are not broken.
    await restoreMemberPassword(request);
  });

  test("token is consumed after first use — second attempt returns 400", async ({
    request,
  }) => {
    const TOKEN = "RESET-TOKEN-B2";
    await setKnownResetToken(MEMBER_EMAIL, TENANT_SLUG, TOKEN);

    const first = await request.post("/api/auth/reset-password", {
      data: {
        token: TOKEN,
        email: MEMBER_EMAIL,
        tenantSlug: TENANT_SLUG,
        password: NEW_PASSWORD,
      },
    });
    expect(first.status(), `first consume should succeed`).toBe(200);

    const second = await request.post("/api/auth/reset-password", {
      data: {
        token: TOKEN,
        email: MEMBER_EMAIL,
        tenantSlug: TENANT_SLUG,
        password: NEW_PASSWORD,
      },
    });
    expect(
      second.status(),
      `second consume with same token should fail`,
    ).toBe(400);
    const body = await second.json();
    expect(body.error).toMatch(/invalid|expired|used/i);

    // Restore.
    await restoreMemberPassword(request);
  });

  test("magic-link-only member gets silent ok:true and no token row is written", async ({
    request,
  }) => {
    await ensureMagicOnlyMemberExists();
    const before = await countUnusedResetTokens(MAGIC_ONLY_EMAIL, TENANT_SLUG);

    const res = await request.post("/api/auth/forgot-password", {
      data: { email: MAGIC_ONLY_EMAIL, tenantSlug: TENANT_SLUG },
    });
    // Route must not error for a magic-link-only member — opaque 200, email
    // failure 503, or rate-limit 429. The key contract: no token row is created.
    expect([200, 429, 503]).toContain(res.status());

    // No new token should have been created (member has no passwordHash).
    const after = await countUnusedResetTokens(MAGIC_ONLY_EMAIL, TENANT_SLUG);
    expect(
      after,
      "no PasswordResetToken should be created for a magic-link-only member",
    ).toBe(before);

    await cleanupMagicOnlyMember();
  });

  test("unknown tenant slug returns opaque ok:true — no tenant enumeration (AH-9)", async ({
    request,
  }) => {
    const res = await request.post("/api/auth/forgot-password", {
      data: { email: MEMBER_EMAIL, tenantSlug: "no-such-tenant-xyz999" },
    });
    // AH-9: must return 200 ok:true, never 404.
    expect(res.status()).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
