/**
 * E2E — 2FA-optional spec (2026-05-07): MEMBER self-enrolment.
 *
 * An adult member with a password enrols TOTP via the member-side route, and
 * the enrolment sticks (totpEnabled=true). After enrolment, a fresh password
 * login surfaces the second-factor challenge (totpPending) — but ONLY when the
 * server is NOT in TESTING_MODE, since auth.ts gates totpPending behind
 * `!isTestingMode()` (auth.ts:347). The challenge assertion is therefore guarded.
 *
 * API-driven, mirroring tests/e2e/auth/totp-enrolment-flow.spec.ts. Requires a
 * running dev server + seeded Total BJJ tenant (member taylor@example.com).
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { generateSync } from "otplib";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import fs from "node:fs";
import path from "node:path";

function loadEnv() {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}
loadEnv();

const TENANT_SLUG = "totalbjj";
// Own seeded member, not shared with any other spec. member-password-reset.spec
// drives alex@example.com through /api/auth/reset-password (which bumps
// sessionVersion), and member-account-unlock.spec owns sam@example.com. Files
// run in parallel even when each is internally serialised, so a shared row is a
// cross-file race waiting for TEST_PASSWORD to be set.
const MEMBER_EMAIL = "taylor@example.com";
// E2E bypass token (TESTING_MODE + localhost) so login succeeds regardless of
// the seeded member's real password hash on the test branch.
const MEMBER_PASSWORD = process.env.E2E_BYPASS_TOKEN ?? process.env.TEST_PASSWORD ?? "password123";

async function ensureMemberHasPasswordAndNoTotp() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    const member = await prisma.member.findFirst({ where: { email: MEMBER_EMAIL }, select: { id: true, passwordHash: true } });
    // Seed member must have a password to be eligible for TOTP.
    expect(member?.passwordHash, `${MEMBER_EMAIL} must have a password to enrol TOTP`).toBeTruthy();
    await prisma.member.updateMany({
      where: { email: MEMBER_EMAIL },
      data: { totpEnabled: false, totpSecret: null, totpRecoveryCodes: undefined, sessionVersion: { increment: 1 } },
    });
    // POST /api/member/totp/setup allows 5 verifies per 10 min per member
    // (route VERIFY_LIMIT_MAX/WINDOW), counted in the RateLimitHit table — which
    // is shared, persistent, and NOT reset between runs. One enrolment per run
    // is well inside that, but back-to-back full runs plus any local re-runs
    // accumulate, and the 6th verify in the window returns 429 with no bearing
    // on the behaviour under test. Every sibling auth spec that touches a
    // rate-limited endpoint clears its own bucket first (member-password-reset,
    // member-account-unlock); this spec was the omission.
    // RateLimitHit is a global table with no RLS, so a direct delete is fine.
    if (member?.id) {
      await prisma.rateLimitHit.deleteMany({
        where: { bucket: { in: [`totp-setup-verify-member:${member.id}`, `login:ip:::1`, `login:ip:127.0.0.1`, `login:ip:unknown`, `login:${TENANT_SLUG}:${MEMBER_EMAIL}`] } },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function readMemberTotpEnabled(): Promise<boolean> {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });
  try {
    const m = await prisma.member.findFirst({ where: { email: MEMBER_EMAIL }, select: { totpEnabled: true } });
    return m?.totpEnabled === true;
  } finally {
    await prisma.$disconnect();
  }
}

// A TOTP code is only valid for its own 30-second step, and between minting one
// here and the server validating it there is an HTTP round trip handled by a
// loaded `next dev` against a remote Neon branch. A code minted near the end of
// a step can expire in flight, which the route reports as an invalid code
// (HTTP 400) with nothing wrong in the app. Start every code at a fresh step.
async function awaitFreshTotpStep() {
  const STEP_MS = 30_000;
  const remaining = STEP_MS - (Date.now() % STEP_MS);
  if (remaining < 15_000) await new Promise((r) => setTimeout(r, remaining + 250));
}

async function signInMember(request: APIRequestContext) {
  const { csrfToken } = await (await request.get("/api/auth/csrf")).json();
  const res = await request.post("/api/auth/callback/credentials", {
    form: { csrfToken, email: MEMBER_EMAIL, password: MEMBER_PASSWORD, tenantSlug: TENANT_SLUG, json: "true" },
    maxRedirects: 0,
  });
  expect(res.status(), `member login failed: ${res.status()}`).toBeLessThan(400);
}

// Storage-audit hardening (2026-08-16): this spec mutates auth state (TOTP /
// lockout / tokens) through a direct Prisma client on the ambient DATABASE_URL.
// Refuse to run against the prod Neon branch — same guard as ui-audit-staff.
test.beforeAll(() => {
  if ((process.env.DATABASE_URL ?? "").includes("ep-bold-wave")) {
    throw new Error(
      "Refusing to run: DATABASE_URL points at the PROD Neon branch (ep-bold-wave). Use the .env.test branch.",
    );
  }
});

// Serial, like every sibling spec that mutates a shared auth row
// (member-account-unlock, member-password-reset, member-totp-recovery).
// playwright.config sets `fullyParallel: true`, so at --workers>=2 the two
// tests below are dispatched to DIFFERENT workers — and `test.skip()` inside a
// test BODY still runs that test's beforeEach first. The second test's
// beforeEach therefore wrote `totpEnabled: false` while the first test was
// mid-enrolment, between its verified 200 and its read-back, so the read-back
// saw false and the assertion at "enrolment persists" failed. Reproducible with
// `--workers=2 --repeat-each=3`; always green at --workers=1.
// The fresh-step wait above can add up to ~15s before a code is minted, on
// top of a sign-in and two API round trips against a loaded `next dev` and a
// remote Neon branch. Playwright's 30s default leaves no room for that.
test.describe.configure({ timeout: 90_000 });

test.describe.serial("2FA-optional — member self-enrolment", () => {
  test.beforeEach(async () => {
    await ensureMemberHasPasswordAndNoTotp();
  });

  test("adult member with a password enrols TOTP and it persists", async ({ request }) => {
    await signInMember(request);

    const setup = await request.get("/api/member/totp/setup");
    expect(setup.ok(), `member setup GET failed: ${setup.status()}`).toBe(true);
    const { secret, alreadyEnabled } = (await setup.json()) as { secret: string; alreadyEnabled: boolean };
    expect(alreadyEnabled).toBe(false);
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);

    await awaitFreshTotpStep();
    const verify = await request.post("/api/member/totp/setup", {
      data: { code: generateSync({ secret }) },
      headers: { Origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3847" },
    });
    expect(verify.status(), `member verify failed: ${verify.status()}`).toBe(200);

    expect(await readMemberTotpEnabled()).toBe(true);

    // Self-disable is impossible — the disable route 403s for everyone with the
    // no-self-disable message (assert the body so this isn't an incidental 403).
    const disable = await request.post("/api/auth/totp/disable");
    expect(disable.status()).toBe(403);
    expect((await disable.json()).error).toMatch(/cannot be self-disabled/i);
    expect(await readMemberTotpEnabled()).toBe(true);
  });

  test("subsequent password login challenges for the second factor (skipped under TESTING_MODE)", async ({ request }) => {
    test.skip(process.env.TESTING_MODE === "true", "totpPending is forced false under TESTING_MODE (auth.ts:347)");

    // Enrol first.
    await signInMember(request);
    const { secret } = (await (await request.get("/api/member/totp/setup")).json()) as { secret: string };
    await awaitFreshTotpStep();
    await request.post("/api/member/totp/setup", { data: { code: generateSync({ secret }) } });

    // Fresh login → a new credentials callback re-computes totpPending on the
    // issued token. Re-signing in on the same context overwrites the cookie.
    await signInMember(request);
    const session = await (await request.get("/api/auth/session")).json();
    expect(session?.user?.totpPending).toBe(true);
  });
});
