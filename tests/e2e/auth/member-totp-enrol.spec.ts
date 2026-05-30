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
 * running dev server + seeded Total BJJ tenant (member alex@example.com).
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
const MEMBER_EMAIL = "alex@example.com";
const MEMBER_PASSWORD = "password123";

async function ensureMemberHasPasswordAndNoTotp() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    const member = await prisma.member.findFirst({ where: { email: MEMBER_EMAIL }, select: { passwordHash: true } });
    // Seed member must have a password to be eligible for TOTP.
    expect(member?.passwordHash, `${MEMBER_EMAIL} must have a password to enrol TOTP`).toBeTruthy();
    await prisma.member.updateMany({
      where: { email: MEMBER_EMAIL },
      data: { totpEnabled: false, totpSecret: null, totpRecoveryCodes: undefined, sessionVersion: { increment: 1 } },
    });
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

async function signInMember(request: APIRequestContext) {
  const { csrfToken } = await (await request.get("/api/auth/csrf")).json();
  const res = await request.post("/api/auth/callback/credentials", {
    form: { csrfToken, email: MEMBER_EMAIL, password: MEMBER_PASSWORD, tenantSlug: TENANT_SLUG, json: "true" },
    maxRedirects: 0,
  });
  expect(res.status(), `member login failed: ${res.status()}`).toBeLessThan(400);
}

test.describe("2FA-optional — member self-enrolment", () => {
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

    const verify = await request.post("/api/member/totp/setup", { data: { code: generateSync({ secret }) } });
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
    await request.post("/api/member/totp/setup", { data: { code: generateSync({ secret }) } });

    // Fresh login → a new credentials callback re-computes totpPending on the
    // issued token. Re-signing in on the same context overwrites the cookie.
    await signInMember(request);
    const session = await (await request.get("/api/auth/session")).json();
    expect(session?.user?.totpPending).toBe(true);
  });
});
