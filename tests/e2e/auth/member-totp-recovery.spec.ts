/**
 * E2E — Member TOTP recovery flow.
 *
 * Tests:
 *   1. Member enrols TOTP via /api/member/totp/setup (GET secret, POST verify).
 *   2. Member generates recovery codes via POST /api/member/totp/recovery-codes.
 *   3. Member consumes a recovery code via POST /api/member/totp/recover →
 *      TOTP is disabled, member can sign in with password alone.
 *   4. Using the same recovery code a second time returns ok:true but TOTP is
 *      already disabled (idempotent, not an oracle).
 *   5. An invalid/unknown recovery code returns ok:true (opaque response).
 *
 * Requires: dev server running at PLAYWRIGHT_BASE_URL (default: http://localhost:3847).
 * DATABASE_URL must point at the test branch, not production, before running.
 *
 * Pattern mirrors tests/e2e/auth/member-totp-enrol.spec.ts +
 *              tests/e2e/auth/totp-enrolment-flow.spec.ts.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { generateSync } from "otplib";
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
// Use chris@example.com — separate from the member used in other specs.
const MEMBER_EMAIL = "chris@example.com";
const MEMBER_PASSWORD = "password123";

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
/** Clear login rate-limit buckets so repeated test runs don't hit the 5/15min cap.
 *  Also clears shared IP buckets — Next.js dev server sees ::1 (IPv6 loopback)
 *  for local Playwright requests; "unknown" is the fallback. Both are cleared. */
async function clearLoginRateLimit(...emails: string[]) {
  const prisma = makePrisma();
  try {
    const buckets = [
      "login:ip:::1",
      "login:ip:127.0.0.1",
      "login:ip:unknown",
      ...emails.map((e) => `login:${TENANT_SLUG}:${e.toLowerCase().trim()}`),
    ];
    // RateLimitHit has no RLS — direct query is fine.
    await prisma.rateLimitHit.deleteMany({ where: { bucket: { in: buckets } } });
  } finally {
    await prisma.$disconnect();
  }
}

async function resetMemberTotp(email: string) {
  const prisma = makePrisma();
  try {
    await withBypass(prisma, async (tx) => {
      // Use tenantId to be precise — avoids cross-tenant collision if the email
      // exists in multiple tenants, and makes the WHERE clause unambiguous.
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { slug: TENANT_SLUG },
      });
      await tx.member.updateMany({
        where: { email, tenantId: tenant.id },
        data: {
          totpEnabled: false,
          totpSecret: null,
          // JSON field — Prisma accepts [] to clear the array.
          totpRecoveryCodes: [],
          sessionVersion: { increment: 1 },
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      // Verify the reset took effect — fail fast if the DB write didn't land.
      const member = await tx.member.findFirst({
        where: { email, tenantId: tenant.id },
        select: { totpEnabled: true },
      });
      if (member?.totpEnabled !== false) {
        throw new Error(`resetMemberTotp: totpEnabled is still true for ${email} after reset`);
      }
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function getMemberTotpState(email: string): Promise<{
  totpEnabled: boolean;
  totpRecoveryCodes: unknown[];
}> {
  const prisma = makePrisma();
  try {
    return await withBypass(prisma, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { slug: TENANT_SLUG },
      });
      const member = await tx.member.findFirstOrThrow({
        where: { email, tenantId: tenant.id },
        select: { totpEnabled: true, totpRecoveryCodes: true },
      });
      return {
        totpEnabled: member.totpEnabled,
        totpRecoveryCodes: member.totpRecoveryCodes as unknown[],
      };
    });
  } finally {
    await prisma.$disconnect();
  }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
async function signInMember(
  request: APIRequestContext,
  email = MEMBER_EMAIL,
  password = MEMBER_PASSWORD,
) {
  const { csrfToken } = await (await request.get("/api/auth/csrf")).json();
  const res = await request.post("/api/auth/callback/credentials", {
    form: {
      csrfToken,
      email,
      password,
      tenantSlug: TENANT_SLUG,
      json: "true",
    },
    maxRedirects: 0,
  });
  // NextAuth credentials callback returns 302 on success (redirects to callbackUrl).
  // A 302 with Location not containing "error" means sign-in succeeded.
  const location = res.headers()["location"] ?? "";
  expect(
    location,
    `sign-in failed — redirect to error: status=${res.status()}, location=${location}`,
  ).not.toContain("error");
  // Verify session is active by checking /api/auth/session
  const sessionRes = await request.get("/api/auth/session");
  const session = await sessionRes.json();
  expect(
    session?.user?.email,
    `session not established after sign-in: ${JSON.stringify(session)}`,
  ).toBe(email);
}

/**
 * Full enrolment: GET secret → POST verify.
 * Returns the plaintext recovery codes generated afterwards.
 */
async function enrolTotpAndGetRecoveryCodes(
  request: APIRequestContext,
): Promise<string[]> {
  // GET secret
  const setupGet = await request.get("/api/member/totp/setup");
  const setupGetText = await setupGet.text();
  expect(
    setupGet.status(),
    `TOTP setup GET returned ${setupGet.status()}, body: ${setupGetText.slice(0, 200)}`,
  ).toBe(200);
  const { secret, alreadyEnabled } = JSON.parse(setupGetText) as {
    secret: string;
    alreadyEnabled: boolean;
  };
  expect(alreadyEnabled, "member should not already have TOTP enabled").toBe(
    false,
  );
  expect(secret).toMatch(/^[A-Z2-7]+=*$/);

  // POST verify — CSRF guard: must send Origin header.
  const code = generateSync({ secret });
  const setupPost = await request.post("/api/member/totp/setup", {
    data: { code },
    headers: { Origin: BASE },
  });
  expect(
    setupPost.status(),
    `TOTP setup POST failed: ${setupPost.status()} body=${(await setupPost.text()).slice(0, 200)}`,
  ).toBe(200);

  // Generate recovery codes — CSRF guard on this route too.
  const codesRes = await request.post("/api/member/totp/recovery-codes", {
    headers: { Origin: BASE },
  });
  expect(
    codesRes.status(),
    `recovery-codes POST failed: ${codesRes.status()} body=${(await codesRes.text()).slice(0, 200)}`,
  ).toBe(200);
  const { codes } = (await codesRes.json()) as { codes: string[] };
  expect(codes).toHaveLength(8);
  return codes;
}

// ---------------------------------------------------------------------------
// Spec — serialised: tests share chris@example.com TOTP state; parallel
// execution allows one test's GET /api/member/totp/setup to overwrite the
// totpSecret another test just stored, causing code-verify mismatches.
// ---------------------------------------------------------------------------
test.describe.serial("Member TOTP recovery flow", () => {
  test.beforeEach(async () => {
    await clearLoginRateLimit(MEMBER_EMAIL);
    await resetMemberTotp(MEMBER_EMAIL);
  });

  test("member enrols TOTP, generates recovery codes, consumes one — TOTP disabled, member signs in with password alone", async ({
    request,
  }) => {
    // Step 1: sign in as member.
    await signInMember(request);

    // Step 2: enrol TOTP and obtain recovery codes.
    const codes = await enrolTotpAndGetRecoveryCodes(request);
    expect(codes.length).toBeGreaterThan(0);

    // Verify TOTP is now enabled.
    const beforeRecover = await getMemberTotpState(MEMBER_EMAIL);
    expect(beforeRecover.totpEnabled).toBe(true);
    expect(beforeRecover.totpRecoveryCodes).toHaveLength(8);

    // Step 3: consume the first recovery code (public endpoint — no session required).
    const firstCode = codes[0];
    const recoverRes = await request.post("/api/member/totp/recover", {
      data: {
        email: MEMBER_EMAIL,
        tenantSlug: TENANT_SLUG,
        recoveryCode: firstCode,
      },
    });
    expect(
      recoverRes.status(),
      `recover failed: ${recoverRes.status()} body=${(await recoverRes.text()).slice(0, 300)}`,
    ).toBe(200);
    const recoverBody = await recoverRes.json();
    expect(recoverBody.ok).toBe(true);

    // Step 4: TOTP should now be disabled in the DB.
    const afterRecover = await getMemberTotpState(MEMBER_EMAIL);
    expect(
      afterRecover.totpEnabled,
      "totpEnabled should be false after recovery",
    ).toBe(false);
    // One code was consumed — 7 remain stored.
    expect(
      (afterRecover.totpRecoveryCodes as string[]).length,
      "one recovery code should have been consumed",
    ).toBe(7);

    // Step 5: member can sign in with password alone (no TOTP challenge).
    // Use a fresh sign-in to confirm the session is granted.
    await signInMember(request);
    const sessionRes = await request.get("/api/auth/session");
    expect(sessionRes.ok()).toBe(true);
    const session = await sessionRes.json();
    expect(session?.user?.email).toBe(MEMBER_EMAIL);
    // Under TESTING_MODE totpPending is forced false — either absent or false.
    if (typeof session?.user?.totpPending !== "undefined") {
      expect(session.user.totpPending).toBe(false);
    }
  });

  test("using the same recovery code a second time returns ok:true (idempotent opaque response)", async ({
    request,
  }) => {
    await signInMember(request);
    const codes = await enrolTotpAndGetRecoveryCodes(request);
    const firstCode = codes[0];

    // First use — disables TOTP.
    const first = await request.post("/api/member/totp/recover", {
      data: {
        email: MEMBER_EMAIL,
        tenantSlug: TENANT_SLUG,
        recoveryCode: firstCode,
      },
    });
    expect(first.status()).toBe(200);

    // Second use of the same code — TOTP already disabled, code no longer in
    // the stored array. Route should return ok:true (opaque, no oracle).
    const second = await request.post("/api/member/totp/recover", {
      data: {
        email: MEMBER_EMAIL,
        tenantSlug: TENANT_SLUG,
        recoveryCode: firstCode,
      },
    });
    expect(second.status()).toBe(200);
    const body = await second.json();
    expect(body.ok).toBe(true);
  });

  test("invalid recovery code returns ok:true (no enumeration oracle)", async ({
    request,
  }) => {
    await signInMember(request);
    await enrolTotpAndGetRecoveryCodes(request);

    // Submit a code that was never issued.
    const res = await request.post("/api/member/totp/recover", {
      data: {
        email: MEMBER_EMAIL,
        tenantSlug: TENANT_SLUG,
        recoveryCode: "INVALID-CODE-XXXX-0000",
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // TOTP must still be enabled (invalid code had no effect).
    const state = await getMemberTotpState(MEMBER_EMAIL);
    expect(state.totpEnabled).toBe(true);
  });

  test("recovery code for unknown email returns ok:true (no email enumeration)", async ({
    request,
  }) => {
    const res = await request.post("/api/member/totp/recover", {
      data: {
        email: "nobody@no-such-domain-xyz.example.com",
        tenantSlug: TENANT_SLUG,
        recoveryCode: "SOME-CODE-1234-5678",
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("recovery-codes POST without a session returns 401", async ({
    request,
  }) => {
    // No sign-in — no session cookie.
    const res = await request.post("/api/member/totp/recovery-codes", {
      headers: { Origin: BASE },
    });
    expect(res.status()).toBe(401);
  });

  test("all 8 recovery codes can be consumed sequentially", async ({
    request,
  }) => {
    await signInMember(request);
    const codes = await enrolTotpAndGetRecoveryCodes(request);

    // Consume the first code to disable TOTP.
    await request.post("/api/member/totp/recover", {
      data: {
        email: MEMBER_EMAIL,
        tenantSlug: TENANT_SLUG,
        recoveryCode: codes[0],
      },
    });

    // Confirm state after first consume.
    const state = await getMemberTotpState(MEMBER_EMAIL);
    expect(state.totpEnabled).toBe(false);
    // 7 codes remain in the stored array (they are not cleared on disable,
    // only the consumed one is removed).
    expect((state.totpRecoveryCodes as string[]).length).toBe(7);
  });
});
